# Reward points policy (internal reference only)

**Do not surface this file in the app UI.** Customer-facing copy lives in `src/data/rewardPolicy.public.md`. Website earn **estimates**: `src/lib/rewardPointsEarn.ts` (used by checkout UI). Redemption helpers: `src/lib/rewardPointsRedemption.ts` (keep in sync with payment backend / PostgreSQL).

## Earning (eligible purchase amount in USD)

- 0–72 USD → 2% back in points
- 72–180 USD → 3.5% back in points
- 180+ USD → 5% back in points

**Conversion:** 1 USD reward value = 11 points.

Example: 200 USD eligible at 5% → 10 USD reward value → 110 points.

**Notes:**
- Eligible purchase amount excludes: delivery/shipping fees, additional services, non-eligible items, and any discounted/promotional items.
- Points are earned on full-price items only.
- Points are calculated per order and rounded down to nearest whole point.
- Reward rates are intentionally conservative to protect premium positioning.

## Redemption

- Points can be applied as a discount at checkout via “Use my points”.
- 11 points = 1 USD discount value (converted to AZN at checkout).
- Points may be redeemed in full or in part.
- Points are applied to the total purchase amount excluding delivery/shipping fees.
- The maximum redemption value of points per order is limited to 50% of the eligible purchase amount.
- Partial redemption is allowed.
- Points expire after 12 months (rolling basis, enforced server-side).

## Exclusions

- No points earned on discounted or promotional line items.
- No points earned on delivery fees or additional services.

## Membership levels (based on cumulative lifetime spend)

### Silver (0–2,999 USD)
- 3% discount on regular-price items
- Early access to new collections

### Gold (3,000–7,199 USD)
- 5% discount on regular-price items
- Early access to new collections
- Early access to promotions

### Platinum (7,200–11,999 USD)
- 8% discount on regular-price items
- Early access to new collections
- Early access to promotions
- Priority customer support

### Platinum+ (12,000+ USD)
- 10% discount on regular-price items
- Early access to new collections
- Early access to promotions
- Priority customer support
- Exclusive member-only offers

## Membership rules

- Membership tier is calculated based on cumulative lifetime spend.
- Tier upgrades apply automatically after threshold is reached.
- Discounts apply to regular-price items only.
- Membership discounts do not stack with other promotions.

## Exclusions on membership benefits

- Membership discounts do not apply to discounted or promotional items.
- Membership discounts do not stack with other promotions.
- Promotions, discounts, and points cannot be combined on the same item.

## Implementation notes

- Storefront/order totals are in **AZN**; earning tiers and redemption value are defined in **USD**.
- Backend uses `REWARD_AZN_PER_USD` (default 1.7) to convert USD↔AZN. If the FX rate changes, update that env var on the backend and keep frontend “estimate” copy in sync.
- Always persist reward transactions (earn/redeem/expire) in a dedicated table.
- Never delete reward history (append-only ledger).
- Orders must remain immutable for audit and reporting.
- All calculations must be validated server-side (never trust client input).

## Server truth (auth, payment, membership)

Full contract and payement-backend alignment: **`docs/server-truth-payment.md`**.

**Summary:** Coordinate with payement-backend: read tier from `GET /api/v1/auth/me` → **`membership`**; send order lines with the same flags/prices the backend validates; treat membership discount as **server-authoritative** once the API recomputes totals (including `membership_discount_azn`) and rejects mismatched `total_price`. Until then, the website breakdown is UX-only for membership and totals.