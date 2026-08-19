# TastyBites — QR Order Website

See backend/README.md-style notes inline. Key points:
- Payment: Cash on Delivery or UPI deep-link (no gateway). Set UPI_ID in qr-restaurant-page.html.
- Every order gets a 4-digit Order # shown to the customer and on the owner dashboard.
- Orders always start "Pending" — owner marks "Paid" manually after confirming payment.
- Set BACKEND_URL in qr-restaurant-page.html to your Render backend.
- Once your QR is printed, keep redeploying to the SAME Netlify site — never a new one.
