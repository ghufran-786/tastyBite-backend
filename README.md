# TastyBites — QR Order Website

- Live customer link: https://tastybites-786.netlify.app/
- backend/qr-generator.html now makes a full styled poster (QR + logo +
  name + phone + scooter graphic), not just a plain QR. Open it, tweak
  the fields if needed, click Generate, then Download Poster PNG.
  Needs backend/logo.png sitting next to it (included).
- Payment: Cash on Delivery or UPI deep-link, UPI ID = falakquraishi@ybl
- Social icons in the header: Instagram, Facebook, YouTube, WhatsApp
- Every order gets a 4-digit Order # shown to the customer and on the owner dashboard.
- Orders always start "Pending" — owner marks "Paid" manually after confirming payment.
- Once printed, keep redeploying qr-restaurant-page.html to the SAME Netlify site — never a new one, or the QR breaks.
