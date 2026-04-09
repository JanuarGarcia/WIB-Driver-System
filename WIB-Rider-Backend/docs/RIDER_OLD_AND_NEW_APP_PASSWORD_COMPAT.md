# Old rider app + new rider app — same password (no admin reset)

## Where rider accounts live

In this stack, **rider login uses the `mt_driver` table** (`username`, `password`, and optionally **`password_bcrypt`**). The Flutter rider apps talk to **`POST /driver/api/Login`** against those rows.

## What goes wrong

The legacy app expects **`mt_driver.password`** in an old format (often **MD5 hex** or plain text). The new app may **replace `password` with bcrypt** after login. The old app then fails until an admin resets the account.

## Fix: dual column on `mt_driver`

1. **Migration** (adds `password_bcrypt`, does not change existing `password`):

   ```bash
   cd WIB-Rider-Backend
   npm run migrate-mt-driver-password-bcrypt
   ```

2. **Do not** write bcrypt into **`password`** if the old app must keep working. Store bcrypt only in **`password_bcrypt`**.

3. **This backend** verifies with `verifyRiderPasswordResult` (in `lib/passwordVerify.js`): **`password_bcrypt` first** (bcrypt), then legacy **`password`** (MD5 / plain / bcrypt if already migrated in place).

4. After a successful login that matched **only** the legacy column, the API can set **`password_bcrypt`** and leave **`password`** unchanged (see `persistPasswordBcryptSidecarMtDriver` in `lib/riderPasswordCompat.js`). Controlled by **`AUTO_FILL_RIDER_PASSWORD_BCRYPT`** (default on).

5. **`ChangePassword`** updates **both** `password` (default MD5) and `password_bcrypt` when the column exists (`persistDualPasswordOnPasswordChangeMtDriver`).

## Dangerous legacy behavior (off by default)

Previously, login **always** overwrote `password` with bcrypt. That is now **disabled** unless you set:

`MT_DRIVER_LOGIN_UPGRADE_PASSWORD_COLUMN=1`

## Optional: `mt_client` email login

If some users log in with an **ordering/customer** email linked via **`mt_driver.client_id`**, set:

`DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`

Otherwise only **`mt_driver.username`** is used for lookup (normal for rider-only-on-`mt_driver`).

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUTO_FILL_RIDER_PASSWORD_BCRYPT` | on | After legacy-only match, write bcrypt to `password_bcrypt` only. (`AUTO_FILL_CLIENT_PASSWORD_BCRYPT` still accepted.) |
| `DRIVER_LOGIN_MT_CLIENT_FALLBACK` | off | `1` / `true` to allow email lookup via `mt_client` / `st_client` + `client_id`. |
| `MT_DRIVER_LOGIN_UPGRADE_PASSWORD_COLUMN` | off | `1` to restore old behavior: replace `password` with bcrypt on login. |

## Restoring broken users

1. Run **`npm run migrate-mt-driver-password-bcrypt`**.
2. Set **`mt_driver.password`** back to the legacy value the old app expects (often MD5 of the plain password).
3. Set **`password_bcrypt`** to bcrypt of the same plain password if you want the new app to prefer bcrypt.
