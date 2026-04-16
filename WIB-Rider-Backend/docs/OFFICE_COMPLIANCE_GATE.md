# Office Compliance Gate (Rider/Driver)

Backend enforcement so riders **cannot go ON DUTY** (and cannot enter queue / accept tasks) when they are flagged as **not reported/remitted** at the office.

## Concepts

- **Not a daily flow**: only used when a rider must physically report/remit/settle at the office.
- **Backend is source of truth**: the mobile app may show a modal, but all enforcement is server-side.

## Data model

Tables created by migration:

- `mt_driver_office_compliance`
  - `driver_id` (PK)
  - `compliance_required` (0/1)
  - `compliance_status` (`not_reported` | `reported`)
  - `compliance_reason` (`violation` | `remittance` | `other`)
  - `compliance_note` (optional)
  - `flagged_at`, `flagged_by_admin_id`, `flagged_by_label`
  - `cleared_at`, `cleared_by_admin_id`, `cleared_by_label`

- `mt_driver_office_compliance_audit`
  - one row per change (before/after fields + who/when)

Backward compatibility:

- If the tables (or row) do not exist, backend treats the rider as:
  - `compliance_required = 0`
  - `compliance_status = reported`

## Enforcement (driver API)

Blocking rule (hard gate):

- Block when: `compliance_required = 1` AND `compliance_status = not_reported`
- Error message (exact):
  - `msg`: **"Please report to the office before resuming duty."**

Endpoints guarded:

- `POST /driver/api/ChangeDutyStatus` (when `on_duty=1`)
- `POST /driver/api/joinQueue`
- `POST /driver/api/ChangeTaskStatus`
- `POST /driver/api/AcceptErrandOrder`
- `POST /driver/api/ChangeErrandOrderStatus`

Response contract for blocked calls (HTTP 200; same as other driver API errors):

```json
{
  "code": 2,
  "msg": "Please report to the office before resuming duty.",
  "details": null
}
```

## Rider bootstrap payload (driver API)

`POST /driver/api/GetAppSettings` now includes:

- `compliance_required` (0/1)
- `compliance_status` (`not_reported` | `reported`)
- `compliance_reason` (nullable)
- `compliance_note` (nullable)
- `compliance_message` (nullable; set when blocked)
- `flagged_at`, `flagged_by`, `cleared_at`, `cleared_by` (nullable)

Example (blocked):

```json
{
  "code": 1,
  "msg": "OK",
  "details": {
    "valid_token": true,
    "on_duty": 0,
    "compliance_required": 1,
    "compliance_status": "not_reported",
    "compliance_reason": "remittance",
    "compliance_message": "Please report to the office before resuming duty."
  }
}
```

## Realtime update (SSE) + push fallback

### SSE

Driver app may subscribe:

- `GET /driver/api/events?api_key=...&token=...`

Events:

- `event: init` → `{ compliance: { ...payload } }`
- `event: compliance_update` → `{ ...payload }`
- `event: ping` keepalive

### Push fallback (FCM)

On any compliance change, backend sends an FCM push (if the rider has a device token) with:

- data: `{ type: "compliance_update", compliance_required, compliance_status, compliance_reason }`

## Admin controls (admin API)

Endpoint:

- `PUT /admin/api/drivers/:id/compliance`

Flag example:

```http
PUT /admin/api/drivers/55/compliance
Content-Type: application/json
X-Dashboard-Token: <token>

{
  "action": "flag",
  "reason": "violation",
  "note": "Settle violation fee at office",
  "force_off_duty": true
}
```

Clear example:

```http
PUT /admin/api/drivers/55/compliance
Content-Type: application/json
X-Dashboard-Token: <token>

{
  "action": "clear",
  "note": "Reported at office"
}
```

Response:

```json
{
  "ok": true,
  "compliance": {
    "compliance_required": 0,
    "compliance_status": "reported",
    "compliance_reason": null,
    "compliance_message": null
  },
  "forced_off_duty": false
}
```

## Migration

Run:

- `WIB-Rider-Backend/sql/2026-04-16_office_compliance_gate.sql`

