# Swad Kitchen — QR Order Website

## What's inside

```
swad-kitchen-website/
├── qr-restaurant-page.html     ← the customer-facing page (open this in a browser to preview)
└── backend/
    ├── server.js               ← Node backend: real OTP + Razorpay payments
    ├── package.json
    ├── .env.example             ← copy to .env and add your Twilio/Razorpay keys
    ├── qr-generator.html       ← generate your table QR code once you're hosted
    └── README.md                ← full setup + deployment instructions
```

## Quick start

1. Double-click `qr-restaurant-page.html` to preview it right now (runs in
   demo mode — OTP code is `123456`, payment is simulated).
2. To make it real (actual SMS + actual payments), open `backend/README.md`
   and follow the steps.

## Fastest path to a live QR page

1. Host `qr-restaurant-page.html` for free on Netlify or Vercel (drag-and-drop).
2. Deploy `backend/` to Render.com or Railway.app for free.
3. Fill in `backend/.env` with your Twilio and Razorpay keys.
4. Update the `fetch()` URLs in `qr-restaurant-page.html` to point to your
   live backend (see `backend/README.md` for exact code).
5. Open `backend/qr-generator.html`, paste your live page's URL, download
   the QR — print it for your tables.
