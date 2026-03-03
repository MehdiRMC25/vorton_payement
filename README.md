# Payment Backend

REST API for payments, usable by both your **mobile app** and **website**. One backend, one set of endpoints.

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env with your values (see below)
npm run dev
```

API base: `http://localhost:3000/api/v1`

- **Health:** `GET /api/v1/health`
- **Create payment:** `POST /api/v1/payments/create`
- **Confirm payment (after redirect):** `GET /api/v1/payments/confirm?ID=...&STATUS=...`
- **Get payment status:** `GET /api/v1/payments/:paymentId`
- **Bank webhook (optional):** `POST /api/v1/webhooks/bank`

### Kapital Bank flow

1. **Create payment** — `POST /payments/create` with `amount`, `currency`, `returnUrl` (required). Response includes `redirectUrl`.
2. **Redirect user** — Open `redirectUrl` in browser or in-app webview (same for website and mobile).
3. **User pays** on Kapital Hosted Payment Page (HPP).
4. **Bank redirects** user to your `returnUrl` with query params `ID` (bank order id) and `STATUS` (e.g. `FullyPaid`).
5. **Confirm** — Your frontend calls `GET /api/v1/payments/confirm?ID=...&STATUS=...` to store the result and get the payment record. Then show success/failure.

**Test credentials** (in `.env.example`): `BANK_USERNAME=TerminalSys/kapital`, `BANK_PASSWORD=kapital123`.  
**Test card:** PAN `4169741330151778`, Exp `11/26`, CVV `119`.

---

## What we need from you (project)

1. **Environments**
   - Which environments do you have? (e.g. development, staging, production)
   - Production base URL of your website and (if different) mobile app deep-link or domain.

2. **Authentication**
   - How do you want to secure the API?
     - **API key** (header `X-API-Key`) — simple, good for server-to-server and mobile.
     - **JWT** — if you already have user login and want to tie payments to users.
   - We can support both; tell me which you prefer first.

3. **Allowed origins (CORS)**
   - Exact URLs of your website (e.g. `https://yourapp.com`, `https://www.yourapp.com`).
   - For a mobile app (e.g. Capacitor/React Native), we can use a custom scheme like `capacitor://localhost` or your app’s domain. Send the exact origin(s) the app will use.

4. **Business details**
   - Legal business name and support email (for receipts/statements and support links).

5. **Currencies**
   - Which currencies do you need? (e.g. USD, EUR, GBP, local currency).

6. **Optional**
   - Do you need refunds, partial refunds, or subscriptions? (We can add endpoints later.)
   - Any compliance needs (PCI, storing cards, etc.)? (Affects whether we use a hosted bank page or direct card fields.)

---

## What we need from the bank (or payment provider)

To connect the backend to real payments, we need from your **bank or payment gateway**:

1. **API / integration docs**
   - URL of the official API documentation (REST or SOAP).
   - How to get **sandbox/test** credentials and a test card set.

2. **Credentials**
   - **Merchant / client ID**
   - **API key** or **client secret** (and whether it’s per-environment).
   - **Secret key** or **shared secret** (if used for signing requests or webhooks).

3. **Endpoints**
   - Base URL for the gateway (e.g. `https://gateway.bank.com/v1`).
   - Exact endpoint to **create a payment** (or “payment intent” / “order”).
   - How to **redirect the user** to the bank’s payment page (if applicable), or how to use a **hosted form / iframe**.

4. **Webhooks**
   - Whether they send **webhooks** for payment status (success, failure, etc.).
   - Webhook URL they will call (we have `POST /api/v1/webhooks/bank`).
   - How they **sign** webhooks (e.g. header name and secret) so we can verify them.

5. **Flow**
   - **Redirect flow:** User is sent to bank page, then redirected back to your `returnUrl` / `cancelUrl`.
   - **Server-to-server only:** Backend gets a payment link or transaction ID to show in app/web.
   - **3DS / SCA:** How they handle 3D Secure (redirect, iframe, or app-based challenge).

6. **Optional**
   - Refund API (endpoint and parameters).
   - Recurring/subscription API if you need it.
   - Required **callback/return URLs** (success/cancel) and any **whitelist** for redirects.

Once you have the bank’s doc link and a sample of the “create payment” request/response, we can wire it into `paymentService.ts` and the webhook handler.

---

## Example: create payment

**Request (mobile or website):**

```http
POST /api/v1/payments/create
Content-Type: application/json
X-API-Key: your-api-key

{
  "amount": 29.99,
  "currency": "USD",
  "reference": "order-12345",
  "customerEmail": "customer@example.com",
  "returnUrl": "https://yourapp.com/payment/success",
  "cancelUrl": "https://yourapp.com/payment/cancel"
}
```

**Response:**

```json
{
  "paymentId": "pay_abc123",
  "status": "pending",
  "amount": 29.99,
  "currency": "USD",
  "reference": "order-12345",
  "clientSecret": "xxx",
  "redirectUrl": "https://bank.com/pay/xxx",
  "createdAt": "2025-03-03T12:00:00.000Z"
}
```

- **Website:** Redirect the user to `redirectUrl` (if present), or use `clientSecret` with the bank’s JS SDK.
- **Mobile app:** Open `redirectUrl` in in-app browser or use the bank’s mobile SDK with `clientSecret`.

---

## Environment variables

Copy `.env.example` to `.env` and set:

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 3000) |
| `API_PREFIX` | API path prefix (default `/api/v1`) |
| `CORS_ORIGINS` | Comma-separated origins for website and app |
| `API_KEY` | Optional; if set, requests must send `X-API-Key` |
| `JWT_SECRET` | Optional; for JWT auth later |
| `BANK_*` | Filled from bank docs (see above) |
| `BUSINESS_NAME`, `SUPPORT_EMAIL` | For receipts/support |

---

## Next steps

1. Fill in **project** details (origins, auth, business name, currencies).
2. Get **bank** docs and credentials (sandbox first).
3. Share the bank’s “create payment” and webhook format; we’ll implement the real integration in `src/services/paymentService.ts` and `src/routes/webhooks.ts`.

Until then, the API runs in **demo mode**: it returns mock `clientSecret` and accepts webhook calls so you can test your mobile and web flows.
