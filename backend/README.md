# Swad Kitchen — Backend (OTP + Razorpay)

Pairs with `qr-restaurant-page.html`. Handles the two things a browser
can't safely do on its own: sending/verifying OTPs, and creating/verifying
real Razorpay payments.

## 1. Install

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your real keys:

- **Twilio**: sign up at twilio.com → Verify → create a "Verify Service" →
  copy Account SID, Auth Token, and the Verify Service SID.
- **Razorpay**: sign up at razorpay.com → Settings → API Keys → generate
  Test keys first (switch to Live keys only after testing works).

## 2. Run locally

```bash
npm start
```

Server runs on `http://localhost:4000`.

## 3. Endpoints

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/api/send-otp` | `{ phone }` | Sends OTP via SMS |
| POST | `/api/verify-otp` | `{ phone, code }` | Verifies OTP |
| POST | `/api/create-order` | `{ phone, items, paymentMethod, address }` | Saves a UPI or COD order; amount is calculated server-side |
| POST | `/api/orders/:id/utr` | `{ phone, utr }` | Saves a customer's optional UPI reference number |
| GET | `/api/my-orders?phone=...` | — | Returns order history for that phone number |
| GET | `/api/menu` | — | Returns the current customer menu |
| POST | `/api/menu` | `{ category, name, desc, price, image, nonveg }` + owner PIN | Adds an item to the customer menu |
| PUT | `/api/menu/:id` | Edited menu fields + owner PIN | Updates an existing customer menu item |

## 4. Connect the frontend

In `qr-restaurant-page.html`, replace the demo logic with real calls:

```js
// sending OTP
await fetch('https://your-backend.com/api/send-otp', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ phone })
});

// verifying OTP
await fetch('https://your-backend.com/api/verify-otp', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ phone, code })
});

// creating a Razorpay order before opening checkout
const res = await fetch('https://your-backend.com/api/create-order', {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ items: Object.entries(cart).map(([id,qty]) => ({id,qty})) })
});
const { order, key_id } = await res.json();
// then pass order.id as `order_id` in the Razorpay checkout options
```

## 5. Deploy

Cheapest/simplest options:
- **Backend**: Render.com or Railway.app (free tier works for low traffic)
- **Frontend HTML**: Netlify or Vercel (drag-and-drop the HTML file)

Once both are live, update the `fetch` URLs above to your real backend
domain, and generate your QR code pointing at the frontend URL.

## Security notes

- Never put `RAZORPAY_KEY_SECRET` or `TWILIO_AUTH_TOKEN` in frontend code.
- Always calculate order amounts server-side (done above via `MENU_PRICES`).
- Always verify the Razorpay signature server-side before marking an order paid.
