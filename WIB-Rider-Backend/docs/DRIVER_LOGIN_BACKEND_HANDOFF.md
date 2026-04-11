# Driver app login — backend handoff (copy to API / mobile team)

Use this document to align the **WIB-Rider-Backend** driver JSON API with the mobile app. Implementation lives in **`routes/driver.js`** (`POST /Login` or **`POST /login`**, `fetchDriverRowForLogin`) and **`middleware/auth.js`** (`validateApiKey`, token helpers).

**When In Baguio Rider (Flutter):** login uses **`application/x-www-form-urlencoded`** with **`api_key`**, **`app_version`**, **`username`**, **`password`** (optional **`device_id`**, **`device_platform`**). `app_version` is ignored by the server for login. JSON bodies are also accepted.

---

## 1. Which field is the “login username”?

The app sends a **login key** and **`password`** in the body (plus **`api_key`**). The key is usually in field **`username`** (Flutter sends it there; JSON clients use the same key). The backend also accepts the **first non-empty** among these body keys, in order: **`username`**, **`user_name`**, **`UserName`**, **`login`**, **`login_id`**, **`email`**, **`mobile`**, **`phone`** (see `resolveLoginKeyFromBody` in `routes/driver.js`). Values are trimmed and stripped of BOM / zero-width characters before lookup.

The login key is matched against **`mt_driver`** in this order (each step is skipped if the column does not exist in your schema):

| Step | DB match | Notes |
|------|-----------|--------|
| 1 | `username` | Case-insensitive trimmed |
| 2 | `user_name` | Some legacy schemas |
| 3 | `login` | SQL uses quoted identifier where needed |
| 4 | `email` | Case-insensitive trimmed |
| 5 | `email_address` | Alternate column name |
| 6 | `phone`, `contact_phone`, `mobile`, `mobile_number` | Only if the login key has **≥ 7 digits** after stripping non-digits; digits-only compare on normalized phone columns |
| 7 | `first_name` | Matches riders who only know the display name saved as first name |
| 8 | `first_name` + `last_name` | When the login key contains a space (full name) |
| 9 | `driver_id` | Only if the login key is **digits only** (last-resort; e.g. ops testing with `5`) |

**Optional second path** (env `DRIVER_LOGIN_MT_CLIENT_FALLBACK=1`): if no `mt_driver` row matched the steps above, the key is treated as **customer email** and resolved via **`mt_client`** / errand **`st_client`** and **`mt_driver.client_id`** (see `lib/riderClientForDriverLogin.js`).

**App contract:** send **`password`** always. Send the login key as **`username`** when possible. Riders may type **username, email, or mobile** in the app’s single sign-in field; the backend maps that to the row using the table above.

---

## 2. Where “driver” is resolved

| Item | Detail |
|------|--------|
| **Primary table** | **`mt_driver`** |
| **Identifier** | `driver_id` (internal); login uses username / email / phone as above |
| **Password** | `mt_driver.password` may hold **bcrypt** (`$2a$` / `$2b$` / `$2y$`), **32-character MD5 hex** (legacy Yii/restomulti-style), or **plain text**. Optional **`mt_driver.password_bcrypt`** is checked first when present (`lib/passwordVerify.js`). |
| **Session token** | Written to **`mt_driver.token`** on successful login |
| **Active / status** | After password succeeds, login fails if **`mt_driver.status`** (when column exists) is one of: **`suspended`**, **`blocked`**, **`expired`**, **`inactive`** (case-insensitive trim). **`pending`** and other values are **not** blocked here—riders can sign in while awaiting dashboard approval unless the mobile app blocks them client-side. There is **no** `deleted_at` filter in this Node route. |
| **Merchant / site scope** | None on login; one `mt_driver` row = one login identity for this API. |

**Why a known rider might still return “no account matches”**

- The typed login key does not match **any** column in the table above (wrong spelling, or only matching a column you did not fill in).
- The app may hit a **different host or database** than phpMyAdmin / the dashboard (see §4).
- Same class of failure: **no matching row** before password check. Current **`msg`** text: **`No rider account matches this username, email, or mobile number.`**

---

## 3. Case sensitivity and trimming

| Input | Behavior |
|--------|-----------|
| Body login key | First non-empty among the keys listed in §1; then normalize (trim, strip BOM / zero-width) |
| **Username** column | Compared case-insensitively via **`LOWER(TRIM(username))`** |
| **Email** column | **`LOWER(TRIM(...))`** on `email` / `email_address` |
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
| No `mt_driver` / no fallback match | `No rider account matches this username, email, or mobile number.` |
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
4. **`POST …/Login`** with a nonsense username → **`code !== 1`**, **`msg`** is the “no rider account matches…” (or fallback email message if applicable), not an empty string.
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
   OR LOWER(TRIM(COALESCE(email,''))) = LOWER(TRIM('test'))
   OR LOWER(TRIM(COALESCE(email_address,''))) = LOWER(TRIM('test'));

SHOW VARIABLES LIKE 'character_set_database';
```

---

## 8. Example: production-shaped `mt_driver` (WIB rider app)

Use the same **`api_key`** as production: `mt_option.option_name = 'driver_api_hash_key'` (or env **`API_HASH_KEY`**). Base URL: **`POST {origin}/driver/api/Login`**.

**Case A — bcrypt in `password` (e.g. `username = 'test'`)**  
Body: `{ "api_key": "<hash>", "username": "test", "password": "<plaintext you set when the hash was created>" }`  
Verification uses bcrypt when `password` starts with `$2a$` / `$2b$` / `$2y$`.

**Case B — MD5 hex in `password` (e.g. `username = 'Daniel001'`, `email = 'wibapprider@gmail.com'`)**  
Either identifier works as the login key (same JSON field name **`username`** in the app):

- `{ "api_key": "<hash>", "username": "Daniel001", "password": "<plaintext>" }`  
- `{ "api_key": "<hash>", "username": "wibapprider@gmail.com", "password": "<plaintext>" }`  

The backend compares `MD5(utf8 plaintext)` to the 32-character hex in `mt_driver.password` (`lib/passwordVerify.js`).

**Case C — `status = 'pending'`**  
Login is still allowed after a correct password unless you add product rules elsewhere. Approve the rider in the dashboard when you want them fully active for ops.

**Shared MD5 hash across multiple usernames**  
Several rows can share the same `password` hash; login still resolves **one row** by unique `username` / `email` / phone, then checks that row’s password.

---

*Last updated to match WIB-Rider-Backend driver login behavior; adjust if you fork the API.*
