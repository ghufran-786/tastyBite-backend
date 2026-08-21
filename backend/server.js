require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');
const admin = require('firebase-admin');

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

   DEMO FALLBACK: while Twilio isn't configured, the fixed code
   "123456" is accepted for ANY phone number so you can keep testing
   the full order flow without real SMS. The moment real Twilio
   credentials are added, this fallback automatically stops being
   used — only real SMS-verified codes work from then on.
   --------------------------------------------------------- */
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const DEMO_OTP_CODE = '123456';

let twilioClient = null;
const twilioConfigured = !!(TWILIO_SID && TWILIO_SID.startsWith('AC') && TWILIO_TOKEN && VERIFY_SERVICE_SID);
if (twilioConfigured) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
} else {
  console.warn(`[Twilio] Not configured — using DEMO OTP mode. Any phone number + code "${DEMO_OTP_CODE}" will verify successfully. Add real Twilio credentials to enable real SMS.`);
}

// POST /api/send-otp   { phone: "9876543210" }
app.post('/api/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit phone number' });
  }

  if (!twilioConfigured) {
    return res.json({ ok: true, message: 'OTP sent (demo mode — use code 123456)', demo: true });
  }

  try {
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
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.status(400).json({ ok: false, error: 'Phone and code are required' });
  }

  if (!twilioConfigured) {
    if (code === DEMO_OTP_CODE) {
      return res.json({ ok: true, verified: true, demo: true });
    }
    return res.status(400).json({ ok: false, verified: false, error: `Incorrect code. (Demo mode is on — use ${DEMO_OTP_CODE})` });
  }

  try {
    const e164 = `+91${phone}`;
    const check = await twilioClient.verify.v2
      .services(VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: e164, code });

    if (check.status === 'approved') {
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
   ORDER STORAGE — Firebase Firestore
   ---------------------------------------------------------
   Primary storage: Firebase Firestore (set FIREBASE_SERVICE_ACCOUNT
   in your .env / Render environment variables — the full service
   account JSON, as one line). Orders persist permanently — they
   survive redeploys, restarts, everything.

   Fallback: if FIREBASE_SERVICE_ACCOUNT isn't set (e.g. running
   locally without it configured yet), the server falls back to a
   local orders.json file so you can still preview/test everything
   without Firebase. This fallback does NOT persist across Render
   redeploys — only Firestore does.
   --------------------------------------------------------- */
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
let db = null;

function initFirebase() {
  if (!FIREBASE_SERVICE_ACCOUNT) {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — falling back to local orders.json file. Orders will NOT survive redeploys until Firebase is configured.');
    return;
  }
  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('[Firebase] Connected — orders will now persist permanently.');
  } catch (err) {
    console.error('[Firebase] Failed to initialize, falling back to local orders.json file:', err.message);
    db = null;
  }
}
initFirebase();

// ---- File-based fallback (used only if Firebase isn't connected) ----
const ORDERS_FILE = path.join(__dirname, 'orders.json');
function loadOrdersFromFile() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveOrdersToFile(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ---- Storage abstraction: same functions work whether Firestore is
// connected or not, so the rest of the code below never needs to
// know or care which storage is actually being used. ----
const ORDERS_COLLECTION = 'orders';

async function getAllOrders() {
  if (db) {
    const snap = await db.collection(ORDERS_COLLECTION).orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => d.data());
  }
  return loadOrdersFromFile();
}
async function getOrderById(id) {
  if (db) {
    const doc = await db.collection(ORDERS_COLLECTION).doc(id).get();
    return doc.exists ? doc.data() : null;
  }
  return loadOrdersFromFile().find(o => o.id === id) || null;
}
async function getOrdersByPhone(phone) {
  if (db) {
    // No orderBy combined with where here on purpose — avoids needing a
    // manually-created Firestore composite index. We sort in code instead.
    const snap = await db.collection(ORDERS_COLLECTION).where('phone', '==', phone).get();
    const orders = snap.docs.map(d => d.data());
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return orders;
  }
  return loadOrdersFromFile()
    .filter(o => o.phone === phone)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function insertOrder(order) {
  if (db) {
    await db.collection(ORDERS_COLLECTION).doc(order.id).set(order);
    return;
  }
  const orders = loadOrdersFromFile();
  orders.unshift(order);
  saveOrdersToFile(orders);
}
async function updateOrder(id, fields) {
  if (db) {
    await db.collection(ORDERS_COLLECTION).doc(id).update(fields);
    return;
  }
  const orders = loadOrdersFromFile();
  const order = orders.find(o => o.id === id);
  if (order) Object.assign(order, fields);
  saveOrdersToFile(orders);
}
async function displayIdExists(displayId) {
  if (db) {
    const snap = await db.collection(ORDERS_COLLECTION).where('displayId', '==', displayId).limit(1).get();
    return !snap.empty;
  }
  return loadOrdersFromFile().some(o => o.displayId === displayId);
}

// POST /api/create-order   { phone, items: [{id, qty}], paymentMethod: 'cod' | 'upi' }
// No payment gateway involved — this just records the order.
// Every order starts as "pending". Only the owner can mark it "paid",
// from the dashboard, after actually confirming they received the
// money (cash in hand, or checking their UPI app / bank for the
// incoming payment). Nothing here auto-marks anything as paid.
app.post('/api/create-order', async (req, res) => {
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

    // 4-digit order number the customer sees and can quote to staff
    // (e.g. "order #4821"). Internal `id` (order_<timestamp>_<random>)
    // stays the real unique key used everywhere in the code; `displayId`
    // is just the short human-friendly number.
    let displayId;
    do {
      displayId = String(Math.floor(1000 + Math.random() * 9000)); // 1000-9999
    } while (await displayIdExists(displayId));

    const orderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const order = {
      id: orderId,
      displayId,
      phone,
      items: lineItems,
      amount,
      paymentMethod: method, // 'cod' | 'upi'
      status: 'pending', // pending | paid — owner flips this manually
      createdAt: new Date().toISOString(),
    };
    await insertOrder(order);

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
app.post('/api/orders/:id/utr', async (req, res) => {
  try {
    const { phone, utr } = req.body;
    if (!utr || !String(utr).trim()) {
      return res.status(400).json({ ok: false, error: 'UTR/reference number is required' });
    }
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
    if (order.phone !== phone) return res.status(403).json({ ok: false, error: 'Not your order' });
    await updateOrder(req.params.id, { utr: String(utr).trim().slice(0, 40) });
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
app.get('/api/my-orders', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'Valid phone number required' });
    }
    const orders = await getOrdersByPhone(phone);
    const mine = orders.map(o => ({
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
app.get('/api/orders', checkOwnerPin, async (req, res) => {
  const orders = await getAllOrders();
  res.json({ ok: true, orders });
});

// POST /api/orders/:id/mark-paid   (header: x-owner-pin)
// Lets the owner manually mark an order paid (e.g. cash on pickup).
app.post('/api/orders/:id/mark-paid', checkOwnerPin, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
  await updateOrder(req.params.id, {
    status: 'paid',
    paidAt: new Date().toISOString(),
    paymentId: order.paymentId || 'CASH',
  });
  const updated = await getOrderById(req.params.id);
  res.json({ ok: true, order: updated });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
