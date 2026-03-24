import { sanitizeMerchantDisplayName, sanitizeLocationDisplayName } from './displayText';

/** Shared map popup copy + HTML builders (Leaflet bindPopup). */

export function escapeMapHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Human-readable recency for `updated_at` from drivers/locations (MySQL datetime or ISO). */
export function formatLocationAge(updatedAt) {
  if (updatedAt == null || updatedAt === '') return '';
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 45) return 'Updated just now';
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    return m <= 1 ? 'Updated 1 min ago' : `Updated ${m} min ago`;
  }
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    return h === 1 ? 'Updated 1 hr ago' : `Updated ${h} hr ago`;
  }
  const d = Math.floor(sec / 86400);
  return d === 1 ? 'Updated 1 day ago' : `Updated ${d} days ago`;
}

function mapPopupShell(typeMod, bodyInner) {
  return `<div class="map-popup map-popup--${typeMod}">${bodyInner}</div>`;
}

export function riderLeafletPopupHtml(loc) {
  const rawName = (loc.full_name || '').trim();
  const name = rawName || (loc.driver_id != null ? `Driver #${loc.driver_id}` : 'Rider');
  const dutyOn = loc.on_duty === true || Number(loc.on_duty) === 1;
  const pillClass = dutyOn ? 'map-popup-pill map-popup-pill--on' : 'map-popup-pill map-popup-pill--off';
  const pillText = dutyOn ? 'On duty' : 'Off duty';
  const age = formatLocationAge(loc.updated_at);
  const foot = age
    ? `<p class="map-popup-foot">${escapeMapHtml(age)}</p>`
    : '<p class="map-popup-foot map-popup-foot--muted">Location time unknown</p>';
  const idLine =
    loc.driver_id != null
      ? `<p class="map-popup-sub">ID ${escapeMapHtml(String(loc.driver_id))}</p>`
      : '';
  const body = `
    <p class="map-popup-kicker">Rider</p>
    <p class="map-popup-title">${escapeMapHtml(name)}</p>
    ${idLine}
    <p class="map-popup-meta"><span class="${pillClass}">${pillText}</span></p>
    ${foot}
  `;
  return mapPopupShell('rider', body);
}

export function merchantLeafletPopupHtmlStyled(restaurantName) {
  const label = sanitizeMerchantDisplayName(restaurantName || '');
  const title = label ? escapeMapHtml(label) : 'Merchant';
  const body = `
    <p class="map-popup-kicker">Merchant</p>
    <p class="map-popup-title">${title}</p>
    <p class="map-popup-foot map-popup-foot--muted">Pickup / store location</p>
  `;
  return mapPopupShell('merchant', body);
}

export function taskLeafletPopupHtmlStyled(t, statusLabelFn) {
  const sl = t.status && statusLabelFn ? statusLabelFn(t.status) : '';
  const parts = ['<p class="map-popup-kicker">Delivery task</p>'];
  if (t.order_id != null) {
    parts.push(`<p class="map-popup-title">Order #${escapeMapHtml(String(t.order_id))}</p>`);
  } else if (t.task_id != null) {
    parts.push(`<p class="map-popup-title">Task ${escapeMapHtml(String(t.task_id))}</p>`);
  } else {
    parts.push('<p class="map-popup-title">Task</p>');
  }
  if (t.task_id != null && t.order_id != null) {
    parts.push(`<p class="map-popup-sub">Task ID ${escapeMapHtml(String(t.task_id))}</p>`);
  }
  if (sl) {
    parts.push(
      `<p class="map-popup-meta"><span class="map-popup-pill map-popup-pill--info">${escapeMapHtml(sl)}</span></p>`
    );
  }
  const rn = sanitizeMerchantDisplayName(t.restaurant_name || '');
  if (rn) parts.push(`<p class="map-popup-detail">${escapeMapHtml(rn)}</p>`);
  const landmark = sanitizeLocationDisplayName(String(t.landmark || ''));
  if (landmark) {
    parts.push(`<p class="map-popup-detail"><strong>Landmark</strong> · ${escapeMapHtml(landmark.length > 120 ? `${landmark.slice(0, 117)}…` : landmark)}</p>`);
  }
  const addr = sanitizeLocationDisplayName(String(t.delivery_address || ''));
  if (addr) {
    const short = addr.length > 160 ? `${addr.slice(0, 157)}…` : addr;
    parts.push(`<p class="map-popup-detail map-popup-detail--address">${escapeMapHtml(short)}</p>`);
  }
  parts.push('<p class="map-popup-foot map-popup-foot--muted">Drop-off location</p>');
  return mapPopupShell('task', parts.join(''));
}

/** Short native tooltip for markers (Google `title`, pin title). */
export function riderMarkerTitle(loc) {
  const name = (loc.full_name || '').trim() || (loc.driver_id != null ? `Driver #${loc.driver_id}` : 'Rider');
  const age = formatLocationAge(loc.updated_at);
  return age ? `${name} · ${age}` : name;
}
