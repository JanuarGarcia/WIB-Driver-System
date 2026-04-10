import { useRiderCustomerNotifyCooldown } from '../hooks/useRiderCustomerNotifyCooldown';

function buildNotifyPayload(taskId, orderId) {
  const tid = Number(taskId);
  const payload = {};
  if (!Number.isFinite(tid) || tid === 0) return payload;
  if (tid < 0) {
    payload.task_id = tid;
    const oid =
      orderId != null && Number.isFinite(Number(orderId)) && Number(orderId) > 0
        ? Number(orderId)
        : Math.abs(tid);
    payload.order_id = oid;
    return payload;
  }
  payload.task_id = tid;
  if (orderId != null && Number.isFinite(Number(orderId)) && Number(orderId) > 0) {
    payload.order_id = Number(orderId);
  }
  return payload;
}

/**
 * Notify the order’s customer (preset push). Reuse on any task screen: pass `taskId` and optional `orderId` (errand).
 * Throttles client-side to {@link ../utils/riderCustomerNotify.RIDER_CUSTOMER_NOTIFY_COOLDOWN_MS}; server also enforces.
 *
 * @param {object} props
 * @param {string|number} props.taskId
 * @param {string|number|undefined|null} props.orderId — errand order id when known; optional for standard tasks
 * @param {boolean} [props.disabled]
 * @param {string} [props.className]
 * @param {(r: { ok: boolean, error?: string }) => void} [props.onResult] — e.g. replace `alert` in tests
 */
export default function CustomerNotifyButton({
  taskId,
  orderId,
  disabled = false,
  className = '',
  onResult,
}) {
  const { sending, secondsLeft, canSend, notify } = useRiderCustomerNotifyCooldown();

  const handleClick = async () => {
    const payload = buildNotifyPayload(taskId, orderId);
    if (!payload.task_id) {
      const err = 'Missing task id.';
      if (onResult) onResult({ ok: false, error: err });
      else window.alert(err);
      return;
    }
    const r = await notify(payload);
    if (onResult) onResult(r);
    else if (r.ok) window.alert('Customer notified.');
    else if (r.error) window.alert(r.error);
  };

  const blocked = disabled || !canSend || sending;
  const label =
    sending ? 'Sending…' : secondsLeft > 0 ? `Notify customer (${secondsLeft}s)` : 'Notify customer';

  return (
    <button
      type="button"
      className={className ? `btn ${className}` : 'btn'}
      onClick={handleClick}
      disabled={blocked}
      title="Sends a push to the customer’s app (15s cooldown)"
    >
      {label}
    </button>
  );
}

export { buildNotifyPayload };
