import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, userFacingApiError } from '../api';
import { createRiderCustomerNotifyCooldown, RIDER_CUSTOMER_NOTIFY_COOLDOWN_MS } from '../utils/riderCustomerNotify';

/**
 * @param {object} [opts]
 * @param {(payload: Record<string, unknown>) => Promise<unknown>} [opts.postNotify] — override for tests (defaults to dashboard `POST /notify-customer`).
 */
export function useRiderCustomerNotifyCooldown(opts = {}) {
  const postNotify = opts.postNotify;
  const [sending, setSending] = useState(false);
  const [cooldown] = useState(() => createRiderCustomerNotifyCooldown());
  const [, bump] = useState(0);

  useEffect(() => {
    if (cooldown.msRemaining() <= 0) return undefined;
    const id = setInterval(() => bump((n) => n + 1), 300);
    return () => clearInterval(id);
  }, [cooldown, sending, bump]);

  const secondsLeft = useMemo(
    () => Math.ceil(cooldown.msRemaining() / 1000),
    [cooldown, sending, bump]
  );

  const notify = useCallback(
    async (payload) => {
      if (!cooldown.canSend()) {
        const w = Math.ceil(cooldown.msRemaining() / 1000);
        return { ok: false, error: `Wait ${w}s before notifying again.` };
      }
      setSending(true);
      try {
        const run =
          typeof postNotify === 'function'
            ? postNotify(payload)
            : api('notify-customer', {
                method: 'POST',
                body: JSON.stringify(payload),
              });
        await run;
        cooldown.markSent();
        bump((n) => n + 1);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: userFacingApiError(err) };
      } finally {
        setSending(false);
      }
    },
    [cooldown, postNotify, bump]
  );

  return {
    sending,
    secondsLeft: cooldown.canSend() ? 0 : secondsLeft,
    canSend: cooldown.canSend() && !sending,
    notify,
    cooldownMs: RIDER_CUSTOMER_NOTIFY_COOLDOWN_MS,
  };
}
