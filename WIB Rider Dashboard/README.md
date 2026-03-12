# WIB Rider Dashboard

Node.js dashboard for **assigning tasks to drivers** without touching the live WIB rider dashboard. It talks to your existing **WIB Rider Backend** API.

## Setup

1. Copy `.env.example` to `.env` and set:
   - `BACKEND_URL` – URL of WIB Rider Backend (e.g. `http://localhost:3000`)
   - `ADMIN_SECRET` – (optional) same as in the backend if you use admin API key
   - `DASHBOARD_PORT` – port for this app (default `3001`)

2. Install and run:

```bash
cd "WIB Rider Dashboard"
npm install
npm start
```

3. Open **http://localhost:3001** in the browser.

## Features

- **Dashboard** – driver stats (total, active, offline)
- **Tasks** – list tasks, assign unassigned tasks to a driver (calls backend `PUT /admin/api/tasks/:id/assign`)
- **Drivers** – list drivers

All data comes from the WIB Rider Backend; this app does not use the live PHP dashboard or database directly.
