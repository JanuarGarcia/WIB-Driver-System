# WIB Rider Dashboard

Node.js dashboard for **assigning tasks to drivers** without touching the live WIB rider dashboard. It talks to your existing **WIB Rider Backend** API.

**New admin user?** Step-by-step usage, screen tour, and troubleshooting: [ADMIN_GUIDE.md](./ADMIN_GUIDE.md).

## Setup

1. Copy `.env.example` to `.env` and set:
   - `BACKEND_URL` – **origin of WIB Rider Backend only** (e.g. `http://localhost:3000` or `http://127.0.0.1:3000` on the VPS). Do **not** use the dashboard’s own public URL, cPanel home, or a path like `/admin/api` (trailing `/admin/api` is stripped automatically, but the host must be the Node API).
   - `ADMIN_SECRET` – (optional) same as in the backend if you use admin API key
   - `DASHBOARD_PORT` – port for this app (default `3002`)

2. Install and run:

```bash
cd "WIB Rider Dashboard"
npm install
npm start
```

3. Open the dashboard in the browser (default **http://localhost:3002** unless you set `DASHBOARD_PORT` or `PORT`).

## Live deployment (cPanel / Apache)

If the dashboard is served by Apache and the Node app runs separately, requests to `/api` can return HTML (e.g. the SPA’s `index.html`) instead of JSON, so Settings save fails with “Server returned HTML instead of JSON.”

**Fix:** Deploy the included **`.htaccess`** in the **document root** for the dashboard domain (same folder as your deployed app). It proxies `/api` and `/uploads` to the Node server so API calls hit the app.

- **Port:** `.htaccess` uses `127.0.0.1:3002` by default. If your Node app runs on another port (e.g. the one cPanel assigns), edit `.htaccess` and change `3002` to that port.
- If you get a 500 error, your host may not allow proxy in `.htaccess`. Then either run the Node app as the main handler for the domain (so it receives all requests) or ask the host to add a proxy for `/api` to your Node port in the server config.

After deploying `.htaccess`, restart the Node app and try saving Settings again.

### “API returned a web page instead of JSON” (drivers, settings, etc.)

The dashboard Node app proxies `/api/*` → `BACKEND_URL/admin/api/*`. If `BACKEND_URL` points at Apache/cPanel, the dashboard domain, or a dead port, the proxy gets **HTML** and the UI shows that error.

**Fix:** On the server where the **dashboard** Node process runs, set `BACKEND_URL` to wherever **WIB-Rider-Backend** listens (check that app’s port in cPanel “Node.js” or `server.js`). Typical same-server value: `http://127.0.0.1:3000`. After restart, the dashboard logs `Backend /health: OK` if the URL is correct.

## Features

- **Dashboard** – driver stats (total, active, offline)
- **Tasks** – list tasks, assign unassigned tasks to a driver (calls backend `PUT /admin/api/tasks/:id/assign`)
- **Drivers** – list drivers

All data comes from the WIB Rider Backend; this app does not use the live PHP dashboard or database directly.
