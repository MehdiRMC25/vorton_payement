# Staff login accounts (employees & managers)

**File to edit:** `config/staff-accounts.json` in this project (or the path set in `STAFF_ACCOUNTS_FILE` env).

This file defines which logins can sign in at the **staff login page** (e.g. `http://localhost:5173/staff/login`) and with which role:

- **employee** – can see all orders and update order status (processing / dispatched / delivered).
- **manager** – can see all orders, update status, and view statistics.

After you change this file, **restart the backend** so it syncs these accounts into the database. Staff then sign in with **email + password** using the same login API as customers (`POST /api/v1/auth/login`).

## Format

JSON array of objects:

```json
[
  {
    "email": "employee@example.com",
    "password": "your-secret-password",
    "role": "employee"
  },
  {
    "email": "manager@example.com",
    "password": "another-secret",
    "role": "manager"
  }
]
```

- **email** – used to sign in (required).
- **password** – plain text here; the backend hashes it on sync (required).
- **role** – must be `"employee"` or `"manager"`.

To add or remove staff, edit this file and restart the backend.

## Custom path

Set the environment variable:

```bash
STAFF_ACCOUNTS_FILE=/absolute/path/to/your-staff.json
```

Default path: `config/staff-accounts.json` (relative to the project root where the backend runs).
