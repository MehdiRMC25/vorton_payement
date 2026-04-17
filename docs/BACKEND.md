# Payment backend — API & checkout design

Single API for website and mobile. **Amounts charged through Kapital are settled in AZN**; multi-currency on the storefront is display-only unless noted.

**Base URL:** `https://<host>` + **`API_PREFIX`** (default **`/api/v1`**).

---

## 1. Configuration

### 1.1 Core environment (`src/config.ts`)

| Variable | Role |
|----------|------|
| `PORT` | HTTP port (default `3000`) |
| `API_PREFIX` | Route prefix (default `/api/v1`) |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `API_KEY` | If set, required for **`/payments`** (`X-Api-Key` or `?apiKey=`) |
| `JWT_SECRET` / `AUTH_SECRET` | Session / JWT for customer auth |
| `DATABASE_URL` or `PGHOST` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | PostgreSQL |
| `KAPITAL_BASE_URL`, `KAPITAL_USERNAME`, `KAPITAL_PASSWORD` | Kapital Bank e-commerce API |
| `CALLBACK_URL` | Bank callback base (payment return) |
| `MONGODB_URI` | Products catalog (optional) |
| Email vars | Staff + customer SMTP (see `config.ts`) |

### 1.2 Shipping overrides (optional env)

These override **defaults in code**; restart after change.

| Variable | Default (code) | Meaning |
|----------|----------------|---------|
| `INTERNATIONAL_SHIPPING_FEES_FILE` | `config/international-shipping-fees.json` | Path to per-country fee JSON |
| `SHIPPING_COUNTRY_ALIASES_FILE` | `config/shipping-country-aliases.json` | Country name → ISO2 aliases |
| `SHIPPING_AZN_PER_USD` | `1.7` | AZN per 1 USD (settlement + domestic USD quote) |
| `SHIPPING_AZN_PER_GBP` | `2.3` | AZN per 1 GBP (domestic GBP quote) |
| `SHIPPING_GBP_PER_USD` | `0.7429` | International **display**: GBP per 1 USD (independent of AZN/USD pair) |
| `SHIPPING_BAKU_FEE_AZN` | `5` | Azerbaijan — Baku, settled AZN |
| `SHIPPING_AZ_OTHER_FEE_AZN` | `10` | Azerbaijan — not Baku, settled AZN |
| `SHIPPING_INTL_EXTRA_USD_PER_ADDITIONAL_ITEM` | `6` | Fallback **USD per extra merchandise unit** (after first) when not set in JSON |

**Committed defaults:** Edit fallbacks in `src/config.ts` and commit; use env on Render only if you need a runtime override without redeploy.

---

## 2. Checkout totals (source of truth)

Authoritative logic lives in:

- `src/services/checkoutTotalsService.ts` — membership, points, shipping, **`payableTotalAzn`**
- `src/services/shippingPolicy.ts` — zones + international math
- `src/services/internationalShippingFeesStore.ts` — loads `international-shipping-fees.json`

**Clients must not invent parallel totals:** use **`POST /checkout/preview`** or **`POST /checkout/preview-guest`** and send the same **`items`** + shipping fields on **`payments/create`** → **`order`**.

### 2.1 Merchandise lines

- **`price`** — list/catalog where applicable; promos use **`discountedPrice`** / flags (not membership baked into list price).
- **`product_id === '__delivery__'`** — shipping line; merchandise loops ignore it for subtotals; **policy shipping** replaces client delivery amounts when country + currency are sent.

---

## 3. Shipping

### 3.1 Azerbaijan

- **Baku** — city matches Baku variants (`baku`, `baki`, `bakı`, `баку`, …); settled fee from `SHIPPING_BAKU_FEE_AZN`.
- **Rest of Azerbaijan** — country is Azerbaijan but city is not Baku; settled fee from `SHIPPING_AZ_OTHER_FEE_AZN`.
- **Display (USD/GBP)** — derived from settled AZN using `SHIPPING_AZN_PER_USD` / `SHIPPING_AZN_PER_GBP`.

No per-item international surcharge for Azerbaijan in this design.

### 3.2 International (non-Azerbaijan)

1. **Base fee USD** per ISO country from **`config/international-shipping-fees.json`** (`feeUsd` per row). **`feeUsd: null`** → delivery **not available** to that country.

2. **Per extra unit (merchandise quantity after the first)**  
   - **Units** = sum of **`quantity`** on all lines **except** `__delivery__`.  
   - **Surcharge USD** = `extraPerUnit × max(0, units − 1)`.

3. **Resolved `extraPerUnit` (priority)**  
   - Country row: **`extraUsdPerAdditionalUnit`**  
   - Else file root: **`defaultExtraUsdPerAdditionalUnit`**  
   - Else **`SHIPPING_INTL_EXTRA_USD_PER_ADDITIONAL_ITEM`** / `config.shipping.intlExtraUsdPerAdditionalUnit` (default **6**).

4. **Total international shipping USD** = `baseUsd + surchargeUsd`, then **settled to AZN** with **`SHIPPING_AZN_PER_USD`**.

5. **Display**  
   - **USD checkout:** show total USD fee.  
   - **GBP checkout:** `totalUsd × SHIPPING_GBP_PER_USD` (international GBP path is independent of the AZN/USD rate).  
   - **AZN:** settled amount in AZN.

### 3.3 Policy vs cart lines

If **`delivery_country`** and **`checkout_currency`** are present and valid, shipping comes **from policy** (not summing `__delivery__` prices). If incomplete, shipping falls back to summing **`__delivery__`** lines in the cart.

### 3.4 Unavailable country

When **`feeUsd`** is **`null`** for a country, preview / payment validation respond with **`400`** and payload including **`code: "SHIPPING_UNAVAILABLE"`** and a user-facing message. No payment should proceed.

---

## 4. Checkout API

### 4.1 `POST {API_PREFIX}/checkout/preview`

- **Auth:** Bearer JWT (membership + points).
- **Body (JSON):**  
  - **`items`** — cart lines (same shape as order)  
  - **`points_to_redeem`** (optional)  
  - **`delivery_city`**, **`delivery_country`**, **`checkout_currency`** (`AZN` | `USD` | `GBP`) — for shipping policy  
  - CamelCase aliases supported: `deliveryCity`, `deliveryCountry`, `checkoutCurrency`.

### 4.2 `POST {API_PREFIX}/checkout/preview-guest`

- **Auth:** none.
- **Body:** same as above except **no points** (or `points_to_redeem` must be 0); membership treated as none.

### 4.3 Success response — `breakdown` (representative fields)

| Field | Meaning |
|-------|---------|
| `payableTotalAzn` | **Charge this in AZN** (matches payment `amount` / `order.total_price`) |
| `shippingAzn` | Shipping portion in AZN |
| `shippingQuoteAmount` / `shippingQuoteCurrency` | Display quote for selected checkout currency |
| `shippingInternationalFeeUsd` | International **total** USD (base + per-unit surcharge) when applicable |
| `shippingInternationalBaseFeeUsd` | Base USD from JSON |
| `shippingInternationalSurchargeUsd` | Extra USD from `(units − 1) × per-unit rate` |
| `shippingInternationalExtraUsdPerUnit` | Resolved USD per extra unit for that destination |
| `shippingMerchandiseUnits` | Sum of merchandise quantities |
| `shippingZone` | `baku` \| `azerbaijan_other` \| `international` |
| `shippingCountryIso2` | Resolved ISO2 when possible |
| `membershipDiscountAzn`, `pointsDiscountAzn`, … | As computed |

### 4.4 Error — shipping unavailable

`400` JSON includes e.g. **`code: "SHIPPING_UNAVAILABLE"`**, **`countryIso2`**, **`message`**.

---

## 5. Payments

### 5.1 `POST {API_PREFIX}/payments/create`

- **Middleware:** `apiKeyAuth` — if `API_KEY` is set, send header **`X-Api-Key`** (or query `apiKey`).
- **Body:** `amount`, `currency` (typically **`AZN`** for settlement), optional Kapital fields, optional **`order`** — **`PendingOrderPayload`**.

When **`order`** is present:

- Server runs **`validatePaymentAmountForOrder`**: recomputes checkout breakdown from **`order.items`**, **`order.customer_id`**, **`points_to_redeem`**, **`delivery_city`**, **`delivery_country`**, **`checkout_currency`** and checks **`amount`** (and **`order.total_price`**) against **`payableTotalAzn`**.  
- Mismatch → **`400`** with structured error (e.g. `PAYMENT_AMOUNT_MISMATCH`).

**`order` must include** the same shipping fields used for preview so totals match.

### 5.2 `GET {API_PREFIX}/payments/confirm`

Kapital redirect: verifies payment and, on success, may **create the order** from stored payload.

---

## 6. Orders

- **`GET {API_PREFIX}/orders`** — staff (JWT + role).  
- **`POST {API_PREFIX}/orders`** — create order (requires `customer_id`, etc. per controller); payment-led creation is usually via **payment confirm**.

Guest orders: **`customer_id`** may be null when schema allows; contact fields on **`orders`** row.

---

## 7. Config files (repo)

| File | Purpose |
|------|---------|
| `config/international-shipping-fees.json` | Per-country **`feeUsd`**, optional **`extraUsdPerAdditionalUnit`**, optional **`defaultExtraUsdPerAdditionalUnit`**, **`defaultFeeUsd`** |
| `config/shipping-country-aliases.json` | Name → ISO2 for resolving `delivery_country` |
| `config/staff-accounts.json` | Staff logins (optional) |

**Restart the server** after editing JSON.

---

## 8. PDF / Word

This file is **Markdown**. Open in VS Code / Cursor, or import into **Word** / **Google Docs**, then **Export as PDF**.

---

## 9. Key source files

| Area | Files |
|------|--------|
| Entry & routes | `src/index.ts`, `src/routes/*.ts` |
| Config | `src/config.ts` |
| Checkout preview | `src/controllers/checkoutController.ts`, `src/routes/checkout.ts` |
| Totals | `src/services/checkoutTotalsService.ts`, `src/services/shippingPolicy.ts` |
| International fees | `src/services/internationalShippingFeesStore.ts`, `config/international-shipping-fees.json` |
| Payment validation | `src/services/paymentOrderValidation.ts`, `src/controllers/paymentController.ts` |
| Orders | `src/services/orderService.ts`, `src/controllers/orderController.ts` |
