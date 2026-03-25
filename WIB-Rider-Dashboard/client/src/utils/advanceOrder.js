/**
 * Advance / scheduled orders (mt_order): show when the order has a scheduled delivery time.
 * Task list API joins `order_delivery_time`, `order_status`, etc.
 */

function normalizeOrderStatus(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function rawDeliveryTime(input) {
  if (!input || typeof input !== 'object') return '';
  const t = input.order_delivery_time ?? input.delivery_time;
  return t != null ? String(t).trim() : '';
}

/**
 * Parse DB time strings (e.g. "5:03:00 PM", "17:03:00") to locale 12h display.
 */
export function formatDbTimeTo12h(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const s = String(raw).trim();
  if (/[ap]m\s*$/i.test(s)) {
    const d = new Date(`January 1, 2000 ${s}`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    }
  }
  const m24 = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    const d = new Date(2000, 0, 1, h, min, 0, 0);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
    }
  }
  return s;
}

/** True when order has a meaningful scheduled wall time (not empty / not ASAP-only). */
export function isAdvanceOrderDisplay(input) {
  const timeRaw = rawDeliveryTime(input);
  if (timeRaw === '') return false;
  if (/^asap$/i.test(timeRaw)) return false;

  const status = normalizeOrderStatus(input.order_status ?? input.status);
  if (status === 'advance order') return true;

  const formatted = formatDbTimeTo12h(timeRaw);
  if (!formatted) return false;

  // TIME 00:00:00 often means "date only" in DB — don't treat as a scheduled slot unless status says advance
  const m24 = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(timeRaw);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    if (h === 0 && min === 0) return status === 'advance order';
  }

  return true;
}

function formatShortDate(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const d = new Date(String(raw).includes('T') ? raw : `${String(raw).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 10);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatOrderedTime12h(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * @returns {{ deliveryLine: string, orderedLine: string | null } | null}
 */
export function getAdvanceOrderLines(input, taskDateCreatedFallback) {
  if (!isAdvanceOrderDisplay(input)) return null;
  const timeRaw = input.order_delivery_time ?? input.delivery_time;
  const dateRaw = input.order_delivery_date ?? input.delivery_date;
  const placedRaw = input.order_placed_at ?? input.date_created ?? taskDateCreatedFallback;

  const deliveryTime = formatDbTimeTo12h(timeRaw);
  if (!deliveryTime) return null;

  const deliveryLine = dateRaw
    ? `Advance order: ${formatShortDate(dateRaw)} · ${deliveryTime}`
    : `Advance order: ${deliveryTime}`;

  const orderedAt = formatOrderedTime12h(placedRaw);
  const orderedLine = orderedAt ? `Ordered time ${orderedAt}` : null;

  return { deliveryLine, orderedLine };
}
