# Driver app login — backend handoff (copy to API / mobile team)

Use this document to align the **WIB-Rider-Backend** driver JSON API with the mobile app. Implementation lives in **`routes/driver.js`** (`POST /Login`, `fetchDriverRowForLogin`) and **`middleware/auth.js`** (`validateApiKey`, token helpers).

---

## 1. Which field is the “login username”?

The app sends **`username`** and **`password`** in the JSON body (plus **`api_key`**). The backend does **not** require a separate `login_id` field.

The value in **`username`** is treated as a **login key** and resolved in this order (all against **`mt_driver`** unless noted):

| Step | DB match | Notes |
|------|-----------|--------|
| 1 | `mt_driver.username` | `LOWER(TRIM(username)) = LOWER(trimmed body username))` |
| 2 | `mt_driver.email` | Same string compared to `LOWER(TRIM(COALESCE(email,'')))` (column optional; if missing, step is skipped) |
| 3 | `mt_driver.phone` | Only if the login key contains **≥ 7 digits** after stripping non-digits; compared to phone with spaces / `-` / `()` / `+` removed |

**Optional second path** (env `DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`): if no `mt_driver` row matched the steps above, the key is treated as **customer email** and resolved via **`mt_client`** / errand **`st_client`** and **`mt_driver.client_id`** (see `lib/riderClientForDriverLogin.js`).

**App contract:** keep sending **`username`** + **`password`**. Riders may type **username, email, or mobile** in the username field; the backend maps that to the row using the table above. There is no separate body key for email or phone.

---

## 2. Where “driver” is resolved

| Item | Detail |
|------|--------|
| **Primary table** | **`mt_driver`** |
| **Identifier** | `driver_id` (internal); login uses username / email / phone as above |
| **Password** | `mt_driver.password` (legacy / bcrypt in column) and optional **`mt_driver.password_bcrypt`** |
| **Session token** | Written to **`mt_driver.token`** on successful login |
| **Active / status** | After password succeeds, login fails if **`mt_driver.status`** (when column exists) is one of: **`suspended`**, **`blocked`**, **`expired`**, **`inactive`** (case-insensitive trim). There is **no** `deleted_at` filter in this Node route. |
| **Merchant / site scope** | None on login; one `mt_driver` row = one login identity for this API. |

**Why “test” might return no row**

- There is **no** built-in `test` user. Dev/staging must **`INSERT`** / create a driver (e.g. admin **`POST /admin/api/drivers`** or `scripts/create-driver.js`) with `username` / `email` / `phone` that matches what the app sends.
- The app may hit a **different host or database** than the one where `test` was created (see §4).
- Older builds showed **`No driver account was found for this username.`**; current backend copy is **`No driver account matches this username, email, or mobile number.`** after expanding lookup. Same class of failure: **no matching row** before password check.

---

## 3. Case sensitivity and trimming

| Input | Behavior |
|--------|-----------|
| Body **`username`** | `String(username).trim()` before any lookup |
| **Username** column | Compared case-insensitively via **`LOWER(TRIM(username))`** |
| **Email** column | **`LOWER(TRIM(...))`** |
| **Phone** | Digits-only from the login key; DB phone normalized in SQL as described in §1 |

Admins should still use consistent values; the backend tolerates common casing/whitespace differences.

---

## 4. Environment consistency

- All driver routes are mounted at **`/driver/api`** on the Node app (`app.js`).
- **`POST /driver/api/GetAppSettings`** may include **`mobile_api_url`** only when **`MOBILE_API_URL`** is set in server env; it is normalized to end with **`/driver/api`**. That URL must be the **same logical API and same MySQL `mt_driver` data** as the host used for **`/Login`**, or tokens from Login will not validate on GetAppSettings.
- **Ops rule:** one environment = one driver API base = one DB for `mt_driver`. Do not point the app at host A for Login and **`mobile_api_url`** host B with a different database.

---

## 5. Error contract (`{ code, msg, details }`, HTTP 200)

The app surfaces **`msg`** as-is. Distinct messages include:

| Situation | `msg` (exact intent) |
|-----------|----------------------|
| Missing `api_key` | `API key is required` |
| Wrong `api_key` | `Invalid API key` |
| No `mt_driver` / no fallback match | `No driver account matches this username, email, or mobile number.` |
| Wrong password (driver row found) | `Incorrect password.` |
| Account disabled / suspended (after password OK) | `This driver account is disabled or suspended. Contact support if you need help.` |
| Fallback: unknown email | `No account was found for this email address.` |
| Fallback: not linked driver | `This account is not a driver account...` (constant `MSG_NOT_DRIVER`) |
| Rate limited | `Too many login attempts. Try again later.` |

Success: **`code === 1`**, **`details.token`** present (plus existing fields: `username`, dates, `on_duty`, etc.).

---

## 6. Acceptance / QA checklist

1. **Create a driver** in the target DB (e.g. `username = 'test'`, known password, status active). Ensure **`api_key`** in the app matches **`mt_option.driver_api_hash_key`** / **`API_HASH_KEY`**.
2. **`POST {BASE}/driver/api/Login`** with body `{ "api_key": "…", "username": "test", "password": "<known>" }` on the **same base URL** the app uses → **`code === 1`**, non-empty **`details.token`**.
3. **`POST …/GetAppSettings`** with same `api_key` and `token` → **`valid_token: true`** (boolean).
4. **`POST …/Login`** with a nonsense username → **`code !== 1`**, **`msg`** is the “no driver account matches…” (or fallback email message if applicable), not an empty string.
5. Wrong password for an existing user → **`Incorrect password.`**
6. **Logout** on same base with `api_key` + `token` → success; repeat login with same credentials works.

---

## 7. Quick SQL checks (ops)

```sql
-- Does a row exist for what the user types?
SELECT driver_id, username, email, phone, status,
       LOWER(TRIM(username)) AS u_norm
FROM mt_driver
WHERE LOWER(TRIM(username)) = LOWER(TRIM('test'))
   OR LOWER(TRIM(COALESCE(email,''))) = LOWER(TRIM('test'));

SHOW VARIABLES LIKE 'character_set_database';
```

---

*Last updated to match WIB-Rider-Backend driver login behavior; adjust if you fork the API.*
