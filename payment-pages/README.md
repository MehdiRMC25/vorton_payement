# Payment result pages

**Files:**

| File | Shown when |
|------|------------|
| **payment-done.html** | Entry page – reads the bank’s URL and redirects to the right page below |
| **payment-success.html** | Payment successful |
| **payment-cancelled.html** | User cancelled payment |
| **payment-processing.html** | Payment is being processed |
| **payment-unsuccessful.html** | Payment failed |

**How it works**

1. Set your `returnUrl` to the URL where **payment-done.html** is served (e.g. `https://vorton.uk/payment/done`).
2. The bank redirects to that URL with `?ID=...&STATUS=...`.
3. **payment-done.html** reads `STATUS` and redirects to the correct page (e.g. `STATUS=Cancelled` → **payment-cancelled.html**).

**Upload to hosting**

Upload all 5 files to the same folder (e.g. `payment/`). Make sure your `returnUrl` points to `payment-done.html`. Update the "Back to Shop" link (`href="/"`) in each file to match your site.
