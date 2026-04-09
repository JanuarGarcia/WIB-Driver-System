# Driver / rider API Login — `mt_driver` accounts

## Rider accounts

**Rider users are rows in `mt_driver`** (username + password). The driver/rider Flutter apps use **`POST /driver/api/Login`** with that username.

Optional column **`password_bcrypt`** holds bcrypt for the new app while **`password`** stays in the legacy format for the old app. See [RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md](./RIDER_OLD_AND_NEW_APP_PASSWORD_COMPAT.md).

## Optional: `mt_client` fallback (`client_id`)

If you link an ordering customer to a driver row with **`mt_driver.client_id`** → **`mt_client.client_id`**, you can allow login by **customer email** when **`DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`**. Admin helper: **`POST /admin/api/drivers/promote-from-client`**.

When fallback is **off** (default), only **`mt_driver.username`** is used.

## Login URL and request

- **URL:** `POST {origin}/driver/api/Login`

| Field | Required | Notes |
|--------|----------|--------|
| `api_key` | Yes | `mt_option.driver_api_hash_key` / `API_HASH_KEY` |
| `username` | Yes | **`mt_driver.username`** (or customer email if fallback enabled) |
| `password` | Yes | |
| `device_id`, `device_platform` | Optional | |

## Response

`{ code, msg, details }` — **`code === 1`** success with non-empty **`details.token`**.

| Situation | `msg` (approx.) |
|-----------|------------------|
| Wrong password / unknown user | `Invalid credentials` |
| Fallback on, correct customer password, no linked `mt_driver` | `This account is not a driver account...` |

## Migrations

- **`npm run migrate-mt-driver-password-bcrypt`** — `mt_driver.password_bcrypt`
- **`npm run migrate-driver-client-id`** — `mt_driver.client_id` (only if using client link)

## Admin

- **`POST /admin/api/drivers/promote-from-client`** — link `mt_client` → new `mt_driver` row (optional workflow).

## Security

- `api_key` validation unchanged.
- Failed logins logged; rate limit on Login unchanged.
