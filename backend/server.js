require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const Razorpay = require('razorpay');

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
   RAZORPAY SETUP (order creation + payment verification)
   ---------------------------------------------------------
   Same safety approach as Twilio above: don't let a missing/invalid
   key crash the whole server. Payment routes just return a clear
   "not configured" error until real keys are added.
   --------------------------------------------------------- */
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const razorpayConfigured = !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && RAZORPAY_KEY_ID.startsWith('rzp_'));

if (!razorpayConfigured) {
  console.warn('[Razorpay] Not configured (missing/invalid RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET). Payment endpoints will return an error until this is fixed. Rest of the server will run normally.');
}

const razorpay = razorpayConfigured
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

// Menu is defined here (server-side) so prices/names can never be tampered
// with from the browser. Keep this in sync with the MENU object in
// qr-restaurant-page.html when you edit items.
const MENU = {
  s1: { name: 'Paneer Tikka', price: 220 },
  s2: { name: 'Chicken 65', price: 260 },
  m1: { name: 'Butter Chicken', price: 340 },
  m2: { name: 'Dal Makhani', price: 210 },
  m3: { name: 'Veg Biryani', price: 230 },
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

// POST /api/create-order   { phone, items: [{id, qty}] }
app.post('/api/create-order', async (req, res) => {
  if (!razorpayConfigured) {
    return res.status(503).json({ ok: false, error: 'Payments are not configured yet on the server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
  }
  try {
    const { phone, items } = req.body; // items: [{ id: 'm1', qty: 2 }, ...]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Cart is empty' });
    }
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'Valid phone number required' });
    }

    let amount = 0;
    const lineItems = [];
    for (const line of items) {
      const item = MENU[line.id];
      if (!item) return res.status(400).json({ ok: false, error: `Unknown item: ${line.id}` });
      amount += item.price * line.qty;
      lineItems.push({ id: line.id, name: item.name, qty: line.qty, price: item.price });
    }

    const rzpOrder = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: 'INR',
      receipt: `order_${Date.now()}`,
    });

    const orders = loadOrders();
    const localOrder = {
      id: rzpOrder.id,
      phone,
      items: lineItems,
      amount,
      status: 'pending', // pending | paid
      createdAt: new Date().toISOString(),
    };
    orders.unshift(localOrder); // newest first
    saveOrders(orders);

    res.json({ ok: true, order: rzpOrder, key_id: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('create-order error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not create order' });
  }
});

// POST /api/verify-payment
// { razorpay_order_id, razorpay_payment_id, razorpay_signature }
app.post('/api/verify-payment', (req, res) => {
  if (!razorpayConfigured) {
    return res.status(503).json({ ok: false, error: 'Payments are not configured yet on the server. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
  }
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature === razorpay_signature) {
    const orders = loadOrders();
    const order = orders.find(o => o.id === razorpay_order_id);
    if (order) {
      order.status = 'paid';
      order.paymentId = razorpay_payment_id;
      order.paidAt = new Date().toISOString();
      saveOrders(orders);
    }
    res.json({ ok: true, verified: true });
  } else {
    res.status(400).json({ ok: false, verified: false, error: 'Signature mismatch — possible tampering' });
  }
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
