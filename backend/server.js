require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------------
   TWILIO SETUP (OTP send + verify)
   ---------------------------------------------------------
   If TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN aren't set correctly yet,
   we skip creating the Twilio client instead of crashing the whole
   server. The /api/send-otp and /api/verify-otp routes below will
   just return a clear "not configured" error until you add real
   Twilio credentials — everything else (orders, payments, dashboard)
   keeps working fine in the meantime.
   --------------------------------------------------------- */
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

let twilioClient = null;
if (TWILIO_SID && TWILIO_SID.startsWith('AC') && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
} else {
  console.warn('[Twilio] Not configured (missing/invalid TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN). OTP endpoints will return an error until this is fixed. Rest of the server will run normally.');
}

// POST /api/send-otp   { phone: "9876543210" }
app.post('/api/send-otp', async (req, res) => {
  if (!twilioClient || !VERIFY_SERVICE_SID) {
    return res.status(503).json({ ok: false, error: 'SMS OTP is not configured yet on the server. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID.' });
  }
  try {
    const { phone } = req.body;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit phone number' });
    }
    const e164 = `+91${phone}`;

    await twilioClient.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verifications.create({ to: e164, channel: 'sms' });

    res.json({ ok: true, message: 'OTP sent' });
  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not send OTP' });
  }
});

// POST /api/verify-otp   { phone: "9876543210", code: "123456" }
app.post('/api/verify-otp', async (req, res) => {
  if (!twilioClient || !VERIFY_SERVICE_SID) {
    return res.status(503).json({ ok: false, error: 'SMS OTP is not configured yet on the server. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID.' });
  }
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ ok: false, error: 'Phone and code are required' });
    }
    const e164 = `+91${phone}`;

    const check = await twilioClient.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: e164, code });

    if (check.status === 'approved') {
      // TODO: issue your own session token / JWT here so the frontend
      // can prove "this phone is verified" on later requests.
      res.json({ ok: true, verified: true });
    } else {
      res.status(400).json({ ok: false, verified: false, error: 'Incorrect or expired code' });
    }
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not verify OTP' });
  }
});

/* ---------------------------------------------------------
   MENU (server-side)
   ---------------------------------------------------------
   Defined here so prices/names can never be tampered with from the
   browser. Keep this in sync with the MENU object in
   qr-restaurant-page.html when you edit items.
   --------------------------------------------------------- */
const MENU = {
  s1: { name: 'Chicken Malai Tikka', price: 220 },
  s2: { name: 'Chicken 65', price: 260 },
  m1: { name: 'Butter Chicken', price: 340 },
  m2: { name: 'Mutton Curry', price: 320 },
  m3: { name: 'Chicken Biryani', price: 250 },
  d1: { name: 'Masala Chaas', price: 70 },
  d2: { name: 'Fresh Lime Soda', price: 80 },
};

/* ---------------------------------------------------------
   ORDER STORAGE
   ---------------------------------------------------------
   Simple JSON-file "database" so orders survive a server restart.
   Fine for a single small restaurant; swap for a real database
   (Postgres/MongoDB/etc.) once order volume grows.
   --------------------------------------------------------- */
const ORDERS_FILE = path.join(__dirname, 'orders.json');

function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// POST /api/create-order   { phone, items: [{id, qty}], paymentMethod: 'cod' | 'upi' }
// No payment gateway involved — this just records the order.
// Every order starts as "pending". Only the owner can mark it "paid",
// from the dashboard, after actually confirming they received the
// money (cash in hand, or checking their UPI app / bank for the
// incoming payment). Nothing here auto-marks anything as paid.
app.post('/api/create-order', (req, res) => {
  try {
    const { phone, items, paymentMethod } = req.body; // items: [{ id: 'm1', qty: 2 }, ...]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Cart is empty' });
    }
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'Valid phone number required' });
    }
    const method = (paymentMethod === 'upi') ? 'upi' : 'cod';

    let amount = 0;
    const lineItems = [];
    for (const line of items) {
      const item = MENU[line.id];
      if (!item) return res.status(400).json({ ok: false, error: `Unknown item: ${line.id}` });
      amount += item.price * line.qty;
      lineItems.push({ id: line.id, name: item.name, qty: line.qty, price: item.price });
    }

    const orders = loadOrders();

    // 4-digit order number the customer sees and can quote to staff
    // (e.g. "order #4821"). Internal `id` (order_<timestamp>_<random>)
    // stays the real unique key used everywhere in the code; `displayId`
    // is just the short human-friendly number.
    const existingDisplayIds = new Set(orders.map(o => o.displayId));
    let displayId;
    do {
      displayId = String(Math.floor(1000 + Math.random() * 9000)); // 1000-9999
    } while (existingDisplayIds.has(displayId));

    const orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const localOrder = {
      id: orderId,
      displayId,
      phone,
      items: lineItems,
      amount,
      paymentMethod: method, // 'cod' | 'upi'
      status: 'pending', // pending | paid — owner flips this manually
      createdAt: new Date().toISOString(),
    };
    orders.unshift(localOrder); // newest first
    saveOrders(orders);

    res.json({ ok: true, order: { id: orderId, displayId, amount } });
  } catch (err) {
    console.error('create-order error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not create order' });
  }
});

// POST /api/orders/:id/utr   { phone, utr }
// Lets the customer (optionally) attach their UPI transaction
// reference number (UTR/Ref No, shown in their UPI app after paying)
// to their order. This does NOT mark the order as paid — it's just a
// note that helps the owner cross-check their bank statement faster
// when confirming payment. Only the order's own phone number can add it.
app.post('/api/orders/:id/utr', (req, res) => {
  try {
    const { phone, utr } = req.body;
    if (!utr || !String(utr).trim()) {
      return res.status(400).json({ ok: false, error: 'UTR/reference number is required' });
    }
    const orders = loadOrders();
    const order = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
    if (order.phone !== phone) return res.status(403).json({ ok: false, error: 'Not your order' });
    order.utr = String(utr).trim().slice(0, 40);
    saveOrders(orders);
    res.json({ ok: true });
  } catch (err) {
    console.error('add-utr error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not save reference number' });
  }
});

// GET /api/my-orders?phone=9876543210
// Lets a customer see their own past orders (order history) on this
// device — no PIN needed, but only returns orders matching that exact
// phone number, and only non-sensitive fields.
app.get('/api/my-orders', (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'Valid phone number required' });
    }
    const orders = loadOrders();
    const mine = orders
      .filter(o => o.phone === phone)
      .map(o => ({
        displayId: o.displayId,
        items: o.items,
        amount: o.amount,
        paymentMethod: o.paymentMethod,
        status: o.status,
        createdAt: o.createdAt,
      }));
    res.json({ ok: true, orders: mine });
  } catch (err) {
    console.error('my-orders error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load order history' });
  }
});

// GET /api/order-status/:id   (public — no PIN. Customer's phone polls
// this after placing a UPI order, to know the moment the OWNER confirms
// payment on the dashboard. Only returns minimal status info, not the
// full order, to keep this endpoint safe to leave open.)
app.get('/api/order-status/:id', (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
  res.json({ ok: true, status: order.status, displayId: order.displayId });
});

// GET /api/my-orders/:phone   (public — no PIN. Lets a customer see
// their own past orders by phone number, e.g. for an "Order history"
// screen. Only returns the last 20 orders for that number, and only
// the fields needed to display history — not full internal details.)
app.get('/api/my-orders/:phone', (req, res) => {
  const phone = req.params.phone;
  if (!/^\d{10}$/.test(phone)) {
    return res.status(400).json({ ok: false, error: 'Invalid phone number' });
  }
  const orders = loadOrders()
    .filter(o => o.phone === phone)
    .slice(0, 20)
    .map(o => ({
      displayId: o.displayId,
      items: o.items,
      amount: o.amount,
      paymentMethod: o.paymentMethod,
      status: o.status,
      createdAt: o.createdAt,
    }));
  res.json({ ok: true, orders });
});

/* ---------------------------------------------------------
   OWNER DASHBOARD API
   ---------------------------------------------------------
   Protected by a simple PIN header so randoms can't see order data.
   Set OWNER_PIN in .env. This is basic protection suitable for a
   single-owner small business — for multiple staff logins or
   stronger security, add proper authentication (e.g. sessions/JWT).
   --------------------------------------------------------- */
function checkOwnerPin(req, res, next) {
  const pin = req.header('x-owner-pin');
  if (!process.env.OWNER_PIN || pin !== process.env.OWNER_PIN) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing PIN' });
  }
  next();
}

// GET /api/orders   (header: x-owner-pin)
app.get('/api/orders', checkOwnerPin, (req, res) => {
  const orders = loadOrders();
  res.json({ ok: true, orders });
});

// POST /api/orders/:id/mark-paid   (header: x-owner-pin)
// Lets the owner manually mark an order paid (e.g. cash on pickup).
app.post('/api/orders/:id/mark-paid', checkOwnerPin, (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.paymentId = order.paymentId || 'CASH';
  saveOrders(orders);
  res.json({ ok: true, order });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
