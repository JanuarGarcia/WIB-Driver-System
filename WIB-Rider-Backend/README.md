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

## API summary

- **Driver API** (`/driver/api`): Login, GetAppSettings, GetProfile, UpdateProfile, UpdateVehicle, ChangeDutyStatus, UpdateDriverLocation, GetTaskByDate, GetTaskDetails, ChangeTaskStatus, reRegisterDevice, joinQueue, leaveQueue, queuePosition, GetNotifications, ClearNotifications, ForgotPassword, ChangePassword, Logout, UploadProfilePhoto. All POST, form-urlencoded; response `{ code, msg, details }`.
- **Rider accounts** use **`mt_driver`** (username/password). Optional **`password_bcrypt`** for new vs old rider app compatibility — see [docs/RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md](./docs/RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md) and **`npm run migrate-mt-driver-password-bcrypt`**.
- **Optional** `mt_client` email login: set **`DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`** and migrate **`mt_driver.client_id`**; see [docs/DRIVER_LOGIN_UNIFIED_ACCOUNTS.md](./docs/DRIVER_LOGIN_UNIFIED_ACCOUNTS.md) and **`POST /admin/api/drivers/promote-from-client`**.
- **Admin API** (`/admin/api`): GET/PUT settings, GET stats/drivers, GET drivers/locations, GET/POST tasks, PUT tasks/:id/assign, GET drivers, POST drivers/promote-from-client, GET push-logs.

See README in this folder for full endpoint list and database schema.
