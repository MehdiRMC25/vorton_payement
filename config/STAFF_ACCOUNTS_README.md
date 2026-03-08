# Staff login accounts (Employee & Manager)

**File to edit:** `config/staff-accounts.json` (or the path in `STAFF_ACCOUNTS_FILE`).

Two roles only: **employee** (you can show as “Staff” in the UI) and **manager**. Each account is a different person with their own **first_name**, **last_name**, **email**, and **password**; all are stored in Postgres after sync. Restart the backend or run `npm run sync-staff` after editing the file.

## Format

```json
[
  {
    "first_name": "Gulnara",
    "last_name": "Habisheva",
    "email": "gulnara.habisheva@example.com",
    "password": "your-secret-password",
    "role": "employee"
  },
  {
    "first_name": "Mehdi",
    "last_name": "Taghiyev",
    "email": "mehdi.taghiyev@example.com",
    "password": "another-password",
    "role": "manager"
  }
]
```

- **first_name**, **last_name** – Optional; stored in Postgres and shown in the app. If omitted, sync uses "Staff" and the role.
- **email** – Required; used to sign in.
- **password** – Required; plain text here; the backend hashes it and stores in Postgres.
- **role** – **`"employee"`** or **`"manager"`** only.

## Upload staff to Postgres (manual sync)

If the file was not on the server at startup (e.g. SSL blocks sync from your machine), run from project root:

```bash
npm run sync-staff
```

Your `.env` must have `DATABASE_URL` (or PGHOST, etc.) pointing at the same Postgres as the backend.

## Custom path

Set `STAFF_ACCOUNTS_FILE` to the full path of your JSON file. Default: `config/staff-accounts.json` relative to the project root.
