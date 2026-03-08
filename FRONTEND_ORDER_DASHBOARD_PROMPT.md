# Frontend prompt: Order Operations & Tracking Dashboard

Use this prompt in your **frontend** project (or with Cursor on the frontend codebase) to build a dashboard that connects to the existing payment/orders backend.

---

## Copy-paste prompt for Cursor / frontend

Build an **Order Operations and Tracking** dashboard that connects to our existing backend.

### Backend base URL
- **API base:** `VITE_API_URL` or `NEXT_PUBLIC_API_URL` (or similar) — e.g. `http://localhost:3000/api/v1` in development. The backend runs on a configurable port (default 3000).
- **Same origin for Socket.io:** The backend serves both REST and Socket.io on the **same port**. So if the API is `http://localhost:3000`, the Socket.io client should connect to `http://localhost:3000` (no separate path).

### Authentication
- **Login:** `POST {API_BASE}/auth/login`  
  Body: `{ "email" or "phone" or "mobile": "<value>", "password": "<value>" }`  
  Response: `{ "user": { id, role, first_name, last_name, email, phone, ... }, "token": "<jwt>" }`
- **Signup:** `POST {API_BASE}/auth/signup`  
  Body: signup fields as required by backend.  
  Response: `{ "user", "token" }` (same shape).
- **Current user:** `GET {API_BASE}/auth/me`  
  Header: `Authorization: Bearer <token>`  
  Response: `{ "user": { id, role, ... } }`
- **Send JWT on all order API calls:** `Authorization: Bearer <token>`
- **Roles:** `customer` | `employee` | `manager` (from `user.role`). You can show “Staff” in the UI for `employee`.

### Order API (all under `{API_BASE}/orders`)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/orders` | employee, manager | List all orders. Response: `{ "orders": [ ... ] }` |
| GET | `/orders/stats` | manager | Status counts. Response: `{ "stats": [ { "status", "count" } ] }` |
| GET | `/orders/customer/:customerId` | customer (own id), employee, manager | Orders for that customer. Response: `{ "orders": [ ... ] }` |
| GET | `/orders/:id` | customer (own only), employee, manager | Single order full details (includes `status_history`). |
| POST | `/orders` | no auth | Create order (checkout). See body below. |
| PATCH | `/orders/:id/status` | employee, manager | Update status. Body: `{ "status": "PROCESSING" \| "DISPATCHED" \| "DELIVERED" }` |

**Order object shape (from API):**
```json
{
  "id": "uuid",
  "order_number": "string",
  "customer_id": number,
  "customer_name": "string",
  "mobile": "string",
  "membership_level": "silver|gold|platinum|none",
  "address": "string | null",
  "items": [ { "name", "quantity", "price", "product_id?", ... } ],
  "total_price": number,
  "status": "NEW|PROCESSING|DISPATCHED|DELIVERED",
  "order_date": "date",
  "delivery_due_date": "date | null",
  "created_at": "datetime",
  "updated_at": "datetime",
  "status_history": [ { "status", "created_at" } ]  // only on GET /orders/:id
}
```

**POST /orders body (create order at checkout):**
```json
{
  "customer_id": number,
  "customer_name": "string",
  "mobile": "string",
  "membership_level": "string (default: none)",
  "address": "string | null",
  "items": [ { "name": "string", "quantity": number, "price": number } ],
  "total_price": number,
  "delivery_due_date": "string | null (YYYY-MM-DD)"
}
```
Required: `customer_id`, `customer_name`, `mobile`, `total_price` (non-negative). `items` is an array (can be empty).

### Real-time (Socket.io)
- **Connect:** Same origin as the API, e.g. `io(API_ORIGIN)` where `API_ORIGIN` is `http://localhost:3000` (no `/api/v1`).
- **Events to listen for:**
  - `order_created` — payload: full order object (new order).
  - `order_status_updated` — payload: full order object (status changed).
- When these fire, update the dashboard list/detail view (e.g. refetch list, or merge the payload into local state) so employees and managers see live updates.

### Staff login page
- **URL:** `http://localhost:5173/staff/login?returnTo=%2Fstaff` (or your frontend origin + `/staff/login?returnTo=%2Fstaff`).
- Staff sign in with **email + password** using the same API: `POST {API_BASE}/auth/login` with body `{ "email": "...", "password": "..." }`.
- Accounts are in **`config/staff-accounts.json`**: **first_name**, **last_name**, **email**, **password**, **role** (`employee` or `manager`). Synced to Postgres on startup or via `npm run sync-staff`. Login response includes `user` (id, role, first_name, last_name, email, ...) and `token`.

### Access control and UIs (three distinct experiences)
- **Customers** (role `customer`): Do **not** use the staff login page. They sign in on the main site and see **delivery and tracking** in their own account: “My orders” list, order detail, and tracking status. Use `GET /orders/customer/{user.id}`. They can only see their own orders.
- **Employee** (role `employee`): Sign in at the staff login page. Can list orders, view detail, update status. Show as “Staff” in the UI if you like. Use `user.first_name`, `user.last_name` for their name.
- **Manager** (role `manager`): Same as employee plus access to `GET /orders/stats` (statistics).

### What to build
1. **Staff login:** Page at `/staff/login?returnTo=%2Fstaff` that posts email + password to `POST {API_BASE}/auth/login`, stores JWT and `user`, then redirects to `/staff`. Show staff dashboard when `user.role` is `employee` or `manager`; you can label employee as "Staff" in the UI.
2. **Customer account:** In the main app (not staff), customers see “My orders” and delivery/tracking for their own orders only.
3. **Employee / Manager UI:** Employee: orders list, order detail, status updates. Manager: same plus statistics. Use `user.first_name`, `user.last_name` for display (each person has their own name/email/password in Postgres). Real-time updates via Socket.io.
4. **Real-time:** Connect Socket.io; on `order_created` and `order_status_updated`, refresh or merge data so the staff dashboard updates without reload.

### Environment
- Frontend needs at least:
  - `API_BASE` or `VITE_API_URL` / `NEXT_PUBLIC_API_URL` = `http://localhost:3000/api/v1`
  - `API_ORIGIN` or same for Socket.io = `http://localhost:3000`
- Backend CORS already allows configured origins (e.g. localhost); ensure the frontend origin is included in the backend’s `CORS_ORIGINS` env.

---

*Backend repo: payment_backend (Node.js + Express + PostgreSQL + JWT + Socket.io). Orders and auth are implemented; this prompt describes how to consume them from the frontend.*
