# TastyBites — QR Order Website

## What's inside

```
swad-kitchen-website/
├── qr-restaurant-page.html     ← customer-facing page (what the QR code points to)
├── logo.png                    ← your logo, background removed
└── backend/
    ├── server.js               ← Node backend: real OTP (Twilio), Razorpay payments, order storage
    ├── package.json
    ├── .env.example             ← SAFE for GitHub. Placeholder values only.
    ├── .gitignore                ← tells GitHub to never upload your real .env file
    ├── owner-dashboard.html    ← YOU (owner) open this to see incoming orders + payment status
    ├── qr-generator.html       ← generates the printable QR code for tables
    └── README.md                ← backend-specific setup notes
```

## ⚠️ Twilio is now optional

The server no longer crashes if Twilio isn't set up yet. If
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID`
are missing or invalid, the server still starts normally — orders,
payments, and the dashboard all keep working. Only the OTP endpoints
return a "not configured yet" message until you add real Twilio values
later (e.g. after upgrading your Twilio account).

## ⚠️ IMPORTANT: Once you generate your QR code, don't change the URL it points to

Your QR code is just an image encoding a URL (your Netlify link). Once
you print it and stick it on tables, **that URL is permanently baked
into the printed QR — it doesn't update itself.** If you ever redeploy
your frontend to a *different* URL (a new Netlify site, a different
domain, etc.), every printed QR code becomes dead and customers scanning
it will get an error.

**Safe changes** (do NOT require a new QR):
- Editing `qr-restaurant-page.html` and re-uploading to the *same*
  Netlify site (Netlify keeps the same URL every time you redeploy)
- Changing menu items, prices, colors, backend logic, etc.

**Unsafe changes** (WOULD require reprinting a new QR):
- Creating a brand-new Netlify site instead of updating the existing one
- Switching hosting providers (Netlify → Vercel, etc.)
- Buying a custom domain later and switching to it

So: always redeploy to the *same* Netlify site you started with, and
you'll never need to reprint your QR codes.

## About the .env file

You will create a file called `.env` (copy `.env.example`, rename it,
fill in real values) **on your own computer only**. This file holds your
real Twilio and Razorpay secret keys.

- `.env.example` → safe, has fake placeholder text → OK to upload to GitHub
- `.env` → has your REAL secret keys → **never upload to GitHub**

## The three "apps" and who uses each one

| File | Who uses it | What it does |
|---|---|---|
| `qr-restaurant-page.html` | Customer | Scans QR → verifies phone → sees menu → orders → pays |
| `backend/owner-dashboard.html` | Owner/staff | See every order, phone number, items, amount, Paid/Pending status |
| `backend/qr-generator.html` | Owner (one-time) | Paste your live menu-page URL → download a QR to print for tables |

## Quick start (preview locally, no setup)

1. Double-click `qr-restaurant-page.html` — runs in demo mode (OTP is `123456`, payment simulated, no real SMS, nothing saved).
2. Double-click `backend/owner-dashboard.html` — shows sample demo orders until connected to a real backend.

## Going live — step by step

**Step 1 — Create your real .env file (on your computer, NOT GitHub)**
In the `backend` folder, copy `.env.example`, rename the copy to `.env`,
and fill in your real Razorpay Key/Secret and an OWNER_PIN of your
choice. Leave the Twilio lines as placeholders for now if you haven't
upgraded your Twilio account yet — the server will still work fine.

**Step 2 — Upload to GitHub**
Upload everything in this zip to your GitHub repo **except** the `.env`
file you just made.

**Step 3 — Deploy the backend on Render**
- New → Web Service → connect your GitHub repo
- Build Command: `npm install`
- Start Command: `node server.js`
- In Render's "Environment Variables" section, manually add each value
  from your `.env` file
- Deploy → you'll get a URL like `https://tastybites-backend.onrender.com`

**Step 4 — Host the customer page on Netlify**
- Open `qr-restaurant-page.html` in a text editor, find
  `const BACKEND_URL = "";` near the top of the `<script>` section, and
  set it to your Render URL from Step 3.
- Save, then drag-and-drop the file onto Netlify's dashboard.
- You'll get a live URL like `https://tastybites-order.netlify.app`
  — **remember this URL, it's permanent once your QR code is printed.**

**Step 5 — Generate your QR code (do this ONCE)**
Open `backend/qr-generator.html` → paste your Step 4 live URL → download
the QR image → print it and stick it on tables.

**Step 6 — Watch orders come in**
Open `backend/owner-dashboard.html`, enter your Step 3 backend URL and
your OWNER_PIN — you'll see live orders with payment status.

**Step 7 — Later, when ready for real SMS**
Upgrade your Twilio account (add a card + balance), create a Verify
Service, then update the three Twilio environment variables on Render
with your real values (Render → your service → Environment). No redeploy
of the frontend or new QR code needed — just update Render's env vars
and the backend restarts automatically.
