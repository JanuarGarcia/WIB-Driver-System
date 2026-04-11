# Driver / rider API Login — `mt_driver` accounts

## Rider accounts

**Rider users are rows in `mt_driver`** (username + password). The driver/rider Flutter apps use **`POST /driver/api/Login`** with that username.

Optional column **`password_bcrypt`** holds bcrypt for the new app while **`password`** stays in the legacy format for the old app. See [RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md](./RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md).

## Optional: `mt_client` fallback (`client_id`)

If you link an ordering customer to a driver row with **`mt_driver.client_id`** → **`mt_client.client_id`**, you can allow login by **customer email** when **`DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`**. Admin helper: **`POST /admin/api/drivers/promote-from-client`**.

When fallback is **off** (default), login still resolves the **`username`** body field against **`mt_driver.username`**, then **`mt_driver.email`**, then (if enough digits) **`mt_driver.phone`** — see [DRIVER_LOGIN_BACKEND_HANDOFF.md](./DRIVER_LOGIN_BACKEND_HANDOFF.md). The **`mt_client`** email path runs only when fallback is **on**.

## Login URL and request

- **URL:** `POST {origin}/driver/api/Login`

| Field | Required | Notes |
|--------|----------|--------|
| `api_key` | Yes | `mt_option.driver_api_hash_key` / `API_HASH_KEY` |
| `username` | Yes | Login key: matched against **`mt_driver.username`** (case-insensitive, trimmed), then **`mt_driver.email`**, then digits-only **`mt_driver.phone`**. With **`DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`**, customer email also tries **`mt_client`** / errand client link. |
| `password` | Yes | |
| `device_id`, `device_platform` | Optional | |

## Response

`{ code, msg, details }` — **`code === 1`** success with non-empty **`details.token`**. Failures use **`code !== 1`** and a non-empty **`msg`** the app can show as-is.

| Situation | `msg` (approx.) |
|-----------|------------------|
| Missing `api_key` | `API key is required` |
| Wrong `api_key` | `Invalid API key` |
| No row after username, email, and phone lookup (fallback off) | `No driver account matches this username, email, or mobile number.` |
| Wrong password (`mt_driver` username path) | `Incorrect password.` |
| Fallback on, unknown email | `No account was found for this email address.` |
| Fallback on, wrong customer password | `Incorrect password.` |
| `mt_driver.status` blocked (e.g. suspended, inactive) after password OK | `This driver account is disabled or suspended...` |
| Fallback on, correct customer password, no linked `mt_driver` | `This account is not a driver account...` |

## One driver API origin (Login, GetAppSettings, Logout, tasks)

All driver JSON routes live under **`/driver/api`** on the Node server (see `app.js`). The app should use **one base URL** for the whole session, for example `https://your-host.com/driver/api`.

- **`POST /driver/api/Login`** — issues `token` stored on `mt_driver.token` for that same database.
- **`POST /driver/api/GetAppSettings`** — returns **`valid_token: true`** only if the `token` in the body/query matches a row in that same database. **`mobile_api_url`** is included only when **`MOBILE_API_URL`** is set in server env; it is normalized to end with **`/driver/api`**. If it is omitted, the app keeps its built-in default base. **Do not** set `MOBILE_API_URL` to a different host unless that host runs this same API against the **same** `mt_driver` data; otherwise `Login` may succeed on one host while `GetAppSettings` reports `valid_token: false`.
- **`POST /driver/api/Logout`** — same auth as other protected routes (`api_key` + `token` in body or query, or `Authorization: Bearer`). It clears `mt_driver.token` for that driver.

## Migrations

- **`npm run migrate-mt-driver-password-bcrypt`** — `mt_driver.password_bcrypt`
- **`npm run migrate-driver-client-id`** — `mt_driver.client_id` (only if using client link)

## Admin

- **`POST /admin/api/drivers/promote-from-client`** — link `mt_client` → new `mt_driver` row (optional workflow).

## Security

- `api_key` is required; wrong key returns **`Invalid API key`** (same HTTP status envelope as other driver errors).
- Failed logins logged; rate limit on Login unchanged.
