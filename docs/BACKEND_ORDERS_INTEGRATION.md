# Backend integration: Orders API & real-time updates

**Purpose:** So the Vorton web app order pages stay in sync with your backend, please implement the following. When a new order is created or updated, the frontend will show **SKU-Color**, **Size**, **Product name**, and all other fields automatically once your API and real-time events match this spec.

---

## Delivery and Order Tracking pages (for Backend awareness)

The web app has **Delivery and Order Tracking** pages used by **Staff** and **Managers** (and customers for their own orders). You don’t need to build these pages — they already exist in the frontend. Your part is:

1. **When a new order is created** (e.g. from payment/checkout): persist it and **emit the `order_created`** Socket.io event (see §4 below).  
   → Our app will then **automatically refresh** the Staff/Manager order list and order detail (Delivery and Order Tracking) so the new order appears without a manual reload.

2. **When an order’s status is updated**: after your `PATCH /orders/:id/status` (or any internal status change), **emit `order_status_updated`**.  
   → Our app will refresh the relevant order views so status and history stay up to date.

So: **you handle orders and events; we handle the UI.** Once your API and Socket.io events are in place, the Delivery and Order Tracking pages will update automatically when any new order arrives or an order is updated.

---

## 1. Frontend pages that consume orders

- **Staff order list:** `GET /orders` → list of orders (e.g. `/staff/orders`).
- **Staff order detail:** `GET /orders/:id` → single order with full item details (e.g. `/staff/orders/:id`).
- **Customer order list:** `GET /orders/customer/:customerId` → that customer’s orders (e.g. `/orders`).
- **Customer order detail:** same `GET /orders/:id` (e.g. `/orders/:id`).

All order and order-item fields below should be returned by these endpoints so the UI (including SKU-Color, Size, Product name) updates correctly.

---

## 2. Required API endpoints

Base URL is configured via `VITE_ORDERS_API_URL` or `VITE_API_BASE_URL` (e.g. `https://your-backend.com/api/v1`). All requests use `Authorization: Bearer <token>` and `Content-Type: application/json`.

| Method | Path | Who | Purpose |
|--------|------|-----|--------|
| GET | `/orders` | Staff | List all orders (for staff dashboard). |
| GET | `/orders/stats` | Staff | Counts by status for dashboard stats. |
| GET | `/orders/customer/:customerId` | Customer (own) / Staff | List orders for that customer. |
| GET | `/orders/:id` | Staff / Customer (own) | Single order with full details and status history. |
| PATCH | `/orders/:id/status` | Staff | Update order status (body: `{ "status": "PROCESSING" \| "DISPATCHED" \| "DELIVERED" }`). |

---

## 3. Response shapes

### 3.1 Order status

Must be exactly one of:

- `NEW`
- `PROCESSING`
- `DISPATCHED`
- `DELIVERED`

### 3.2 Order object (returned by GET `/orders/:id` and in list items)

```json
{
  "id": "string (unique order id)",
  "order_number": "string (e.g. VORT-2026-001)",
  "customer_id": 123,
  "customer_name": "string",
  "mobile": "string",
  "membership_level": "silver" | "gold" | "platinum" | "none",
  "address": "string or null",
  "items": [ /* see Order item below */ ],
  "total_price": 99.99,
  "status": "NEW" | "PROCESSING" | "DISPATCHED" | "DELIVERED",
  "order_date": "YYYY-MM-DD",
  "delivery_due_date": "YYYY-MM-DD or null",
  "created_at": "ISO 8601 datetime",
  "updated_at": "ISO 8601 datetime",
  "status_history": [ /* optional, see below */ ]
}
```

- **List responses** (`GET /orders`, `GET /orders/customer/:customerId`): same shape per order; `status_history` can be omitted for list view.
- **Single order** (`GET /orders/:id`): must include `status_history` when available.

### 3.3 Order item (each element of `order.items`)

**All of these fields are used on the order detail page. Please populate them from your catalog/checkout so SKU-Color, Size, and Product name update automatically.**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Product name (displayed as “Item”). |
| `quantity` | number | **Yes** | Quantity ordered. |
| `price` | number | **Yes** | Unit price. |
| `product_id` | string | No | Your product/variant id (for reference). |
| **`sku_color`** | string | No | **SKU–color code (e.g. `VORT-TWHT`, `VORT-SNVY`). Shown in “SKU-Color” column.** |
| **`size`** | string | No | **Size (e.g. `S`, `M`, `L`, `One Size`). Shown in “Size” column.** |

Backend can send either **snake_case** (`sku_color`, `product_id`) or **camelCase** (`skuColor`, `productId`); the frontend accepts both. Any extra fields are allowed and ignored.

Example item:

```json
{
  "name": "Classic T-Shirt White",
  "quantity": 2,
  "price": 29.99,
  "product_id": "prod-abc-123",
  "sku_color": "VORT-TWHT",
  "size": "M"
}
```

### 3.4 Status history (for GET `/orders/:id`)

```json
"status_history": [
  { "status": "NEW", "created_at": "2026-03-08T10:30:00Z" },
  { "status": "PROCESSING", "created_at": "2026-03-08T11:00:00Z" }
]
```

- `status`: one of the four statuses above.
- `created_at`: ISO 8601 datetime.

### 3.5 Stats (GET `/orders/stats`)

Response can be:

- `{ "stats": [ { "status": "NEW", "count": 5 }, { "status": "PROCESSING", "count": 3 }, ... ] }`

or equivalent; frontend expects an array of `{ status, count }` for each order status.

---

## 4. Real-time updates (Socket.io)

So that **new orders** and **status changes** appear without a manual refresh, the frontend connects to **Socket.io** on the **same origin** as the orders API (derived from `VITE_ORDERS_API_URL` / `VITE_API_BASE_URL`).

Please implement:

1. **Socket.io server** on the same host as the orders API (e.g. `https://your-backend.com`).
2. **Emit these events** (payload is optional; frontend only refetches data when it receives the event):
   - **`order_created`** — when a new order is created (e.g. after checkout/webhook). Frontend will refetch order list and, if the user is on an order page, relevant order data so new orders and details (SKU-Color, Size, Product name, etc.) appear automatically.
   - **`order_status_updated`** — when an order’s status is updated (e.g. after PATCH `/orders/:id/status` or internal process). Frontend will refetch so status and status history stay in sync.

No specific payload shape is required; the web app uses the events only as triggers to refetch from the REST API above.

---

## 5. Checklist for backend

- [ ] **GET `/orders`** returns an array of orders (each with `items` containing at least `name`, `quantity`, `price`; include **`sku_color`** and **`size`** when available).
- [ ] **GET `/orders/:id`** returns one full order including **`status_history`** and **`items`** with **`sku_color`** and **`size`** so the order detail page shows SKU-Color, Size, and Product name correctly.
- [ ] **GET `/orders/customer/:customerId`** returns the same order shape for that customer’s orders.
- [ ] **PATCH `/orders/:id/status`** accepts `{ "status": "PROCESSING" | "DISPATCHED" | "DELIVERED" }` and returns the updated order (and/or emits **`order_status_updated`**).
- [ ] On **new order creation** (e.g. from payment/checkout), backend emits **`order_created`** so the frontend can refetch and show the new order with all item info (SKU-Color, Size, Product name, etc.) automatically.
- [ ] Dates: **`order_date`**, **`delivery_due_date`** as `YYYY-MM-DD`; **`created_at`**, **`updated_at`**, and **`status_history[].created_at`** as ISO 8601.

Once the above is in place, the web app will link to your backend and all information (SKU-Color, Size, Product name, status, etc.) will update automatically when a new order is received or an order is updated.
