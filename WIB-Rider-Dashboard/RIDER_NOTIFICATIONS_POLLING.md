# Rider notifications (HTTP polling)

Simple in-app alerts for the **WIB Rider Dashboard**: poll every **10s** (or **45s** when the browser tab is hidden), show **react-toastify** toasts, play **one** short sound per batch, then mark items read on the server. No WebSockets or Socket.IO.

## Backend (WIB-Rider-Backend)

Files:

- `services/riderNotification.service.js` — in-memory store (no DB table; use a **single** API Node process, or notifications may look empty under PM2 cluster / multiple instances)
- `lib/dashboardRiderNotify.js` — fan-out to every **active** `mt_admin_user` (dashboard dispatchers)
- `controllers/riderNotifications.controller.js`
- `routes/riderNotifications.routes.js`
- `middleware/riderNotificationAuth.js` — sets `req.riderId` from `req.adminUser` (dashboard session)

**Automatic notifications** (toast + sound on the dashboard when those admins poll): new food task (`POST /tasks`), task assign, task status changes from admin or driver (`ChangeTaskStatus`), assign-all / retry-auto-assign, errand assign + errand status (admin), errand accept + errand status (driver app). *Brand-new errand orders created only inside ErrandWib (no call through this API) are not notified until an event above runs (e.g. driver accepts).*

Mounted under the existing **`/admin/api`** router (after `adminAuth`), so the browser still uses the dashboard proxy **`/api/...`**.

| Method | Path | Auth |
|--------|------|------|
| GET | `/admin/api/rider/notifications` | `x-dashboard-token` |
| POST | `/admin/api/rider/notifications/mark-viewed` | JSON `{ "notificationIds": ["id1", ...] }` |
| POST | `/admin/api/dev/create-notification` | Non-production by default, or set `ALLOW_DEV_NOTIFICATIONS=1` |
| POST | `/admin/api/internal/notify-task-status` | **Server-to-server only:** `x-admin-key: ADMIN_SECRET`. JSON `{ "task_id": 123, "status_raw": "inprogress" }`. Optional `actor_display_name` or `driver_id`. Used when legacy Yii/PHP updates `driver_task` without calling Node `ChangeTaskStatus`. |

`riderId` is always the logged-in **admin**’s `admin_id` (named “rider” in the API contract). It is **never** taken from the client body.

### Run & test (API)

1. Start the rider backend: `cd WIB-Rider-Backend && npm run dev`
2. Log in on the dashboard to obtain a session token.
3. Create a test notification (development):

```bash
curl -s -X POST http://localhost:3000/admin/api/dev/create-notification ^
  -H "Content-Type: application/json" ^
  -H "x-dashboard-token: YOUR_TOKEN_HERE" ^
  -d "{\"title\":\"New task\",\"message\":\"Pickup ready\",\"type\":\"task\"}"
```

4. Poll unread:

```bash
curl -s http://localhost:3000/admin/api/rider/notifications -H "x-dashboard-token: YOUR_TOKEN_HERE"
```

## Frontend (WIB-Rider-Dashboard/client)

- `src/hooks/useNotifications.js` — polling, dedupe, toast, sound, mark-viewed
- `src/services/notificationApi.js`
- `src/components/NotificationBell.jsx`, `NotificationPanel.jsx`, `NotificationMuteToggle.jsx`
- `public/fb-alert.mp3` — notification sound (`useNotifications.js` uses `import.meta.env.BASE_URL`)
- Sound preference: localStorage **`drv_sound_on`** — `1` = on, `2` = off (default on)

`ToastContainer` is mounted in `App.jsx`.

### Run

1. Backend on port **3000**, dashboard Node proxy on **3002** (or your `PORT`).
2. `cd WIB-Rider-Dashboard/client && npm run dev`
3. Open the dashboard, log in; use the bell icon. In dev, trigger `dev/create-notification` as above and wait for the next poll (≤10s).

## Upgrading later

Replace `riderNotification.service.js` with DB queries keyed by `admin_id` (or real rider id), keep the same route shapes and JSON so the React hook stays unchanged.
