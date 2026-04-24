# Flutter Rider Session Contract

## Session validity

- `POST /driver/api/GetAppSettings` is the authoritative session check.
- Normal envelope is always returned:
  - `code`
  - `msg`
  - `details`
- `details.valid_token`
  - `1` when the rider token is still active
  - `0` when the token was invalidated or logged out
- `details.token_reason` / `details.invalid_token_reason`
  - `logged_in_on_another_device` when a newer login revoked the old device
  - `logout` when the current session logged out
  - `missing_token` or `invalid_token` for other auth failures
- `details.session_recovered`
  - `1` when the backend recovered the still-active session for the same device after a stale-token reconnect
  - helps weak/no-signal retries avoid unnecessary rider logout
- Protected rider endpoints now reject revoked tokens with `401` or `403` JSON envelopes that include the same auth-state fields.

## Login and device ownership

- `POST /driver/api/Login`
  - creates a fresh rider token
  - revokes previous active sessions for the same rider
  - deactivates older device push rows for that rider
  - returns `details.session_id`, `details.valid_token`, and the new token
  - when the same active device logs in again, the backend may reuse the current session token instead of rotating it, to avoid accidental logout during weak/no-signal reconnects
- `POST /driver/api/reRegisterDevice`
  - keeps the current token
  - rebinds the active session/device token to the current device
  - deactivates older rider device rows
- `POST /driver/api/Logout`
  - revokes the current session
  - deactivates the current device token
  - returns `details.valid_token = 0`

## Push and reminders

- Rider push routing uses only active device rows tied to the current valid session.
- Revoked sessions and inactive device registrations are excluded from:
  - task assignment push
  - reminder/ringtone-triggering push
  - rider SSE realtime streams
- Temporary lack of signal does not revoke a rider session by itself; only an explicit logout or a newer login from another device should invalidate it.

## Task payloads

- Task list/detail payloads continue exposing schedule/status fields used by Flutter:
  - `task_id`
  - `order_id`
  - `status`
  - `status_raw`
  - `delivery_date`
  - `delivery_time`
  - `delivery_asap`
- Merchant address stays anchored to the merchant record when available.
- Customer drop-off address now prefers the real address, otherwise `null` instead of placeholder `-`.
