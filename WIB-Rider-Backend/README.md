# WIB Rider Backend

Node.js backend for the **WIB Driver App** (Flutter). Driver API, admin API, MySQL, FCM push. This repo is in a **separate folder** from the app:

- **WIB Driver App** – Flutter app (sibling folder)
- **WIB Rider Backend** – this folder

## Prerequisites

- **Node.js** 18+
- **MySQL** on localhost
- (Optional) **Firebase** service account JSON for FCM

## Setup

1. **Install dependencies**
   ```bash
   cd "WIB Rider Backend"
   npm install
   ```

2. **Environment**  
   Copy `.env.example` to `.env` and set `DB_*`, `API_HASH_KEY`, optional `FIREBASE_SERVICE_ACCOUNT_PATH`.  
   **Dashboard login:** If the Rider Dashboard login uses `mt_admin_user` in a different database (e.g. `wibdb`), set `DB_NAME=wibdb` in `.env` so the backend connects to that database.

3. **Create database and tables**
   ```bash
   npm run init-db
   ```

4. **Create a test driver**
   ```bash
   node -r dotenv/config scripts/create-driver.js driver1 driver1
   ```

5. **Start the server**
   ```bash
   npm start
   ```
   - Driver API: `http://localhost:3000/driver/api`
   - Admin API: `http://localhost:3000/admin/api`

## Pointing the WIB Driver App to this backend

In the **WIB Driver App** folder, set the API base URL to this backend (no `/driver/api` in the URL; the app adds it):

- In `.env`: `API_BASE_URL=http://localhost:3000` (or your PC’s LAN IP for a real device)
- Optional: `DRIVER_API_KEY=GodissoGood@33` (must match backend `API_HASH_KEY`)

## Mangan customer push notifications (auto-push on status updates)

Mangan orders live in **ErrandWib** (`st_ordernew`). When a driver accepts an errand/Mangan order or updates its delivery status via:

- `POST /driver/api/AcceptErrandOrder`
- `POST /driver/api/ChangeErrandOrderStatus`

this backend can optionally **mirror** that transition to the legacy Mangan PHP Driver API (the same endpoints in the Postman “Driver API Collection”, e.g. `/driver/acceptorder`, `/driver/orderpickup`, `/driver/orderdelivered`). That legacy API is the system that sends **customer push notifications** for the old Mangan customer app.

To enable it:

- **Env**: set `MANGAN_DRIVER_SYNC_ENABLED=1`
- **Base URL**: (optional) `MANGAN_DRIVER_API_BASE_URL=https://order.wheninbaguioeat.com`
- **API key**: if the Mangan backoffice “API Access” page shows a mobile API key, you can set `MANGAN_DRIVER_API_KEY`. The current default follows the working Postman collection: `/driver/login` uses only JSON `username` and `password`. Only turn on `MANGAN_DRIVER_SEND_API_KEY_ON_LOGIN=1` or `MANGAN_DRIVER_SEND_API_KEY_ON_ACTIONS=1` if the live API specifically requires `api_key` on those calls.
- **Credentials** (recommended): run `sql/st_driver_wib_sync_credentials.sql` on the ErrandWib / Mangan DB and set `st_driver.wib_sync_username` + `st_driver.wib_sync_password` for each rider.
- **Primary DB fallback credentials**: if you already store the Mangan rider login on the WIB primary DB, run `sql/mt_driver_mangan_credentials.sql` and set `mt_driver.mangan_api_username` + `mt_driver.mangan_api_password`. The sync now uses those when `st_driver` does not have explicit WIB sync credentials.
- **Dev-only fallback login**: alternatively set `MANGAN_SYNC_FALLBACK_USERNAME` / `MANGAN_SYNC_FALLBACK_PASSWORD` (only works if that Mangan driver is assigned to the order, because the PHP API verifies `driver_id`).

Notes:

- **No-op protection**: the errand status update rejects unchanged states (and the Mangan API also rejects “same as current”), so pushes fire only on real transitions.
- **Don’t break delivery updates**: the Mangan sync is fire-and-forget and never blocks saving the status update in ErrandWib.
- **Custom status→action map**: if your canonical status ladder differs, set `MANGAN_SYNC_STATUS_MAP_JSON` (see `.env.example`).

## Deploy on cPanel / A2 (Git “Deploy HEAD Commit”)

The **monorepo root** (`WIB-Driver-System`) includes **`.cpanel.yml`**, which copies **`WIB-Rider-Backend/`** into your Node **Application root** and runs **`npm install --omit=dev`**.

1. In **cPanel → Setup Node.js App**, open the rider API app and copy the full **Application root** path (the directory that already contains `package.json` and `server.js`).
2. Edit **`.cpanel.yml`** at the repo root: set **`DEPLOYPATH=`** to that path (replace `/home/wheninba/nodeapps/rider-api` if yours differs). Commit and push.
3. If cPanel says **“No uncommitted changes”** / deploy disabled: **Terminal** → `cd` to the **Repository path** (e.g. `/home/wheninba/repositories/WIB-Driver-System`) → run `git status`. Either **`git stash`** or **`git reset --hard origin/main`** (discards server-only edits), then **Update from Remote** and **Deploy HEAD Commit** again.
4. **Restart** the Node app in **Setup Node.js App** after a successful deploy.

Without Git deploy: SSH into **Application root**, `git pull`, `npm install --omit=dev`, then restart the app.

## API summary

- **Driver API** (`/driver/api`): Login, Register, GetAppSettings, GetProfile, UpdateProfile, UpdateVehicle, ChangeDutyStatus, UpdateDriverLocation, GetTaskByDate, GetTaskDetails, ChangeTaskStatus, reRegisterDevice, joinQueue, leaveQueue, queuePosition, GetNotifications, ClearNotifications, ForgotPassword, ChangePassword, Logout, UploadProfilePhoto. All POST, form-urlencoded; response `{ code, msg, details }`.
- **Rider registration toggle**: dashboard setting `enabled_signup` controls whether the rider app should show Register. `POST /driver/api/GetAppSettings` now returns `show_register_button`, `allow_signup`, `enabled_signup`, `signup_status`, and `signup_target: "mt_driver"`.
- **Rider accounts** use **`mt_driver`** (username/password). Optional **`password_bcrypt`** for new vs old rider app compatibility — see [docs/RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md](./docs/RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md) and **`npm run migrate-mt-driver-password-bcrypt`**.
- **Optional** `mt_client` email login: set **`DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`** and migrate **`mt_driver.client_id`**; see [docs/DRIVER_LOGIN_UNIFIED_ACCOUNTS.md](./docs/DRIVER_LOGIN_UNIFIED_ACCOUNTS.md) and **`POST /admin/api/drivers/promote-from-client`**.
- **Admin API** (`/admin/api`): GET/PUT settings, GET stats/drivers, GET drivers/locations, GET/POST tasks, PUT tasks/:id/assign, GET drivers, POST drivers/promote-from-client, GET push-logs.

See README in this folder for full endpoint list and database schema.
