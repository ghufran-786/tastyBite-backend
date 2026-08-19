# TastyBites — QR Order Website

## What's inside

```
swad-kitchen-website/
├── qr-restaurant-page.html     ← customer-facing page (what the QR code points to)
├── logo.png                    ← your logo, background removed
└── backend/
    ├── server.js               ← Node backend: OTP (Twilio, optional), order storage
    ├── package.json
    ├── .env.example             ← SAFE for GitHub. Placeholder values only.
    ├── .gitignore                ← tells GitHub to never upload your real .env file
    ├── owner-dashboard.html    ← YOU (owner) open this to see incoming orders + payment status
    ├── qr-generator.html       ← generates the printable QR code for tables
    └── README.md                ← backend-specific setup notes
```

## 💳 How payment works now (no payment gateway)

There is no Razorpay / payment gateway anymore. At checkout, the customer
picks one of two options:

- **Cash on Delivery** — order is placed, marked "Pending" on your
  dashboard. You collect cash when it's delivered/picked up.
- **Pay via UPI** — order is placed, then their phone's UPI app (GPay,
  PhonePe, Paytm, etc.) opens automatically with your UPI ID and the
  correct amount pre-filled. They complete the payment there.

**Important: no order is ever auto-marked as "Paid."** Even after a UPI
payment, the order stays "Pending" on your dashboard until **you**
manually tap "Mark as Paid" — after checking the money actually landed
in your UPI/bank account. This avoids relying on any gateway or webhook,
but it means you (or staff) should check your UPI app / bank for
incoming payments and confirm them on the dashboard.

### Set your UPI ID (required for the UPI option to work)

Open `qr-restaurant-page.html` in a text editor, find:
```js
const UPI_ID = "your-upi-id@bank";
```
Replace it with your real UPI ID (VPA) — e.g. `9876543210@okhdfcbank` or
`yourrestaurant@okicici`. You can find this in any UPI app (GPay, PhonePe,
Paytm, or your bank's app) under "My UPI ID" / "Profile."

## ⚠️ Twilio is optional

If `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID`
are missing or invalid, the server still starts normally — orders and
the dashboard keep working. Only the OTP endpoints return a "not
configured yet" message until you add real Twilio values later.

## ⚠️ IMPORTANT: Once you generate your QR code, don't change the URL it points to

Your QR code is just an image encoding a URL (your Netlify link). Once
you print it and stick it on tables, **that URL is permanently baked
into the printed QR — it doesn't update itself.**

**Safe:** re-uploading updated files to the *same* Netlify site (URL stays the same).
**Unsafe:** creating a brand-new Netlify site, switching hosts, or buying a new domain later.

## About the .env file

You create a file called `.env` (copy `.env.example`, rename it, fill in
real values) **on your own computer only** — never upload it to GitHub.

## The three "apps" and who uses each one

| File | Who uses it | What it does |
|---|---|---|
| `qr-restaurant-page.html` | Customer | Scans QR → verifies phone → sees menu → orders → pays (COD/UPI) |
| `backend/owner-dashboard.html` | Owner/staff | See every order, phone number, items, amount, payment method, Paid/Pending status |
| `backend/qr-generator.html` | Owner (one-time) | Paste your live menu-page URL → download a QR to print for tables |

## Quick start (preview locally, no setup)

1. Double-click `qr-restaurant-page.html` — runs in demo mode (OTP is `123456`, no real SMS, nothing saved).
2. Double-click `backend/owner-dashboard.html` — shows sample demo orders until connected to a real backend.

## Going live — step by step

**Step 1 — Set your UPI ID**
In `qr-restaurant-page.html`, set `const UPI_ID = "...";` to your real UPI ID.

**Step 2 — Create your real .env file (on your computer, NOT GitHub)**
In the `backend` folder, copy `.env.example`, rename to `.env`, fill in
an `OWNER_PIN` of your choice. Leave Twilio lines as placeholders if you
haven't set that up yet.

**Step 3 — Upload to GitHub**
Upload everything **except** your `.env` file.

**Step 4 — Deploy the backend on Render**
- New → Web Service → connect your GitHub repo
- Root Directory: `backend`
- Build Command: `npm install`
- Start Command: `node server.js`
- Add your Environment Variables (from `.env`) in Render's dashboard
- Deploy → you'll get a URL like `https://tastybites-backend.onrender.com`

**Step 5 — Host the customer page on Netlify**
- In `qr-restaurant-page.html`, set `const BACKEND_URL = "...";` to your Step 4 Render URL.
- Drag-and-drop the file onto Netlify (same site each time you update it).
- Make sure the site is set to **Public**, not Private.
- You'll get a live URL like `https://tastybites-order.netlify.app` — this is permanent once your QR is printed.

**Step 6 — Generate your QR code (do this ONCE)**
Open `backend/qr-generator.html` → paste your Step 5 live URL → download → print.

**Step 7 — Watch orders come in**
Open `backend/owner-dashboard.html`, enter your Step 4 backend URL and
your OWNER_PIN. For every order, check whether payment (UPI) actually
arrived, then tap "Mark as Paid."
