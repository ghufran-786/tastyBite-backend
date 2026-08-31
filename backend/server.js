require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '500kb' }));

/* ---------------------------------------------------------
   2FACTOR.IN SETUP (OTP send + verify)
   ---------------------------------------------------------
   If TWOFACTOR_API_KEY isn't set yet, we don't crash the server.
   The /api/send-otp and /api/verify-otp routes below fall back to
   a DEMO mode until you add a real 2Factor API key — everything
   else (orders, payments, dashboard) keeps working fine meanwhile.

   DEMO FALLBACK: while 2Factor isn't configured, the fixed code
   "123456" is accepted for ANY phone number so you can keep testing
   the full order flow without real SMS. The moment a real
   TWOFACTOR_API_KEY is added, this fallback automatically stops
   being used — only real SMS-verified codes work from then on.

   How 2Factor's OTP flow works:
   1. send-otp calls 2Factor's AUTOGEN endpoint, which generates the
      OTP on their side and texts it to the customer. It returns a
      "Details" field — this is a session ID we must save and send
      back later to verify.
   2. Because the session ID needs to survive between the send-otp
      and verify-otp calls (two separate HTTP requests), we keep a
      short-lived in-memory map of phone -> sessionId. Entries expire
      after 10 minutes automatically.
   --------------------------------------------------------- */
const TWOFACTOR_API_KEY = process.env.TWOFACTOR_API_KEY;
const DEMO_OTP_CODE = '123456';
const twoFactorConfigured = !!TWOFACTOR_API_KEY;

if (!twoFactorConfigured) {
  console.warn(`[2Factor] Not configured — using DEMO OTP mode. Any phone number + code "${DEMO_OTP_CODE}" will verify successfully. Add TWOFACTOR_API_KEY to enable real SMS.`);
}

// phone -> { sessionId, expiresAt }
const otpSessions = new Map();
const OTP_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

// POST /api/send-otp   { phone: "9876543210" }
app.post('/api/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{10}$/.test(phone)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit phone number' });
  }

  if (!twoFactorConfigured) {
    return res.json({ ok: true, message: 'OTP sent (demo mode — use code 123456)', demo: true });
  }

  try {
    const url = `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/+91${phone}/AUTOGEN`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.Status !== 'Success') {
      console.error('send-otp error:', data.Details);
      return res.status(500).json({ ok: false, error: 'Could not send OTP' });
    }

    otpSessions.set(phone, { sessionId: data.Details, expiresAt: Date.now() + OTP_SESSION_TTL_MS });
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

  if (!twoFactorConfigured) {
    if (code === DEMO_OTP_CODE) {
      return res.json({ ok: true, verified: true, demo: true });
    }
    return res.status(400).json({ ok: false, verified: false, error: `Incorrect code. (Demo mode is on — use ${DEMO_OTP_CODE})` });
  }

  const session = otpSessions.get(phone);
  if (!session || Date.now() > session.expiresAt) {
    otpSessions.delete(phone);
    return res.status(400).json({ ok: false, verified: false, error: 'OTP expired — please request a new one' });
  }

  try {
    const url = `https://2factor.in/API/V1/${TWOFACTOR_API_KEY}/SMS/VERIFY/${session.sessionId}/${code}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.Status === 'Success') {
      otpSessions.delete(phone);
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
   --------------------------------------------------------- */
const DEFAULT_MENU = {
  s1: { id: 's1', category: 'Starters', name: 'Chicken Malai Tikka', desc: 'Creamy marinated chicken, chargrilled', price: 220, emoji: '🍢', nonveg: true },
  s2: { id: 's2', category: 'Starters', name: 'Chicken 65', desc: 'Spicy fried chicken, curry leaves', price: 260, emoji: '🍗', nonveg: true },
  m1: { id: 'm1', category: 'Mains', name: 'Butter Chicken', desc: 'Tomato-butter gravy, served with rice', price: 340, emoji: '🍛', nonveg: true },
  m2: { id: 'm2', category: 'Mains', name: 'Mutton Curry', desc: 'Slow-cooked mutton, home-style spices', price: 320, emoji: '🍲', nonveg: true },
  m3: { id: 'm3', category: 'Mains', name: 'Chicken Biryani', desc: 'Basmati rice, saffron, raita', price: 250, emoji: '🍚', nonveg: true },
  d1: { id: 'd1', category: 'Drinks', name: 'Masala Chaas', desc: 'Spiced buttermilk', price: 70, emoji: '🥤', nonveg: false },
  d2: { id: 'd2', category: 'Drinks', name: 'Fresh Lime Soda', desc: 'Sweet or salted', price: 80, emoji: '🍋', nonveg: false },
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
const MENU_FILE = path.join(__dirname, 'menu.json');
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
function loadMenuFromFile() {
  try {
    return JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
  } catch {
    return Object.values(DEFAULT_MENU);
  }
}
function saveMenuToFile(items) {
  fs.writeFileSync(MENU_FILE, JSON.stringify(items, null, 2));
}

// ---- Storage abstraction: same functions work whether Firestore is
// connected or not, so the rest of the code below never needs to
// know or care which storage is actually being used. ----
const ORDERS_COLLECTION = 'orders';
const MENU_COLLECTION = 'menu';

async function getMenuItems() {
  if (db) {
    const snap = await db.collection(MENU_COLLECTION).get();
    const saved = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
    return Object.values(DEFAULT_MENU).map(item => saved[item.id] || item)
      .concat(snap.docs.map(d => d.data()).filter(item => !DEFAULT_MENU[item.id]));
  }
  return loadMenuFromFile();
}

async function getMenuById(id) {
  const items = await getMenuItems();
  return items.find(item => item.id === id) || null;
}

// Public menu endpoint. It is read-only; prices still come from the server
// when an order is created.
app.get('/api/menu', async (req, res) => {
  try {
    const items = await getMenuItems();
    res.json({ ok: true, items });
  } catch (err) {
    console.error('menu load error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load menu' });
  }
});

async function saveMenuItem(item) {
  if (db) {
    await db.collection(MENU_COLLECTION).doc(item.id).set(item);
    return;
  }
  const items = loadMenuFromFile().filter(existing => existing.id !== item.id);
  items.push(item);
  saveMenuToFile(items);
}

// PUT /api/menu/:id (header: x-owner-pin)
app.put('/api/menu/:id', checkOwnerPin, async (req, res) => {
  try {
    const existing = await getMenuById(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Menu item not found' });

    const { category, name, desc, price, image, emoji, nonveg } = req.body;
    const cleanCategory = String(category || '').trim().slice(0, 40);
    const cleanName = String(name || '').trim().slice(0, 80);
    const cleanDesc = String(desc || '').trim().slice(0, 160);
    const numericPrice = Number(price);
    const cleanImage = String(image || '').trim();
    if (!cleanCategory || !cleanName || !cleanDesc) {
      return res.status(400).json({ ok: false, error: 'Category, name and description are required' });
    }
    if (!Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice > 100000) {
      return res.status(400).json({ ok: false, error: 'Enter a valid price' });
    }
    if (cleanImage && (!cleanImage.startsWith('data:image/') || cleanImage.length > 300000)) {
      return res.status(400).json({ ok: false, error: 'Image must be a valid image under 220 KB' });
    }

    const item = {
      ...existing,
      category: cleanCategory,
      name: cleanName,
      desc: cleanDesc,
      price: Math.round(numericPrice),
      image: cleanImage || existing.image || '',
      emoji: String(emoji || existing.emoji || '🍽️').slice(0, 4),
      nonveg: Boolean(nonveg),
    };
    await saveMenuItem(item);
    res.json({ ok: true, item });
  } catch (err) {
    console.error('edit-menu-item error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not edit menu item' });
  }
});

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
    const { phone, items, paymentMethod, address } = req.body; // items: [{ id: 'm1', qty: 2 }, ...]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Cart is empty' });
    }
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: 'Valid phone number required' });
    }

    // Delivery address: 5 required parts. Validated here too (not just
    // on the frontend) since the frontend check can always be bypassed.
    if (!address || typeof address !== 'object') {
      return res.status(400).json({ ok: false, error: 'Delivery address is required' });
    }
    const house = String(address.house || '').trim();
    const area = String(address.area || '').trim();
    const pincode = String(address.pincode || '').trim();
    const city = String(address.city || '').trim();
    const mobile = String(address.mobile || '').trim();
    if (!house) return res.status(400).json({ ok: false, error: 'House/Flat No. is required' });
    if (!area) return res.status(400).json({ ok: false, error: 'Area/Street/Colony is required' });
    if (!/^\d{6}$/.test(pincode)) return res.status(400).json({ ok: false, error: 'A valid 6-digit pincode is required' });
    if (!city) return res.status(400).json({ ok: false, error: 'City is required' });
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ ok: false, error: 'A valid 10-digit contact number is required' });

    const method = (paymentMethod === 'upi') ? 'upi' : 'cod';

    const menuItems = await getMenuItems();
    const menuById = Object.fromEntries(menuItems.map(item => [item.id, item]));
    let amount = 0;
    const lineItems = [];
    for (const line of items) {
      const item = menuById[line.id];
      if (!item) return res.status(400).json({ ok: false, error: `Unknown item: ${line.id}` });
      const qty = Number(line.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ ok: false, error: 'Invalid item quantity' });
      }
      amount += item.price * qty;
      lineItems.push({ id: line.id, name: item.name, qty, price: item.price });
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
      address: { house, area, pincode, city, mobile },
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
      address: o.address,
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

// POST /api/menu (header: x-owner-pin)
app.post('/api/menu', checkOwnerPin, async (req, res) => {
  try {
    const { category, name, desc, price, image, emoji, nonveg } = req.body;
    const cleanCategory = String(category || '').trim().slice(0, 40);
    const cleanName = String(name || '').trim().slice(0, 80);
    const cleanDesc = String(desc || '').trim().slice(0, 160);
    const numericPrice = Number(price);
    const cleanImage = String(image || '').trim();

    if (!cleanCategory || !cleanName || !cleanDesc || !cleanImage) {
      return res.status(400).json({ ok: false, error: 'Category, name, description and image are required' });
    }
    if (!Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice > 100000) {
      return res.status(400).json({ ok: false, error: 'Enter a valid price' });
    }
    if (cleanImage && (!cleanImage.startsWith('data:image/') || cleanImage.length > 300000)) {
      return res.status(400).json({ ok: false, error: 'Image must be a valid image under 220 KB' });
    }

    const item = {
      id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      category: cleanCategory,
      name: cleanName,
      desc: cleanDesc,
      price: Math.round(numericPrice),
      image: cleanImage,
      emoji: String(emoji || '🍽️').slice(0, 4),
      nonveg: Boolean(nonveg),
    };
    await saveMenuItem(item);
    res.json({ ok: true, item });
  } catch (err) {
    console.error('add-menu-item error:', err.message);
    res.status(500).json({ ok: false, error: 'Could not add menu item' });
  }
});

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

// Separate owner-only page URL. The dashboard still requires OWNER_PIN.
app.get('/owner-dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'owner-dashboard.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
