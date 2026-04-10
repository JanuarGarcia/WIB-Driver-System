/**
 * Client-side throttle for “notify customer” (matches server min interval in sendCustomerTaskMessage).
 * Rider mobile app: POST `/driver/api/NotifyCustomer` with JSON body `{ task_id, order_id? }`, same fields as
 * `SendCustomerTaskMessage`, plus `token` + `api_key` per existing driver API auth.
 */
export const RIDER_CUSTOMER_NOTIFY_COOLDOWN_MS = 15_000;

export function createRiderCustomerNotifyCooldown() {
  let cooldownUntil = 0;
  return {
    msRemaining() {
      return Math.max(0, cooldownUntil - Date.now());
    },
    canSend() {
      return Date.now() >= cooldownUntil;
    },
    /** Call after a successful notify so the UI stays disabled until the interval elapses. */
    markSent() {
      cooldownUntil = Date.now() + RIDER_CUSTOMER_NOTIFY_COOLDOWN_MS;
    },
  };
}
