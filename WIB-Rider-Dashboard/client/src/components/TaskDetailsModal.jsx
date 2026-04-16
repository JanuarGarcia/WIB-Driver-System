import { useState, useEffect, useRef, useMemo } from 'react';
import {
  api,
  formatDate,
  formatDateOnly,
  formatActivityTimelineDateTimeShort,
  statusDisplayClass,
  userFacingApiError,
} from '../api';
import { RIDER_NOTIFICATIONS_POLL_EVENT } from '../hooks/useNotifications';
import { sanitizeLocationDisplayName, pickLocalizedMenuString } from '../utils/displayText';
import { getAdvanceOrderLines, formatDbTimeTo12h } from '../utils/advanceOrder';
import MapView from './MapView';
import LocationPreviewModal from './LocationPreviewModal';
import DirectionsModal from './DirectionsModal';
import CustomerNotifyButton from './CustomerNotifyButton';
import { CountryCodeDropdown, COUNTRY_CODES } from './NewTaskModal';
import { taskDropoffLatLng } from '../utils/mapTasks';
import { markNotificationToastSuppressedFromModalHistoryRow } from '../utils/notificationToastDedupe';
import { listTaskSnapshotMatchesId } from '../utils/taskDetailsSnapshot';

/** Split stored contact (e.g. +63917…) into dial code + national number for edit UI. */
function splitContactCountry(full) {
  const s = String(full || '').trim();
  if (!s) return { dial: '+63', national: '' };
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of sorted) {
    if (s.startsWith(c.dial)) {
      return { dial: c.dial, national: s.slice(c.dial.length).replace(/\D/g, '') };
    }
  }
  return { dial: '+63', national: s.replace(/\D/g, '') };
}

function formatDatetimeLocalForInput(d) {
  if (d == null || d === '') return '';
  if (typeof d === 'string') {
    const t = d.trim();
    if (t.length >= 16) return t.slice(0, 16);
    if (t.length >= 10) return `${t.slice(0, 10)}T00:00`;
  }
  try {
    const dt = new Date(d);
    if (!Number.isNaN(dt.getTime())) {
      const iso = dt.toISOString();
      return iso.slice(0, 16);
    }
  } catch (_) {}
  return '';
}

/** Wall time from task.delivery_date for "Complete before" when order has no delivery_time slot. */
function timePartFromTaskDeliveryForCompleteBefore(taskDeliveryRaw) {
  if (taskDeliveryRaw == null || taskDeliveryRaw === '') return '';
  const s = String(taskDeliveryRaw).trim();
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!iso) return '';
  const h = parseInt(iso[2], 10);
  const min = parseInt(iso[3], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return '';
  if (h === 0 && min === 0) return '';
  return formatDbTimeTo12h(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`);
}

/** Send naive local wall time to API (avoids `T` / driver quirks); omit when empty. */
function formatDeliveryDateForApi(isoLocal) {
  if (isoLocal == null || String(isoLocal).trim() === '') return undefined;
  const s = String(isoLocal).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const sec = m[4] != null && m[4] !== '' ? String(parseInt(m[4], 10)).padStart(2, '0') : '00';
    return `${m[1]} ${m[2]}:${m[3]}:${sec}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  return s;
}

/** Strip bogus \\ / escapes for read-only UI; hide literal "undefined"/"null" strings from API. */
function displaySanitized(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'undefined' || low === 'null') return '';
  return sanitizeLocationDisplayName(s);
}

function displaySanitizedOrDash(raw) {
  const v = displaySanitized(raw);
  return v || '—';
}

/**
 * Per-line unit price for receipts. Prefer a positive discounted_price; when discounted_price is 0
 * (common when the DB means “no discount”), use normal_price so lines do not show ₱0 incorrectly.
 */
function orderLineUnitPrice(item) {
  if (!item || typeof item !== 'object') return null;
  const normRaw = item.normal_price != null ? Number(item.normal_price) : NaN;
  const discRaw = item.discounted_price != null ? Number(item.discounted_price) : NaN;
  const norm = Number.isFinite(normRaw) ? normRaw : NaN;
  const disc = Number.isFinite(discRaw) ? discRaw : NaN;
  if (disc > 0) return disc;
  if (norm > 0) return norm;
  if (disc === 0 && Number.isFinite(norm)) return norm;
  if (Number.isFinite(disc)) return disc;
  if (Number.isFinite(norm)) return norm;
  return null;
}

function isGenericErrandOrderLineName(name) {
  const s = name != null ? String(name).trim().toLowerCase() : '';
  if (!s) return true;
  if (s === 'errand service' || s === 'item') return true;
  if (/^item\s*#\s*0$/i.test(s)) return true;
  return false;
}

/** Match Mangan timeline copy: "Added White Rice x1" (backend applies same; client fallback if API is stale). */
function parseAddedItemNamesFromErrandRemarksClient(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  const re = /\badded\s+(.+?)\s*[x×]\s*\d+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const nm = m[1].trim();
    if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(nm)) continue;
    if (nm && !isGenericErrandOrderLineName(nm)) out.push(nm);
  }
  return out;
}

function extractErrandAddedNamesFromHistoryClient(historyRows) {
  if (!Array.isArray(historyRows) || !historyRows.length) return [];
  for (let i = historyRows.length - 1; i >= 0; i -= 1) {
    const text = historyRows[i]?.remarks != null ? String(historyRows[i].remarks) : '';
    if (!/\badded\s+.+\s*[x×]\s*\d+/i.test(text)) continue;
    const names = parseAddedItemNamesFromErrandRemarksClient(text);
    if (names.length > 0) return names;
  }
  const acc = [];
  for (const row of historyRows) {
    const text = row?.remarks != null ? String(row.remarks) : '';
    acc.push(...parseAddedItemNamesFromErrandRemarksClient(text));
  }
  return acc;
}

function enrichErrandOrderDetailsFromTimelineRemarks(details, historyRows, isErrand) {
  if (!isErrand || !Array.isArray(details) || !details.length) return details;
  const names = extractErrandAddedNamesFromHistoryClient(historyRows);
  if (!names.length) return details;
  const needs = details.some((d) => d && isGenericErrandOrderLineName(d.item_name ?? d.itemName ?? d.name));
  if (!needs) return details;
  let ri = 0;
  return details.map((line) => {
    const cur = line?.item_name ?? line?.itemName ?? line?.name;
    if (!line || !isGenericErrandOrderLineName(cur)) return line;
    if (ri >= names.length) return line;
    const nm = names[ri++];
    return {
      ...line,
      item_name: nm,
      itemName: nm,
      name: nm,
      label: nm,
      service_name: nm,
      item_name_display: nm,
    };
  });
}

/** Single-line drop-off address from mt_order_delivery_address row (matches classic receipt “Deliver to”). */
function formatDeliveryAddressFromOrderRow(row) {
  if (!row || typeof row !== 'object') return '';
  const fa = row.formatted_address != null ? String(row.formatted_address).trim() : '';
  if (fa) return fa;
  const parts = [row.street, row.city, row.state, row.zipcode, row.country].filter(
    (p) => p != null && String(p).trim() !== ''
  );
  return parts.join(' ').trim();
}

function normalizeTimelineStatusKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

function normalizedBlobImpliesTaskAccepted(blob) {
  if (!blob) return false;
  if (blob.includes('unaccepted') || blob.includes('notaccepted') || blob.includes('unacknowledged')) return false;
  if (blob.includes('unacknowledge')) return false;
  if (blob.includes('acknowledged')) return true;
  if (blob.includes('acknowledge') && !blob.includes('unacknowledge')) return true;
  if (blob.includes('accepted')) return true;
  return false;
}

function normalizedBlobImpliesReadyForPickup(blob) {
  if (!blob) return false;
  if (blob.includes('notready') && blob.includes('pickup')) return false;
  if (blob === 'readyforpickup' || blob === 'readypickup') return true;
  if (blob.includes('readyforpickup') || blob.includes('readypickup')) return true;
  if (blob.includes('ready') && blob.includes('pickup')) return true;
  return false;
}

function normalizedBlobImpliesInProgress(blob) {
  if (!blob) return false;
  if (blob.includes('notinprogress')) return false;
  if (blob === 'inprogress' || blob.includes('inprogress')) return true;
  if (blob.includes('reachedthedestination') || blob.includes('reacheddestination')) return true;
  if (blob.includes('reached') && blob.includes('destination')) return true;
  if (blob.includes('arrivedatdestination') || (blob.includes('arrived') && blob.includes('destination'))) return true;
  if (blob.includes('arrivedat') && (blob.includes('dropoff') || blob.includes('location'))) return true;
  if (blob.includes('enroute') || blob.includes('ontheway') || blob.includes('onitsway')) return true;
  return false;
}

function normalizedBlobImpliesPreparing(blob) {
  if (!blob) return false;
  if (blob.includes('notpreparing') || blob.includes('unpreparing')) return false;
  return blob === 'preparing' || blob.includes('preparing');
}

const TIMELINE_MAP_LINK_STATUSES = new Set([
  'assigned',
  'acknowledged',
  'started',
  'inprogress',
  'successful',
  'completed',
  'delivered',
  'failed',
  'declined',
  'cancelled',
  'canceled',
  'verification',
  /* Errand / st_ordernew_history labels (spaces stripped by normalizeTimelineStatusKey) */
  'preparing',
  'readypickup',
  'deliveryonitsway',
  'arrivedat',
  'advanceorder',
]);

function timelineEntryShowsMapLink(entry) {
  if (!entry || entry.type === 'legacy') return false;
  if (entry.type === 'photo') return true;
  const elat = entry.latitude != null ? Number(entry.latitude) : NaN;
  const elng = entry.longitude != null ? Number(entry.longitude) : NaN;
  if (Number.isFinite(elat) && Number.isFinite(elng)) return true;
  const key = normalizeTimelineStatusKey(entry.status || entry.description);
  if (!key) return false;
  return TIMELINE_MAP_LINK_STATUSES.has(key);
}

function getTaskMapCoords(task) {
  const lat = task?.task_lat != null ? Number(task.task_lat) : NaN;
  const lng = task?.task_lng != null ? Number(task.task_lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function getTimelineEntryMapCoords(task, entry) {
  if (entry && typeof entry === 'object') {
    const elat = entry.latitude != null ? Number(entry.latitude) : NaN;
    const elng = entry.longitude != null ? Number(entry.longitude) : NaN;
    if (Number.isFinite(elat) && Number.isFinite(elng)) return { lat: elat, lng: elng };
  }
  return getTaskMapCoords(task);
}

/** If no explicit accept row has GPS, use first fix after accept (legacy behavior). */
const TASK_ACCEPT_FALLBACK_STATUSES = new Set(['started', 'inprogress']);

function historyRowHasCoords(row) {
  if (!row || typeof row !== 'object') return null;
  const la = row.latitude != null ? Number(row.latitude) : NaN;
  const ln = row.longitude != null ? Number(row.longitude) : NaN;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  return { lat: la, lng: ln };
}

/** True if this history row represents the rider accepting the task (checks status, description, remarks, reason). */
function historyRowIsRiderAcceptance(row) {
  const parts = [row.status, row.description, row.remarks, row.reason, row.notes];
  const by = String(row.update_by_type || '').toLowerCase();
  const assignedByDispatcher = by === 'admin' || by === 'merchant';
  for (const p of parts) {
    const key = normalizeTimelineStatusKey(p);
    if (!key) continue;
    if (key.includes('taskaccepted') || key.includes('orderaccepted')) return true;
    if (key === 'acknowledged' || key === 'accepted' || key === 'accept') return true;
    if (key === 'assigned' && !assignedByDispatcher) return true;
    if (key === 'orderassigned' || key === 'driverassigned') return true;
  }
  return false;
}

/** Timeline poll / toast: milestones aligned with server classifyTimelineHistoryForDashboardNotify. */
function classifyHistoryRowForTimelineNotify(row) {
  if (!row || typeof row !== 'object') return null;
  const keys = [
    normalizeTimelineStatusKey(row.status),
    normalizeTimelineStatusKey(row.description),
    normalizeTimelineStatusKey(row.remarks),
    normalizeTimelineStatusKey(row.reason),
    normalizeTimelineStatusKey(row.notes),
  ].filter(Boolean);
  if (keys.some((k) => k === 'successful' || k === 'completed' || k === 'delivered')) return 'successful';
  if (keys.some((k) => k === 'readyforpickup' || k === 'readypickup' || normalizedBlobImpliesReadyForPickup(k))) {
    return 'ready_for_pickup';
  }
  if (keys.some((k) => k === 'preparing' || normalizedBlobImpliesPreparing(k))) return 'preparing';
  if (keys.some((k) => k === 'inprogress' || normalizedBlobImpliesInProgress(k))) return 'inprogress';
  if (keys.some((k) => k === 'started')) return 'started';
  if (keys.some((k) => k === 'new' || k === 'created' || k === 'unassigned' || k === 'queued')) return 'created';
  if (historyRowIsRiderAcceptance(row)) return 'accepted';
  if (keys.some((k) => k === 'acknowledged' || k === 'accepted' || k === 'accept')) return 'accepted';
  if (keys.some((k) => normalizedBlobImpliesTaskAccepted(k))) return 'accepted';
  return null;
}

/**
 * Oldest-first: first GPS row that marks rider acceptance, else first started/inprogress with GPS (approximate legacy “start”).
 * @returns {{ lat: number, lng: number, pinLabel: string } | null}
 */
function getTaskAcceptCoordsFromHistory(historyRows) {
  const rows = Array.isArray(historyRows) ? [...historyRows] : [];
  rows.sort((a, b) => {
    const ta = a?.date_created ? new Date(a.date_created).getTime() : 0;
    const tb = b?.date_created ? new Date(b.date_created).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return Number(a?.id) - Number(b?.id);
  });
  for (const row of rows) {
    const coords = historyRowHasCoords(row);
    if (!coords || !historyRowIsRiderAcceptance(row)) continue;
    return { ...coords, pinLabel: 'Accepted here' };
  }
  for (const row of rows) {
    const coords = historyRowHasCoords(row);
    if (!coords) continue;
    const key = normalizeTimelineStatusKey(row.status || row.description || '');
    if (TASK_ACCEPT_FALLBACK_STATUSES.has(key)) {
      return { ...coords, pinLabel: 'Rider GPS (en route)' };
    }
  }
  return null;
}

function getMerchantPickupCoords(merchant) {
  if (!merchant || typeof merchant !== 'object') return null;
  const la = merchant.latitude != null ? Number(merchant.latitude) : NaN;
  const ln = merchant.longitude != null ? Number(merchant.longitude) : NaN;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  return { lat: la, lng: ln };
}

function timelineHistoryBadgeLabel(entry) {
  return String(entry?.status ?? entry?.description ?? '').trim() || '—';
}

function timelineHistoryPrimaryText(entry) {
  const rem = String(entry?.remarks ?? entry?.reason ?? '').trim();
  if (rem) return displaySanitized(rem) || rem;
  const notes = entry.notes != null ? String(entry.notes).trim() : '';
  if (notes) return displaySanitized(notes) || notes;
  const by = String(entry?.update_by_name ?? entry?.update_by_type ?? '').trim();
  const st = String(entry?.status ?? entry?.description ?? '').trim();
  if (by && st) return `${by} — ${st}`;
  if (entry.type === 'legacy' && !by) return '';
  return st ? displaySanitized(st) || st : '';
}

/** Classic rider timeline: "Kenneth Charles added a photo" (first two name parts, like legacy admin). */
function timelineDriverShortName(full) {
  const s = displaySanitized(full || '').trim();
  if (!s) return '';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return s;
  return `${parts[0]} ${parts[1]}`;
}

function timelineProofKindFromRow(row) {
  const raw = row && row.proof_type != null ? String(row.proof_type).toLowerCase() : '';
  if (raw === 'receipt' || raw === 'proof_receipt' || raw === 'proof_of_receipt') return 'receipt';
  return 'delivery';
}

function timelinePhotoEntryCaption(driverName, proofKind) {
  const short = timelineDriverShortName(driverName);
  const kind = proofKind === 'receipt' ? 'receipt' : 'delivery';
  if (kind === 'receipt') {
    if (short) return `${short} added proof of receipt`;
    return 'Proof of receipt was added';
  }
  if (short) return `${short} added proof of delivery`;
  return 'Proof of delivery was added';
}

function ActivityTimelineMetaCol({ task, entry, dateCreated, onOpenLocation }) {
  const coords = getTimelineEntryMapCoords(task, entry);
  const showMap = timelineEntryShowsMapLink(entry) && coords && typeof onOpenLocation === 'function';
  return (
    <div className="activity-timeline-meta-col">
      <div className="activity-timeline-meta-time">
        <svg className="activity-timeline-meta-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <span>{formatActivityTimelineDateTimeShort(dateCreated)}</span>
      </div>
      {showMap ? (
        <button
          type="button"
          className="activity-timeline-map-link"
          onClick={() => onOpenLocation(coords.lat, coords.lng)}
        >
          <svg className="activity-timeline-meta-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
          </svg>
          Location on Map
        </button>
      ) : null}
    </div>
  );
}

/** Title-case category heading for order line groups (e.g. mt_category.category_name). */
function formatCategoryTitle(str) {
  const t = String(str ?? '').trim();
  if (!t) return '';
  const cleaned = displaySanitized(t) || t;
  if (!cleaned.trim()) return '';
  return cleaned.trim().replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
}

/** Group key + section label from category, subcategory, and fallbacks (API may set subcategory_name). */
function orderItemGroupMeta(item) {
  const catRaw = (item.category_name || item.category || item.item_category || '').toString().trim();
  const subRaw = (item.subcategory_name || '').toString().trim();
  const catPick = pickLocalizedMenuString(catRaw);
  const subPick = pickLocalizedMenuString(subRaw);
  const cat = catPick ? (displaySanitized(catPick) || catPick).trim() : '';
  const sub = subPick ? (displaySanitized(subPick) || subPick).trim() : '';
  if (!cat && !sub) return { key: '__other__', label: 'Other items' };
  const catLbl = cat ? formatCategoryTitle(cat) : '';
  const subLbl = sub ? formatCategoryTitle(sub) : '';
  if (!cat && sub) return { key: `__sub__|${sub.toLowerCase()}`, label: subLbl || 'Other items' };
  if (cat && !sub) return { key: cat.toLowerCase(), label: catLbl || 'Other items' };
  return {
    key: `${cat.toLowerCase()}|||${sub.toLowerCase()}`,
    label: `${catLbl} — ${subLbl}`,
  };
}

/** Uppercase category line inside ordered-items card (matches driver-style receipt). */
function formatOrderRefCategoryHeader(label) {
  const picked = pickLocalizedMenuString(label);
  const t = (picked || String(label || '').trim()).trim();
  if (!t) return 'ITEMS';
  if (t.toLowerCase() === 'other items') return 'ITEMS';
  if (/^\s*\{/.test(t) && t.includes('"')) return 'ITEMS';
  return t
    .split(' — ')
    .map((part) => part.trim().toUpperCase())
    .join(' — ');
}

/** Parse numeric percentage from DB (5, 0.05, "5%", etc.). */
function parseTipPercentRaw(raw) {
  if (raw == null || String(raw).trim() === '') return NaN;
  const s = String(raw).trim().replace(/%/g, '').replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Order summary row: mt_order.cart_tip_percentage + cart_tip_value. */
function formatOrderTipRow(order) {
  const empty = { label: 'Tips', summaryLabel: 'TIPS', display: '—' };
  if (!order || typeof order !== 'object') return empty;
  const valRaw =
    order.cart_tip_value ?? order.courier_tip ?? order.courirer_tip ?? order.tip_value;
  const pctRaw =
    order.cart_tip_percentage
    ?? order.tip_percentage
    ?? order.tips_percentage
    ?? order.tip_percent;
  const valNum = valRaw != null && String(valRaw).trim() !== '' ? Number(valRaw) : NaN;
  const pctNum = parseTipPercentRaw(pctRaw);
  let pctLabel = null;
  if (!Number.isNaN(pctNum) && pctNum > 0) {
    let displayPct = pctNum;
    /* DB may store 5 for 5% or 0.05 for 5% */
    if (pctNum > 0 && pctNum < 1) {
      displayPct = pctNum * 100;
    }
    const rounded = Math.round(displayPct * 10000) / 10000;
    pctLabel = Number.isInteger(rounded) ? String(rounded) : String(parseFloat(rounded.toFixed(4)));
  }
  const label = pctLabel ? `Tips ${pctLabel}%` : 'Tips';
  const summaryLabel = pctLabel ? `TIPS ${pctLabel}%` : 'TIPS';
  const display = !Number.isNaN(valNum) ? `₱${valNum.toFixed(2)}` : '—';
  return { label, summaryLabel, display };
}

/**
 * `mt_order_details.addon` JSON array (e.g. [{ addon_name, addon_category, price }]).
 * @returns {{ category: string|null, name: string, qty: number, price: number }[]}
 */
function parseOrderLineAddonsFromItem(item) {
  if (!item || typeof item !== 'object') return [];
  let raw = item.addons;
  if (raw == null && item.addon != null) {
    const s = String(item.addon).trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        raw = JSON.parse(s);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  arr.forEach((a, idx) => {
    if (!a || typeof a !== 'object') return;
    const nameRaw = a.addon_name ?? a.name ?? a.item_name ?? a.label ?? a.title;
    if (nameRaw == null || String(nameRaw).trim() === '') return;
    const name = String(nameRaw).trim();
    const catRaw = a.addon_category ?? a.category ?? a.addon_type ?? null;
    const category = catRaw != null && String(catRaw).trim() !== '' ? String(catRaw).trim() : null;
    const q = Number(a.qty ?? a.quantity ?? a.qty_ordered ?? 1);
    const qty = Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
    const pRaw = a.price ?? a.addon_price ?? a.subtotal ?? a.sub_total ?? a.amount ?? a.total ?? 0;
    const p = Number(pRaw);
    const price = Number.isFinite(p) ? p : 0;
    out.push({ category, name, qty, price });
  });
  return out;
}

/** Normalize photo filename: strip wrapping <>, basename token, duplicate extension (.jpg.jpg -> .jpg). */
function normalizePhotoName(photoName) {
  if (!photoName || typeof photoName !== 'string') return '';
  let s = photoName.trim().replace(/\\/g, '/');
  s = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  const base = s.includes('/') ? s.split('/').pop() || s : s;
  let name = base;
  const doubleExt = /\.(jpg|jpeg|png|gif|webp)\.(jpg|jpeg|png|gif|webp)$/i.exec(name);
  if (doubleExt) name = name.slice(0, -(doubleExt[1].length + 1));
  return name;
}

/** Basename only (legacy PHP /upload/driver/ keeps double extensions like .jpg.jpg on disk). */
function legacyDriverBasename(photoName) {
  if (!photoName || typeof photoName !== 'string') return '';
  let s = photoName.trim().replace(/\\/g, '/');
  s = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  const base = s.includes('/') ? s.split('/').pop() || s : s;
  return base || '';
}

/** Build task photo URL. Tries legacy /upload/driver/ first when cycling variants. */
function taskPhotoUrl(photoName, variant = 'task_photos') {
  if (!photoName || typeof photoName !== 'string') return '';
  const s = photoName.trim();
  if (s.startsWith('http') || s.startsWith('/')) return s;
  if (variant === 'upload_driver') {
    const raw = legacyDriverBasename(s);
    if (!raw) return '';
    return `/upload/driver/${encodeURIComponent(raw)}`;
  }
  const name = normalizePhotoName(s);
  if (!name) return '';
  if (variant === 'root') return `/uploads/${encodeURIComponent(name)}`;
  if (variant === 'upload_task') return `/upload/task/${encodeURIComponent(name)}`;
  return `/uploads/task_photos/${encodeURIComponent(name)}`;
}

/** Renders proof-of-delivery image. Uses /api/task-photos/:id/image when photoId is set (image from DB); otherwise tries disk paths. */
function TaskPhotoImage({ photoId, photoName }) {
  const [variantIdx, setVariantIdx] = useState(0);
  const [skipApiBlob, setSkipApiBlob] = useState(false);
  const apiImageUrl = photoId ? `/api/task-photos/${encodeURIComponent(photoId)}/image` : null;
  const variants = ['upload_driver', 'upload_task', 'task_photos', 'root'];
  const uploadsUrl = photoName ? taskPhotoUrl(photoName, variants[Math.min(variantIdx, variants.length - 1)]) : '';
  const url = (!skipApiBlob && apiImageUrl) || uploadsUrl;
  if (!url) {
    return <div className="activity-timeline-proof-missing">Proof image unavailable</div>;
  }
  const bumpVariant = () => {
    if (apiImageUrl && !skipApiBlob) {
      setSkipApiBlob(true);
      return;
    }
    setVariantIdx((i) => (i < variants.length - 1 ? i + 1 : i));
  };
  return (
    <div className="activity-timeline-photo-wrap">
      <a href={url} target="_blank" rel="noopener noreferrer" className="activity-timeline-photo-link">
        <img
          src={url}
          alt="Proof of delivery"
          className="activity-timeline-photo"
          loading="lazy"
          onError={bumpVariant}
        />
      </a>
    </div>
  );
}

/** Prefer server-built proof URL; on 404 fall back to DB blob / legacy paths. */
function ProofTimelineThumb({ url, photoId, photoName }) {
  const [preferFallback, setPreferFallback] = useState(false);
  if (preferFallback && (photoId != null || photoName)) {
    return <TaskPhotoImage photoId={photoId} photoName={photoName} />;
  }
  if (!url) {
    if (photoId != null || photoName) return <TaskPhotoImage photoId={photoId} photoName={photoName} />;
    return <div className="activity-timeline-proof-missing">Proof image unavailable</div>;
  }
  return (
    <div className="activity-timeline-proof-cell">
      <a href={url} target="_blank" rel="noopener noreferrer" className="activity-timeline-proof-link">
        <img
          src={url}
          alt="Proof of delivery"
          className="activity-timeline-proof-img"
          loading="lazy"
          onError={() => setPreferFallback(true)}
        />
      </a>
    </div>
  );
}

function normalizeTimelineStatus(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s_]/g, '');
}

/** History / legacy row that should show proof_images when there is no dedicated photo timeline item. */
function isProofVerificationHistoryEntry(entry) {
  if (!entry || (entry.type !== 'history' && entry.type !== 'legacy')) return false;
  const st = normalizeTimelineStatus(entry.status ?? entry.description);
  if (['successful', 'completed', 'delivered'].includes(st)) return true;
  const blob = `${entry.remarks || ''} ${entry.reason || ''} ${entry.notes || ''}`.toLowerCase();
  return (
    blob.includes('proof') ||
    blob.includes('picture') ||
    blob.includes('verification') ||
    blob.includes('photo')
  );
}

/** Matches legacy WIB Rider admin order + labels; values are what we send to PUT /tasks/:id/status */
const TASK_CHANGE_STATUS_OPTIONS = [
  { value: 'unassigned', label: 'Unassigned - Makikita ni rider na pinasa - Use Re-assign Agent' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'started', label: 'Started' },
  { value: 'inprogress', label: 'Inprogress' },
  { value: 'successful', label: 'Successful' },
  { value: 'failed', label: 'Failed' },
  { value: 'declined', label: 'Declined' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function TaskDetailsModal({
  taskId,
  onClose,
  onAssignDriver,
  onTaskDeleted,
  onTaskListInvalidate,
  /** When set, enables in-app Get directions (Mapbox and/or Google per Settings). */
  directionsMapSettings = null,
  initialTab = 'details',
  /** Dashboard/tasks list row — same `task_id` as `taskId`; shows modal content immediately while the full record loads. */
  listTaskSnapshot = null,
  /** Dashboard: fly map to task pin when errand details load (orange task marker). */
  onFocusTaskOnMap = null,
}) {
  const initialTabRef = useRef(initialTab);
  initialTabRef.current = initialTab;
  const [data, setData] = useState(null);
  const [orderHistory, setOrderHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('details');
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [teams, setTeams] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [assignTeamId, setAssignTeamId] = useState('');
  const [assignDriverId, setAssignDriverId] = useState('');
  const [changeStatusOpen, setChangeStatusOpen] = useState(false);
  const [changeStatusValue, setChangeStatusValue] = useState('');
  const [changeStatusReason, setChangeStatusReason] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ task_description: '', delivery_address: '', customer_name: '', contact_number: '', delivery_date: '', email_address: '' });
  const [editContactCountryCode, setEditContactCountryCode] = useState('+63');
  const [editTeams, setEditTeams] = useState([]);
  const [editDrivers, setEditDrivers] = useState([]);
  const [editTeamId, setEditTeamId] = useState('');
  const [editDriverId, setEditDriverId] = useState('');
  const [editMapProvider, setEditMapProvider] = useState('mapbox');
  const [editMapboxToken, setEditMapboxToken] = useState('');
  const [editGoogleApiKey, setEditGoogleApiKey] = useState('');
  const [editGoogleMapStyle, setEditGoogleMapStyle] = useState('');
  const prevEditTeamRef = useRef('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  /** proof_images when loaded only via /tasks/:id/order-history (task payload had no order_history). */
  const [orderHistoryProofImages, setOrderHistoryProofImages] = useState([]);
  /** In-app Leaflet preview for timeline “Location on Map” (no Google redirect). */
  const [locationPreview, setLocationPreview] = useState(null);
  const [directionsContext, setDirectionsContext] = useState(null);
  const errandMapFocusedForTaskIdRef = useRef(null);
  const timelinePollInitRef = useRef(false);
  const timelineCursorHRef = useRef(0);
  const timelineCursorPRef = useRef(0);
  const timelineToastedRef = useRef(new Set());
  const listTaskSnapshotRef = useRef(null);
  listTaskSnapshotRef.current = listTaskSnapshot;

  useEffect(() => {
    errandMapFocusedForTaskIdRef.current = null;
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !data?.task || typeof onFocusTaskOnMap !== 'function') return;
    const isErrand = data.task_source === 'errand' || Number(taskId) < 0;
    if (!isErrand) return;
    if (errandMapFocusedForTaskIdRef.current === taskId) return;
    const p = taskDropoffLatLng(data.task, data);
    if (!p) return;
    errandMapFocusedForTaskIdRef.current = taskId;
    onFocusTaskOnMap(data.task);
  }, [taskId, data, onFocusTaskOnMap]);

  useEffect(() => {
    if (!taskId) {
      timelinePollInitRef.current = false;
      timelineCursorHRef.current = 0;
      timelineCursorPRef.current = 0;
      timelineToastedRef.current = new Set();
      setData(null);
      setOrderHistory([]);
      setOrderHistoryProofImages([]);
      setError(null);
      setLoading(false);
      setTab('details');
      setDeleteConfirmOpen(false);
      setAssignOpen(false);
      setChangeStatusOpen(false);
      setChangeStatusValue('');
      setChangeStatusReason('');
      setLocationPreview(null);
      setDirectionsContext(null);
      return;
    }
    timelinePollInitRef.current = false;
    timelineCursorHRef.current = 0;
    timelineCursorPRef.current = 0;
    timelineToastedRef.current = new Set();
    setError(null);
    setLocationPreview(null);
    setDirectionsContext(null);
    {
      const it = initialTabRef.current;
      setTab(it === 'timeline' || it === 'order' ? it : 'details');
    }
    setDeleteConfirmOpen(false);
    setAssignOpen(false);
    setChangeStatusOpen(false);
    setChangeStatusValue('');
    setChangeStatusReason('');
    const snap = listTaskSnapshotRef.current;
    const snapshotMatches = listTaskSnapshotMatchesId(snap, taskId);
    if (snapshotMatches) {
      setData({ task: snap, task_source: snap.task_source });
      setOrderHistory(Array.isArray(snap.order_history) ? snap.order_history : []);
      setOrderHistoryProofImages([]);
    } else {
      setData(null);
      setOrderHistory([]);
      setOrderHistoryProofImages([]);
    }
    setLoading(true);
    const errandOid = Number(taskId) < 0 ? Math.abs(Number(taskId)) : null;
    const loadUrl = errandOid != null ? `errand-orders/${errandOid}` : `tasks/${taskId}`;
    let cancelled = false;

    const applyHistoryFromParallel = (histRes) => {
      if (!histRes || typeof histRes !== 'object') return;
      if (Array.isArray(histRes)) {
        if (histRes.length > 0) {
          setOrderHistory(histRes);
          setOrderHistoryProofImages([]);
        }
        return;
      }
      const list = Array.isArray(histRes.order_history)
        ? histRes.order_history
        : Array.isArray(histRes.data)
          ? histRes.data
          : [];
      if (list.length > 0) {
        setOrderHistory(list);
        setOrderHistoryProofImages(Array.isArray(histRes.proof_images) ? histRes.proof_images : []);
      }
    };

    const runLoad =
      errandOid != null
        ? api(loadUrl).then((res) => ({ res, hist: null }))
        : Promise.all([api(loadUrl), api(`tasks/${taskId}/order-history`).catch(() => null)]).then(([res, hist]) => ({
            res,
            hist,
          }));

    runLoad
      .then(({ res, hist }) => {
        if (cancelled) return;
        if (res && typeof res === 'object' && !res.error) {
          setData(res);
          setOrderHistoryProofImages([]);
          const fromTask = Array.isArray(res.order_history)
            ? res.order_history
            : Array.isArray(res.mt_order_history)
              ? res.mt_order_history
              : [];
          if (fromTask.length > 0) {
            setOrderHistory(fromTask);
          } else if (hist) {
            applyHistoryFromParallel(hist);
          }
        } else {
          setData(null);
          setError(res?.error || 'Failed to load task');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(userFacingApiError(err) || 'Failed to load task');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      setLoading(false);
    };
  }, [taskId]);

  useEffect(() => {
    if (!deleteConfirmOpen && !assignOpen && !changeStatusOpen && !editOpen) return;
    const onKey = (e) => {
      if (e.key !== 'Escape' || actionLoading) return;
      if (deleteConfirmOpen) setDeleteConfirmOpen(false);
      if (assignOpen) {
        setAssignOpen(false);
        setAssignTeamId('');
        setAssignDriverId('');
      }
      if (changeStatusOpen) {
        setChangeStatusOpen(false);
        setChangeStatusValue('');
        setChangeStatusReason('');
      }
      if (editOpen) setEditOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteConfirmOpen, assignOpen, changeStatusOpen, editOpen, actionLoading]);

  useEffect(() => {
    if (!editOpen) return;
    api('teams').then((t) => setEditTeams(Array.isArray(t) ? t : (t?.teams || []))).catch(() => setEditTeams([]));
    api('drivers').then((d) => setEditDrivers(Array.isArray(d) ? d : (d?.drivers || []))).catch(() => setEditDrivers([]));
    api('settings')
      .then((s) => {
        const provider = (s.map_provider || '').toString().trim().toLowerCase();
        setEditMapProvider(provider === 'google' ? 'google' : 'mapbox');
        setEditGoogleApiKey(s.google_api_key || '');
        setEditMapboxToken((s.mapbox_access_token || '').toString().trim());
        setEditGoogleMapStyle(s.google_map_style != null ? String(s.google_map_style) : '');
      })
      .catch(() => {
        setEditMapboxToken('');
        setEditGoogleApiKey('');
      });
  }, [editOpen]);

  useEffect(() => {
    if (!editOpen) {
      prevEditTeamRef.current = '';
      return;
    }
    const prev = prevEditTeamRef.current;
    prevEditTeamRef.current = editTeamId;
    if (prev !== '' && prev !== editTeamId) setEditDriverId('');
  }, [editOpen, editTeamId]);

  useEffect(() => {
    if (!taskId || !data?.task) return;
    if (data.task_source === 'errand' || Number(taskId) < 0) return;
    const fromTask = Array.isArray(data.order_history) ? data.order_history : Array.isArray(data.mt_order_history) ? data.mt_order_history : [];
    if (fromTask.length > 0) return;
    if (orderHistory.length > 0) return;
    let cancelled = false;
    api(`tasks/${taskId}/order-history`)
      .then((list) => {
        if (cancelled) return;
        if (Array.isArray(list)) {
          setOrderHistory(list);
          setOrderHistoryProofImages([]);
          return;
        }
        if (list && typeof list === 'object') {
          setOrderHistory(Array.isArray(list.order_history) ? list.order_history : Array.isArray(list.data) ? list.data : []);
          setOrderHistoryProofImages(Array.isArray(list.proof_images) ? list.proof_images : []);
        } else {
          setOrderHistory([]);
          setOrderHistoryProofImages([]);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setOrderHistory([]);
        setOrderHistoryProofImages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, data?.task, data?.order_history, data?.mt_order_history, orderHistory.length]);

  useEffect(() => {
    if (!taskId || Number(taskId) < 0) return undefined;
    if (data?.task_source === 'errand') return undefined;
    if (!data?.task) return undefined;

    let cancelled = false;
    const pollMs = 12_000;

    const mergeHistory = (rows) => {
      setOrderHistory((prev) => {
        const m = new Map((prev || []).filter(Boolean).map((r) => [Number(r.id), r]));
        for (const row of rows) {
          if (row && row.id != null) m.set(Number(row.id), row);
        }
        return Array.from(m.values()).sort((a, b) => {
          const ta = a.date_created ? new Date(a.date_created).getTime() : 0;
          const tb = b.date_created ? new Date(b.date_created).getTime() : 0;
          if (ta !== tb) return ta - tb;
          return Number(a.id) - Number(b.id);
        });
      });
    };

    const mergePhotos = (photos) => {
      setData((prev) => {
        if (!prev) return prev;
        const existing = Array.isArray(prev.task_photos) ? prev.task_photos : [];
        const m = new Map(existing.map((p) => [Number(p.id), p]));
        for (const p of photos) {
          if (p && p.id != null) m.set(Number(p.id), p);
        }
        const task_photos = Array.from(m.values()).sort((a, b) => {
          const da = a.date_created ? new Date(a.date_created).getTime() : 0;
          const db = b.date_created ? new Date(b.date_created).getTime() : 0;
          return da - db;
        });
        const proof_images = task_photos.map((r) => r.proof_url).filter(Boolean);
        const rec = task_photos.filter((r) => String(r.proof_type || '').toLowerCase() === 'receipt');
        const del = task_photos.filter((r) => !r.proof_type || String(r.proof_type).toLowerCase() === 'delivery');
        const proof_receipt_url = rec.length ? rec[rec.length - 1].proof_url || null : null;
        const proof_delivery_url = del.length ? del[del.length - 1].proof_url || null : null;
        return { ...prev, task_photos, proof_images, proof_receipt_url, proof_delivery_url };
      });
    };

    async function tick() {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        const afterH = timelinePollInitRef.current ? timelineCursorHRef.current : 0;
        const afterP = timelinePollInitRef.current ? timelineCursorPRef.current : 0;
        const qs = new URLSearchParams({
          after_history_id: String(afterH),
          after_photo_id: String(afterP),
        });
        const res = await api(`tasks/${taskId}/timeline-updates?${qs.toString()}`);
        if (cancelled || !res || typeof res !== 'object') return;

        const curH = Number(res.cursor_history) || 0;
        const curP = Number(res.cursor_photo) || 0;
        const hist = Array.isArray(res.history_events) ? res.history_events : [];
        const photos = Array.isArray(res.photo_events) ? res.photo_events : [];

        if (!timelinePollInitRef.current) {
          timelinePollInitRef.current = true;
          timelineCursorHRef.current = curH;
          timelineCursorPRef.current = curP;
          return;
        }

        let notifyBell = false;
        for (const row of hist) {
          const hid = row.id != null ? Number(row.id) : NaN;
          if (!Number.isFinite(hid)) continue;
          const key = `h-${hid}`;
          if (timelineToastedRef.current.has(key)) continue;
          const cat = classifyHistoryRowForTimelineNotify(row);
          if (!cat) continue;
          timelineToastedRef.current.add(key);
          notifyBell = true;
          if (typeof window !== 'undefined' && window.location.pathname === '/') {
            markNotificationToastSuppressedFromModalHistoryRow(row, taskId);
          }
        }

        for (const ph of photos) {
          const pid = ph.id != null ? Number(ph.id) : NaN;
          if (!Number.isFinite(pid)) continue;
          const key = `p-${pid}`;
          if (timelineToastedRef.current.has(key)) continue;
          timelineToastedRef.current.add(key);
          notifyBell = true;
        }

        timelineCursorHRef.current = curH;
        timelineCursorPRef.current = curP;
        if (hist.length) mergeHistory(hist);
        if (photos.length) mergePhotos(photos);

        if (notifyBell) {
          try {
            window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 200 } }));
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore transient errors */
      }
    }

    tick();
    const intervalId = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [taskId, data?.task, data?.task_source]);

  const taskStartMapCoords = useMemo(() => {
    if (!taskId) return null;
    const fromHist = getTaskAcceptCoordsFromHistory(orderHistory);
    if (fromHist) {
      return { lat: fromHist.lat, lng: fromHist.lng, label: fromHist.pinLabel };
    }
    const pickup = getMerchantPickupCoords(data?.merchant ?? null);
    if (pickup) return { lat: pickup.lat, lng: pickup.lng, label: 'Pickup' };
    return null;
  }, [taskId, orderHistory, data?.merchant]);

  if (!taskId) return null;

  const handleClose = () => {
    setAssignOpen(false);
    setAssignTeamId('');
    setAssignDriverId('');
    setDeleteConfirmOpen(false);
    setChangeStatusOpen(false);
    setChangeStatusValue('');
    setChangeStatusReason('');
    setEditOpen(false);
    setEditTeamId('');
    setEditDriverId('');
    setEditContactCountryCode('+63');
    setLocationPreview(null);
    setDirectionsContext(null);
    onClose?.();
  };

  const openTimelineLocation = (la, ln) => {
    const start = taskStartMapCoords;
    const thresh = 0.00006;
    let startLat;
    let startLng;
    let startLegendLabel;
    if (start) {
      const dup = Math.abs(start.lat - la) < thresh && Math.abs(start.lng - ln) < thresh;
      if (!dup) {
        startLat = start.lat;
        startLng = start.lng;
        startLegendLabel = start.label;
      }
    }
    setLocationPreview({ lat: la, lng: ln, startLat, startLng, startLegendLabel });
  };

  const openDirectionsModal = () => {
    const t = data?.task ?? data;
    if (!t) return;
    const destination = String(t.delivery_address ?? '').trim();
    const originFromTask = String(t.pickup_address ?? t.drop_address ?? t.merchant_address ?? '').trim();
    const merchant = data?.merchant || null;
    const originFromMerchant =
      merchant && [merchant.street, merchant.city, merchant.state, merchant.post_code].filter(Boolean).join(', ');
    const origin = originFromTask || String(originFromMerchant || '').trim();
    const destinationCoords =
      t.task_lat != null && t.task_lng != null ? { lat: Number(t.task_lat), lng: Number(t.task_lng) } : null;

    if (!destination && !destinationCoords) {
      window.alert('This task has no delivery address or coordinates to route to.');
      return;
    }

    const pickup = String(t.pickup_address ?? t.drop_address ?? t.merchant_address ?? '').trim();
    const dest = String(t.delivery_address ?? '').trim();
    let externalMapsUrl = null;
    if (dest) {
      const params = new URLSearchParams({ api: '1', destination: dest });
      if (pickup) params.set('origin', pickup);
      externalMapsUrl = `https://www.google.com/maps/dir/?${params.toString()}`;
    }

    setDirectionsContext({
      taskId: t.task_id ?? taskId,
      origin,
      destination,
      destinationCoords,
      externalMapsUrl,
    });
  };

  /** Assign dialog: choose team, then driver on the same screen (matches edit-task pattern). */
  const openAssignModal = () => {
    const t = data?.task;
    const prefTeam =
      t?.team_id != null && String(t.team_id).trim() !== '' && String(t.team_id).trim() !== '0'
        ? String(t.team_id)
        : '';
    setAssignTeamId(prefTeam);
    setAssignDriverId('');
    setAssignOpen(true);
    setChangeStatusOpen(false);
    setEditOpen(false);
  };

  const cancelAssignModal = () => {
    if (actionLoading) return;
    setAssignOpen(false);
    setAssignTeamId('');
    setAssignDriverId('');
  };

  useEffect(() => {
    if (!assignOpen) return;
    api('teams').then((t) => setTeams(Array.isArray(t) ? t : (t?.teams || []))).catch(() => setTeams([]));
    api('drivers').then((d) => setDrivers(Array.isArray(d) ? d : (d?.drivers || []))).catch(() => setDrivers([]));
  }, [assignOpen]);

  const prevAssignTeamRef = useRef('');
  useEffect(() => {
    if (!assignOpen) {
      prevAssignTeamRef.current = '';
      return;
    }
    const prev = prevAssignTeamRef.current;
    prevAssignTeamRef.current = assignTeamId;
    if (prev !== '' && prev !== assignTeamId) setAssignDriverId('');
  }, [assignOpen, assignTeamId]);

  const doAssign = (e) => {
    e.preventDefault();
    const driver_id = parseInt(assignDriverId, 10);
    const team_id = assignTeamId ? parseInt(assignTeamId, 10) : undefined;
    if (!driver_id) return;
    setActionLoading(true);
    const errandOid = Number(taskId) < 0 ? Math.abs(Number(taskId)) : null;
    const assignPath =
      errandOid != null ? `errand-orders/${errandOid}/assign` : `tasks/${taskId}/assign`;
    api(assignPath, { method: 'PUT', body: JSON.stringify({ driver_id, team_id }) })
      .then(() => {
        setAssignOpen(false);
        setAssignTeamId('');
        setAssignDriverId('');
        const refreshUrl = errandOid != null ? `errand-orders/${errandOid}` : `tasks/${taskId}`;
        return api(refreshUrl);
      })
      .then((res) => {
        if (res && typeof res === 'object' && !res.error) setData(res);
        onTaskListInvalidate?.();
      })
      .catch((err) => alert(userFacingApiError(err) || 'Assign failed'))
      .finally(() => setActionLoading(false));
  };

  const openDeleteConfirm = () => {
    setAssignOpen(false);
    setChangeStatusOpen(false);
    setEditOpen(false);
    setDeleteConfirmOpen(true);
  };

  const cancelDeleteConfirm = () => {
    if (actionLoading) return;
    setDeleteConfirmOpen(false);
  };

  const resolveErrandOrderId = () => {
    const tid = Number(taskId);
    if (Number.isFinite(tid) && tid < 0) return Math.abs(tid);
    const st = data?.task?.st_order_id;
    if (data?.task_source === 'errand' && st != null) {
      const n = parseInt(String(st), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const confirmDeleteTask = () => {
    const errandOid = resolveErrandOrderId();
    setActionLoading(true);
    const delPath = errandOid != null ? `errand-orders/${errandOid}` : `tasks/${taskId}`;
    api(delPath, { method: 'DELETE' })
      .then(() => {
        setDeleteConfirmOpen(false);
        onTaskListInvalidate?.();
        onTaskDeleted?.();
        handleClose();
      })
      .catch((err) => alert(userFacingApiError(err) || 'Delete failed'))
      .finally(() => setActionLoading(false));
  };

  const cancelChangeStatusModal = () => {
    if (actionLoading) return;
    setChangeStatusOpen(false);
    setChangeStatusValue('');
    setChangeStatusReason('');
  };

  const openChangeStatus = () => {
    setAssignOpen(false);
    setEditOpen(false);
    setDeleteConfirmOpen(false);
    setChangeStatusValue('');
    setChangeStatusReason('');
    setChangeStatusOpen(true);
    setTab('details');
  };

  const handleChangeStatus = (e) => {
    e.preventDefault();
    const status = (changeStatusValue || '').trim();
    if (!status) return;
    const errandOid = resolveErrandOrderId();
    const statusPath =
      errandOid != null ? `errand-orders/${errandOid}/status` : `tasks/${taskId}/status`;
    const refreshPath = errandOid != null ? `errand-orders/${errandOid}` : `tasks/${taskId}`;
    setActionLoading(true);
    api(statusPath, { method: 'PUT', body: JSON.stringify({ status, reason: (changeStatusReason || '').trim() || undefined }) })
      .then(() => {
        setChangeStatusOpen(false);
        setChangeStatusValue('');
        setChangeStatusReason('');
        return api(refreshPath)
          .then((res) => {
            if (res && typeof res === 'object' && !res.error) setData(res);
            onTaskListInvalidate?.();
          })
          .catch(() => {
            setData((prev) => (prev && prev.task ? { ...prev, task: { ...prev.task, status } } : prev));
            onTaskListInvalidate?.();
          });
      })
      .catch((err) => alert(userFacingApiError(err) || 'Update failed'))
      .finally(() => setActionLoading(false));
  };

  const openEdit = () => {
    const t = data?.task ?? data;
    const order = data?.order;
    if (!t) return;
    const split = splitContactCountry(t.contact_number);
    setEditContactCountryCode(split.dial);
    setEditForm({
      task_description: displaySanitized(t.task_description) || (t.task_description ?? ''),
      delivery_address: displaySanitized(t.delivery_address) || (t.delivery_address ?? ''),
      customer_name: displaySanitized(t.customer_name) || (t.customer_name ?? ''),
      contact_number: split.national,
      delivery_date: formatDatetimeLocalForInput(t.delivery_date ?? order?.delivery_date),
      email_address: t.email_address ?? '',
    });
    const prefTeam =
      t.team_id != null && String(t.team_id).trim() !== '' && String(t.team_id).trim() !== '0'
        ? String(t.team_id)
        : '';
    setEditTeamId(prefTeam);
    setEditDriverId(
      t.driver_id != null && String(t.driver_id).trim() !== '' && String(t.driver_id).trim() !== '0'
        ? String(t.driver_id)
        : ''
    );
    setChangeStatusOpen(false);
    setChangeStatusValue('');
    setChangeStatusReason('');
    setAssignOpen(false);
    setEditOpen(true);
  };

  const handleSaveEdit = (e) => {
    e.preventDefault();
    const t = data?.task ?? data;
    if (!t) return;
    const errandOid = resolveErrandOrderId();
    const origDriver = t.driver_id != null ? Number(t.driver_id) : 0;
    const origTeam = t.team_id != null ? Number(t.team_id) : 0;
    const newDriver = editDriverId ? parseInt(editDriverId, 10) : 0;
    const newTeam = editTeamId ? parseInt(editTeamId, 10) : 0;
    const assignChanged =
      errandOid == null &&
      newDriver > 0 &&
      newTeam > 0 &&
      (newDriver !== origDriver || newTeam !== origTeam);

    const body = {
      task_description: editForm.task_description,
      delivery_address: editForm.delivery_address,
      customer_name: editForm.customer_name,
      contact_number: `${editContactCountryCode || ''}${String(editForm.contact_number || '').trim()}`,
      delivery_date: formatDeliveryDateForApi(editForm.delivery_date),
      email_address: editForm.email_address || undefined,
    };

    setActionLoading(true);
    const savePath = errandOid != null ? `errand-orders/${errandOid}` : `tasks/${taskId}`;
    const refreshPath = errandOid != null ? `errand-orders/${errandOid}` : `tasks/${taskId}`;

    api(savePath, { method: 'PUT', body: JSON.stringify(body) })
      .then(() => {
        if (assignChanged) {
          return api(`tasks/${taskId}/assign`, {
            method: 'PUT',
            body: JSON.stringify({ driver_id: newDriver, team_id: newTeam }),
          });
        }
        return undefined;
      })
      .then(() => api(refreshPath))
      .then((res) => {
        if (res && typeof res === 'object' && !res.error) setData(res);
        setEditOpen(false);
        onTaskListInvalidate?.();
      })
      .catch((err) => alert(userFacingApiError(err) || 'Update failed'))
      .finally(() => setActionLoading(false));
  };

  const directionsUrl = (() => {
    const t = data?.task ?? data;
    if (!t) return null;
    const pickup = String(t.pickup_address ?? t.drop_address ?? t.merchant_address ?? '').trim();
    const dest = String(t.delivery_address ?? '').trim();
    if (!dest) return null;
    const params = new URLSearchParams({ api: '1', destination: dest });
    if (pickup) params.set('origin', pickup);
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  })();

  const task = data && (data.task ?? data);
  /** Full-screen loader only when we have no row to show yet (avoids flash when list snapshot is provided). */
  const blockingLoad = loading && !task;
  const isErrandTask = data?.task_source === 'errand' || Number(taskId) < 0;
  const hasAssignedDriverForNotify =
    task?.driver_id != null &&
    String(task.driver_id).trim() !== '' &&
    String(task.driver_id).trim() !== '0';
  const notifyOrderIdRaw = isErrandTask ? resolveErrandOrderId() : task?.order_id != null ? parseInt(String(task.order_id), 10) : NaN;
  const notifyOrderId =
    Number.isFinite(notifyOrderIdRaw) && notifyOrderIdRaw > 0 ? notifyOrderIdRaw : undefined;
  const orderDetails = useMemo(() => {
    const raw = Array.isArray(data?.order_details) ? data.order_details : [];
    const hist =
      Array.isArray(orderHistory) && orderHistory.length > 0
        ? orderHistory
        : Array.isArray(data?.order_history)
          ? data.order_history
          : Array.isArray(data?.mt_order_history)
            ? data.mt_order_history
            : [];
    return enrichErrandOrderDetailsFromTimelineRemarks(raw, hist, isErrandTask);
  }, [data?.order_details, data?.order_history, data?.mt_order_history, orderHistory, isErrandTask]);
  const taskManagementDisplayId = (() => {
    if (isErrandTask) {
      if (task?.st_order_id != null) return task.st_order_id;
      const t = Number(taskId);
      if (Number.isFinite(t) && t < 0) return Math.abs(t);
      return taskId;
    }
    return task?.task_id ?? taskId;
  })();
  const order = data?.order ?? null;
  const merchant = data?.merchant ?? null;
  const editTaskTypeLabel = (order?.trans_type ?? task?.trans_type ?? '').toString().trim() || '—';
  const editModalIsPickup = editTaskTypeLabel.toLowerCase().includes('pickup');
  const editPickupMerchantLabel = displaySanitized(merchant?.restaurant_name || task?.restaurant_name || '') || '—';
  const editPickupAddrReadonly =
    displaySanitized(
      task?.pickup_address ||
        task?.merchant_address ||
        [merchant?.street, merchant?.city, merchant?.state].filter(Boolean).join(', ')
    ) || '—';
  const legacyTimeline = Array.isArray(data?.order_status_timeline) ? data.order_status_timeline : [];
  const taskPhotos = Array.isArray(data?.task_photos) ? data.task_photos : [];
  const proofImagesFromTask = Array.isArray(data?.proof_images) ? data.proof_images : [];
  const proofImages =
    proofImagesFromTask.length > 0 ? proofImagesFromTask : orderHistoryProofImages;
  const historyEntries = (orderHistory || [])
    .filter(Boolean)
    .map((row) => ({
      type: 'history',
      id: row.id,
      order_id: row.order_id,
      status: row.status,
      remarks: row.remarks || row.remarks2,
      date_created:
        row.date_created ?? row.created_at ?? row.date_added ?? row.date_modified ?? row.timestamp ?? null,
      reason: row.reason,
      update_by_name: row.update_by_name,
      update_by_type: row.update_by_type,
      driver_id: row.driver_id,
      notes: row.notes,
      latitude: row.latitude,
      longitude: row.longitude,
      ip_address: row.ip_address,
    }));
  /* One timeline row per stored proof (receipt vs delivery are separate events). */
  const photoEntries = (() => {
    if (taskPhotos.length > 0) {
      return taskPhotos.filter(Boolean).map((row) => {
        const proof_kind = timelineProofKindFromRow(row);
        return {
          type: 'photo',
          id: `photo-${row.id}`,
          proof_kind,
          date_created: row.date_created,
          urls: row.proof_url ? [row.proof_url] : [],
          photo_rows: [row],
        };
      });
    }
    if (proofImages.length > 0) {
      return [
        {
          type: 'photo',
          id: 'proof-delivery-bundle',
          proof_kind: 'delivery',
          date_created: null,
          urls: proofImages,
          photo_rows: [],
        },
      ];
    }
    return [];
  })();
  /* Oldest first (initial order at top, successful / latest at bottom) — matches classic rider timeline */
  const combined = [...historyEntries, ...photoEntries].sort((a, b) => {
    const da = a.date_created ? new Date(a.date_created).getTime() : Number.POSITIVE_INFINITY;
    const db = b.date_created ? new Date(b.date_created).getTime() : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const ida = typeof a.id === 'string' && a.id.startsWith('photo-') ? a.id : Number(a.id);
    const idb = typeof b.id === 'string' && b.id.startsWith('photo-') ? b.id : Number(b.id);
    if (typeof ida === 'number' && typeof idb === 'number' && !Number.isNaN(ida) && !Number.isNaN(idb)) {
      return ida - idb;
    }
    return String(a.id).localeCompare(String(b.id));
  });
  const timeline =
    combined.length > 0
      ? combined
      : legacyTimeline
          .map((e) => ({ ...e, type: 'legacy' }))
          .sort((a, b) => {
            const da = a.date_created ? new Date(a.date_created).getTime() : Number.POSITIVE_INFINITY;
            const db = b.date_created ? new Date(b.date_created).getTime() : Number.POSITIVE_INFINITY;
            return da - db;
          });
  const customerName = displaySanitizedOrDash(task?.customer_name);
  const merchantName = (() => {
    const fromMerchant = merchant && String(merchant.restaurant_name ?? '').trim();
    if (fromMerchant) return displaySanitizedOrDash(fromMerchant);
    const fromTaskJoin = task && String(task.restaurant_name || '').trim();
    if (fromTaskJoin) return displaySanitizedOrDash(fromTaskJoin);
    const fromTask = task && String(task.dropoff_merchant || '').trim();
    if (fromTask && !/^\d+$/.test(fromTask)) return displaySanitizedOrDash(fromTask);
    return '—';
  })();
  /** Merchant pickup contact person (mt_merchant.contact_name). */
  const merchantContactNameDisplay = displaySanitizedOrDash(merchant?.contact_name);
  /** Merchant phone for pickup (restaurant line preferred, else contact_phone). */
  const merchantPhoneDisplay = (() => {
    const raw =
      [merchant?.restaurant_phone, merchant?.contact_phone]
        .map((x) => (x != null ? String(x).trim() : ''))
        .find(Boolean) || '';
    return raw ? displaySanitizedOrDash(raw) : '—';
  })();
  const merchantAddressDisplay = (() => {
    if (merchant) {
      const line = [merchant.street, merchant.city, merchant.state, merchant.post_code]
        .filter(Boolean)
        .map((p) => displaySanitized(p))
        .filter(Boolean)
        .join(', ');
      if (line) return line;
    }
    const fallback = [task?.pickup_address, task?.drop_address, task?.merchant_address]
      .map((x) => (x != null ? String(x).trim() : ''))
      .find(Boolean);
    if (fallback) return displaySanitized(fallback) || fallback;
    return '—';
  })();
  const orderDeliveryAddr = data?.order_delivery_address ?? null;
  const clientAddr = data?.client_address;
  const customerDeliveryAddressDisplay = (() => {
    if (isErrandTask) {
      const full =
        (task?.formatted_address != null && String(task.formatted_address).trim()) ||
        (clientAddr?.formatted_address_full != null && String(clientAddr.formatted_address_full).trim()) ||
        (clientAddr?.formatted_address_summary != null && String(clientAddr.formatted_address_summary).trim()) ||
        '';
      const taskDel = task?.delivery_address != null ? String(task.delivery_address).trim() : '';
      const line = full || taskDel;
      return line ? displaySanitizedOrDash(line) : '—';
    }
    const fromOrder = formatDeliveryAddressFromOrderRow(orderDeliveryAddr);
    const fromOrderSan = fromOrder ? displaySanitized(fromOrder) || fromOrder : '';
    const taskDel = task?.delivery_address != null ? String(task.delivery_address).trim() : '';
    const taskDelSan = taskDel ? displaySanitized(taskDel) || taskDel : '';
    return displaySanitizedOrDash(fromOrderSan || taskDelSan);
  })();
  const taskDescriptionDisplay = displaySanitized(task?.task_description) || '—';
  const deliveryInstructionDisplay = displaySanitizedOrDash(
    order?.delivery_instruction ?? task?.delivery_instruction ?? clientAddr?.delivery_instructions
  );
  const landmarkDisplay = displaySanitizedOrDash(
    orderDeliveryAddr?.location_name ?? task?.delivery_landmark ?? clientAddr?.location_name
  );
  const errandAddrStreet = displaySanitizedOrDash(clientAddr?.address1);
  /** Errand-only: street/area line for Transaction (separate from full delivery address). */
  const transactionStreetOrAreaValue = isErrandTask
    ? errandAddrStreet !== '—'
      ? errandAddrStreet
      : displaySanitizedOrDash(clientAddr?.address2 ?? task?.delivery_address)
    : '';
  const teamNameDisplay = displaySanitizedOrDash(task?.team_name);
  const driverNameDisplay = displaySanitizedOrDash(task?.driver_name);
  const orderDeliveryTimeRaw =
    order?.delivery_time != null && String(order.delivery_time).trim() !== ''
      ? order.delivery_time
      : order?.order_delivery_time;
  const taskDeliveryRaw = task?.delivery_date != null ? String(task.delivery_date).trim() : '';
  const taskTimeForCompleteBefore = taskDeliveryRaw
    ? timePartFromTaskDeliveryForCompleteBefore(taskDeliveryRaw)
    : '';
  const completeBefore = (() => {
    if (order?.delivery_date && orderDeliveryTimeRaw) {
      return `${formatDateOnly(order.delivery_date)} ${formatDbTimeTo12h(orderDeliveryTimeRaw)}`.trim();
    }
    if (order?.delivery_date) {
      const datePart = formatDateOnly(order.delivery_date);
      if (taskTimeForCompleteBefore) return `${datePart} ${taskTimeForCompleteBefore}`;
      return datePart;
    }
    if (taskDeliveryRaw) {
      const datePart = formatDateOnly(taskDeliveryRaw);
      if (taskTimeForCompleteBefore) return `${datePart} ${taskTimeForCompleteBefore}`;
      return datePart;
    }
    return '—';
  })();
  const advanceLinesModal = order
    ? getAdvanceOrderLines(
        {
          ...order,
          advance_order_note: task?.advance_order_note,
          task_source: data?.task_source,
          errand_history_status: task?.errand_history_status,
          status: task?.status,
        },
        task?.date_created
      )
    : null;

  const filteredTimeline = timeline.filter(Boolean);
  const hasProofPhotoTimelineItem = filteredTimeline.some((e) => e.type === 'photo');
  const proofHistoryAttachEntry =
    proofImages.length > 0 && !hasProofPhotoTimelineItem
      ? filteredTimeline.find((e) => isProofVerificationHistoryEntry(e))
      : null;

  return (
    <div
      className={`modal-backdrop task-details-backdrop ${editOpen ? 'task-details-backdrop-edit-open' : ''}`}
      onClick={() => !blockingLoad && !editOpen && !changeStatusOpen && !assignOpen && !deleteConfirmOpen && handleClose()}
    >
      <div
        className="modal-box modal-box-lg task-details-modal"
        onClick={(e) => e.stopPropagation()}
        aria-hidden={editOpen ? true : undefined}
      >
        <div className="modal-header task-details-modal-header">
          <h3>
            {isErrandTask ? 'Mangan Order' : 'Task ID'} :{' '}
            {isErrandTask && task?.st_order_id != null
              ? task.st_order_id
              : isErrandTask && Number(taskId) < 0
                ? Math.abs(Number(taskId))
                : task?.task_id ?? taskId ?? '…'}
          </h3>
          {loading && task ? <span className="task-details-updating muted">Updating…</span> : null}
        </div>
        {blockingLoad && (
          <div className="modal-body"><div className="loading">Loading…</div></div>
        )}
        {!blockingLoad && error && (
          <div className="modal-body">
            <p className="muted">{error}</p>
            <div className="modal-footer-actions">
              <button type="button" className="btn" onClick={handleClose}>Close</button>
            </div>
          </div>
        )}
        {!blockingLoad && !error && data && task && (
            <>
              <div className="modal-tabs">
                <button type="button" className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>Task Details</button>
                <button type="button" className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>Activity Timeline</button>
                <button type="button" className={tab === 'order' ? 'active' : ''} onClick={() => setTab('order')}>Order Details</button>
              </div>
              <div className="modal-body">
                {tab === 'details' && (
                  <div className="task-details-content">
                    {advanceLinesModal && (
                      <div className="task-detail-advance-banner" role="status">
                        <div className="task-detail-advance-banner-title">Advance order</div>
                        <div className="task-detail-advance-banner-line">{advanceLinesModal.deliveryLine}</div>
                        {advanceLinesModal.orderedLine ? (
                          <div className="task-detail-advance-banner-line task-detail-advance-banner-line--secondary">
                            {advanceLinesModal.orderedLine}
                          </div>
                        ) : null}
                        {advanceLinesModal.noteLine ? (
                          <div className="task-detail-advance-banner-line task-detail-advance-banner-line--note">
                            {displaySanitized(advanceLinesModal.noteLine) || advanceLinesModal.noteLine}
                          </div>
                        ) : null}
                      </div>
                    )}
                    <div className="task-detail-section task-detail-section-split">
                      <div className="task-detail-col">
                        <div className="task-detail-row task-detail-row-status">
                          <span className="task-detail-label">Status</span>
                          <span className={`task-detail-status-badge ${statusDisplayClass(task.status)}`}>{task.status ?? '—'}</span>
                        </div>
                        <div className="task-detail-row">
                          <span className="task-detail-label">Transaction type</span>
                          <span className="task-detail-value">{order?.trans_type ?? task.trans_type ?? '—'}</span>
                        </div>
                        <div className="task-detail-row">
                          <span className="task-detail-label">Complete before</span>
                          <span className="task-detail-value">{completeBefore}</span>
                        </div>
                      </div>
                      <div className="task-detail-col task-detail-contact">
                        <div className="task-detail-row">
                          <span className="task-detail-label">Name</span>
                          <span className="task-detail-value">{customerName}</span>
                        </div>
                        <div className="task-detail-row task-detail-row-icon">
                          <span className="task-detail-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg></span>
                          <span className="task-detail-value">{task.contact_number ?? order?.contact_number ?? '—'}</span>
                        </div>
                        <div className="task-detail-row task-detail-row-icon">
                          <span className="task-detail-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg></span>
                          <span className="task-detail-value">{task.email_address ?? '—'}</span>
                        </div>
                        <div className="task-detail-row task-detail-row-icon">
                          <span className="task-detail-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg></span>
                          <span className="task-detail-value">{customerDeliveryAddressDisplay}</span>
                        </div>
                      </div>
                    </div>
                    <div className="task-detail-section task-detail-section-row">
                      <div className="task-detail-row">
                        <span className="task-detail-label">Order No</span>
                        <span className="task-detail-value">{order?.order_id ?? task.order_id ?? '—'}</span>
                      </div>
                      <div className="task-detail-row">
                        <span className="task-detail-label">Merchant name</span>
                        <span className="task-detail-value">{merchantName}</span>
                      </div>
                    </div>
                    <div className="task-detail-section task-detail-section-row">
                      <div className="task-detail-row">
                        <span className="task-detail-label">Team</span>
                        <span className="task-detail-value">{teamNameDisplay}</span>
                      </div>
                      <div className="task-detail-row">
                        <span className="task-detail-label">Driver</span>
                        <span className="task-detail-value">{driverNameDisplay}</span>
                      </div>
                      <div className="task-detail-row">
                        <span className="task-detail-label">Phone</span>
                        <span className="task-detail-value">{task.driver_phone ?? '—'}</span>
                      </div>
                      <div className="task-detail-row">
                        <span className="task-detail-label">Verification code</span>
                        <span className="task-detail-value">{task.verification_code ?? '—'}</span>
                      </div>
                    </div>
                    <div className="task-detail-section">
                      <div className="task-detail-section-title">Task description</div>
                      <div className="task-detail-description">{taskDescriptionDisplay}</div>
                    </div>
                    <div className="task-detail-section task-detail-pickup">
                      <div className="task-detail-section-title">Pickup details</div>
                      <div className="task-detail-pickup-grid">
                        <div className="task-detail-pickup-item">
                          <span className="task-detail-label">Merchant</span>
                          <span className="task-detail-value">{merchantName}</span>
                        </div>
                        <div className="task-detail-pickup-item">
                          <span className="task-detail-label">Name</span>
                          <span className="task-detail-value">{merchantContactNameDisplay}</span>
                        </div>
                        <div className="task-detail-pickup-item">
                          <span className="task-detail-label">Merchant contact number</span>
                          <span className="task-detail-value">{merchantPhoneDisplay}</span>
                        </div>
                        <div className="task-detail-pickup-item task-detail-pickup-address">
                          <span className="task-detail-label">Address</span>
                          <span className="task-detail-value">{merchantAddressDisplay}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {tab === 'timeline' && (
                  <div className="task-details-content">
                    <div className="task-detail-section">
                      <div className="activity-timeline activity-timeline--classic">
                        {timeline.length ? filteredTimeline.map((entry, i) => (
                          <div
                            key={entry.id ?? entry.stats_id ?? i}
                            className={`activity-timeline-item ${entry.type === 'photo' ? 'activity-timeline-item-photo' : 'activity-timeline-item-history'}`}
                          >
                            {entry.type === 'photo' ? (
                              <>
                                <div className="activity-timeline-row">
                                  <div className="activity-timeline-content-col">
                                    <div className="activity-timeline-badge-col">
                                      {entry.proof_kind === 'receipt' ? (
                                        <span className="tag status-blue">Proof of receipt</span>
                                      ) : (
                                        <span className="tag status-green">Proof of delivery</span>
                                      )}
                                    </div>
                                    {entry.id === 'proof-delivery-bundle' ? null : (
                                      <div className="activity-timeline-body-col">
                                        <div className="activity-timeline-primary">
                                          {timelinePhotoEntryCaption(task?.driver_name, entry.proof_kind)}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                  <ActivityTimelineMetaCol
                                    task={task}
                                    entry={entry}
                                    dateCreated={entry?.date_created}
                                    onOpenLocation={openTimelineLocation}
                                  />
                                </div>
                                {entry.urls?.length > 0 ? (
                                  <div
                                    className={`activity-timeline-item-extra activity-timeline-proof-grid ${entry.urls.length === 1 ? 'activity-timeline-proof-grid--single' : ''}`}
                                  >
                                    {entry.urls.map((url, idx) => (
                                      <ProofTimelineThumb
                                        key={`${url}-${idx}`}
                                        url={url}
                                        photoId={entry.photo_rows?.[idx]?.id}
                                        photoName={entry.photo_rows?.[idx]?.photo_name}
                                      />
                                    ))}
                                  </div>
                                ) : (
                                  <div className="activity-timeline-item-extra">
                                    {entry.photo_rows?.map((row) => (
                                      <TaskPhotoImage key={row.id} photoId={row.id} photoName={row.photo_name} />
                                    ))}
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                <div className="activity-timeline-row">
                                  <div className="activity-timeline-content-col">
                                    <div className="activity-timeline-badge-col">
                                      <span className={`tag ${statusDisplayClass(entry?.status ?? entry?.description)}`}>
                                        {timelineHistoryBadgeLabel(entry)}
                                      </span>
                                    </div>
                                    <div className="activity-timeline-body-col">
                                      {(() => {
                                        const primary = timelineHistoryPrimaryText(entry);
                                        if (primary) {
                                          return <div className="activity-timeline-primary">{primary}</div>;
                                        }
                                        const by = String(entry?.update_by_name ?? entry?.update_by_type ?? '').trim();
                                        if (by) {
                                          return <span className="activity-timeline-by">by {by}</span>;
                                        }
                                        return null;
                                      })()}
                                    </div>
                                  </div>
                                  <ActivityTimelineMetaCol
                                    task={task}
                                    entry={entry}
                                    dateCreated={entry?.date_created}
                                    onOpenLocation={openTimelineLocation}
                                  />
                                </div>
                                {proofHistoryAttachEntry === entry && proofImages.length > 0 && (
                                  <div
                                    className={`activity-timeline-item-extra activity-timeline-proof-grid activity-timeline-proof-grid--embedded ${proofImages.length === 1 ? 'activity-timeline-proof-grid--single' : ''}`}
                                  >
                                    {proofImages.map((url, idx) => (
                                      <ProofTimelineThumb
                                        key={`embed-${url}-${idx}`}
                                        url={url}
                                        photoId={taskPhotos[idx]?.id}
                                        photoName={taskPhotos[idx]?.photo_name}
                                      />
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )) : (
                          <p className="muted">No activity yet.</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {tab === 'order' && (
                  <div className="task-details-content order-details-panel order-details-panel--ref">
                    <div className="order-details-quick-row">
                      <div className="order-details-quick-cell">
                        <span className="order-details-quick-label">CUSTOMER CONTACT NUMBER</span>
                        <span className="order-details-quick-value">{task.contact_number ?? order?.contact_number ?? '—'}</span>
                      </div>
                      <div className="order-details-quick-cell order-details-quick-cell--end">
                        <span className="order-details-quick-label">CHANGE</span>
                        <span className="order-details-quick-value order-details-quick-value--emphasis">
                          {order?.order_change != null ? `₱${Number(order.order_change).toFixed(2)}` : '—'}
                        </span>
                      </div>
                    </div>
                    <div className="task-detail-section">
                      <div className="task-detail-section-title">Customer & merchant</div>
                      <div className="task-detail-section-split">
                        <div className="task-detail-col">
                          <div className="task-detail-row"><span className="task-detail-label">Customer name</span><span className="task-detail-value">{customerName}</span></div>
                          <div className="task-detail-row"><span className="task-detail-label">Merchant Telephone</span><span className="task-detail-value">{merchant?.restaurant_phone ?? '—'}</span></div>
                        </div>
                        <div className="task-detail-col">
                          <div className="task-detail-row"><span className="task-detail-label">Merchant name</span><span className="task-detail-value">{merchantName}</span></div>
                          <div className="task-detail-row"><span className="task-detail-label">Merchant Address</span><span className="task-detail-value">{merchantAddressDisplay}</span></div>
                        </div>
                      </div>
                    </div>
                    <div className="task-detail-section">
                      <div className="task-detail-section-title">Transaction</div>
                      <div className="task-detail-section-row">
                        <div className="task-detail-row"><span className="task-detail-label">TRN type</span><span className="task-detail-value">{order?.trans_type ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Payment type</span><span className="task-detail-value">{order?.payment_type ?? task.payment_type ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Reference #</span><span className="task-detail-value">{order?.order_id ?? task.order_id ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">TRN date</span><span className="task-detail-value">{order?.date_created ? formatDate(order.date_created) : '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Delivery date</span><span className="task-detail-value">{order?.delivery_date ? formatDateOnly(order.delivery_date) : '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Delivery time</span><span className="task-detail-value">{orderDeliveryTimeRaw ? formatDbTimeTo12h(orderDeliveryTimeRaw) : '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Delivery address</span><span className="task-detail-value">{customerDeliveryAddressDisplay}</span></div>
                        {isErrandTask && (
                          <div className="task-detail-row">
                            <span className="task-detail-label">Street / area</span>
                            <span className="task-detail-value">{transactionStreetOrAreaValue}</span>
                          </div>
                        )}
                        <div className="task-detail-row"><span className="task-detail-label">Delivery instruction</span><span className="task-detail-value">{deliveryInstructionDisplay}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Landmark</span><span className="task-detail-value">{landmarkDisplay}</span></div>
                      </div>
                    </div>
                    {orderDetails.length > 0 && (() => {
                      const details = orderDetails.filter(Boolean);
                      const indexByKey = new Map();
                      const categoryBuckets = [];
                      details.forEach((item, i) => {
                        const { key: normKey, label } = orderItemGroupMeta(item);
                        let idx = indexByKey.get(normKey);
                        if (idx === undefined) {
                          idx = categoryBuckets.length;
                          indexByKey.set(normKey, idx);
                          categoryBuckets.push({ key: normKey, label, items: [] });
                        }
                        categoryBuckets[idx].items.push({ ...item, _idx: i });
                      });
                      categoryBuckets.sort((a, b) => {
                        if (a.key === '__other__') return 1;
                        if (b.key === '__other__') return -1;
                        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
                      });
                      return (
                        <div className="task-detail-section order-ref-ordered-section">
                          <div className="order-ref-section-heading">Ordered items</div>
                          <div className="order-ref-card order-ref-card--panel" role="region" aria-label="Ordered items">
                            {categoryBuckets.map(({ key, label, items }, bucketIdx) => (
                              <div
                                key={key}
                                className={`order-ref-category-block${bucketIdx > 0 ? ' order-ref-category-block--split' : ''}`}
                              >
                                <div className="order-ref-card-category">{formatOrderRefCategoryHeader(label)}</div>
                                <ul className="order-ref-items-list">
                                  {items.map((item) => {
                                    const qty = Number(item.qty) || 0;
                                    const unitPrice = orderLineUnitPrice(item);
                                    const subtotal = unitPrice != null && !Number.isNaN(unitPrice) ? qty * unitPrice : null;
                                    const unitStr = unitPrice != null && !Number.isNaN(unitPrice) ? `₱${unitPrice.toFixed(2)}` : '—';
                                    const subtotalStr = subtotal != null ? `₱${subtotal.toFixed(2)}` : '—';
                                    const nameRaw = item.item_name_display || item.item_name;
                                    const namePick = pickLocalizedMenuString(nameRaw);
                                    const rawStr = nameRaw != null ? String(nameRaw).trim() : '';
                                    const lineName = (namePick && (displaySanitized(namePick) || namePick))
                                      || displaySanitized(nameRaw)
                                      || (rawStr.startsWith('{') && rawStr.includes('"') ? 'Item' : rawStr)
                                      || 'Item';
                                    const sizePick = item.size ? pickLocalizedMenuString(item.size) : '';
                                    const sizePart = item.size
                                      ? ` (${displaySanitized(sizePick || item.size) || sizePick || item.size})`
                                      : '';
                                    const addonLines = parseOrderLineAddonsFromItem(item);
                                    return (
                                      <li key={item.id ?? item._idx} className="order-ref-item-row">
                                        <div className="order-ref-item-line">
                                          <div className="order-ref-item-text">
                                            <span className="order-ref-item-title">
                                              {qty}x {lineName}{sizePart}
                                            </span>
                                            {unitStr !== '—' ? (
                                              <span className="order-ref-item-unit" aria-label="Unit price">{unitStr}</span>
                                            ) : null}
                                          </div>
                                          <span className="order-ref-item-line-total">{subtotalStr}</span>
                                        </div>
                                        {addonLines.length > 0 ? (
                                          <ul className="order-ref-addon-list" aria-label="Add-ons">
                                            {addonLines.map((ad, ai) => {
                                              const nameDisp = displaySanitized(ad.name) || ad.name;
                                              const catDisp = ad.category ? displaySanitized(ad.category) || ad.category : null;
                                              const left =
                                                ad.qty > 1
                                                  ? `${ad.qty}× ${catDisp ? `${catDisp} · ` : ''}${nameDisp}`
                                                  : `${catDisp ? `${catDisp} · ` : ''}${nameDisp}`;
                                              return (
                                                <li key={ai} className="order-ref-addon-row">
                                                  <span className="order-ref-addon-label">{left}</span>
                                                  <span className="order-ref-addon-price">₱{ad.price.toFixed(2)}</span>
                                                </li>
                                              );
                                            })}
                                          </ul>
                                        ) : null}
                                        {item.order_notes && (
                                          <div className="order-item-notes">{displaySanitized(item.order_notes) || item.order_notes}</div>
                                        )}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    {(order?.sub_total != null || order?.total_w_tax != null) && (() => {
                      const convRaw =
                        order.packaging != null && String(order.packaging).trim() !== ''
                          ? order.packaging
                          : order.packaging_fee != null && String(order.packaging_fee).trim() !== ''
                            ? order.packaging_fee
                            : order.convenience_fee;
                      const convNum = convRaw != null && String(convRaw).trim() !== '' ? Number(convRaw) : NaN;
                      const convenienceDisplay = !Number.isNaN(convNum) ? `₱${convNum.toFixed(2)}` : '—';
                      const deliveryRaw = isErrandTask
                        ? (order.delivery_fee ?? order.deliveryFee ?? null)
                        : (order.delivery_charge ?? order.deliveryCharge ?? order.order_delivery_charge ?? null);
                      const deliveryNum =
                        deliveryRaw != null && String(deliveryRaw).trim() !== '' ? Number(deliveryRaw) : NaN;
                      const deliveryDisplay = !Number.isNaN(deliveryNum) ? `₱${deliveryNum.toFixed(2)}` : '—';
                      const tipRow = formatOrderTipRow(order);
                      return (
                        <div className="task-detail-section order-summary-block order-summary-block--ref">
                          <div className="order-ref-section-heading">Order summary</div>
                          <div className="order-ref-card order-ref-card--panel order-summary-ref-panel" role="region" aria-label="Order summary">
                            <div className="order-summary-ref-grid">
                              <div className="order-summary-ref-cell">
                                <span className="order-summary-ref-label">SUB TOTAL</span>
                                <span className="order-summary-ref-value">{order.sub_total != null ? `₱${Number(order.sub_total).toFixed(2)}` : '—'}</span>
                              </div>
                              <div className="order-summary-ref-cell">
                                <span className="order-summary-ref-label">CONVENIENCE</span>
                                <span className="order-summary-ref-value">{convenienceDisplay}</span>
                              </div>
                              <div className="order-summary-ref-cell">
                                <span className="order-summary-ref-label">DELIVERY FEE</span>
                                <span className="order-summary-ref-value">{deliveryDisplay}</span>
                              </div>
                              <div className="order-summary-ref-cell">
                                <span className="order-summary-ref-label">{tipRow.summaryLabel}</span>
                                <span className="order-summary-ref-value">{tipRow.display}</span>
                              </div>
                              <div className="order-summary-ref-cell">
                                <span className="order-summary-ref-label">TOTAL</span>
                                <span className="order-summary-ref-value order-summary-ref-value--total">{order?.total_w_tax != null ? `₱${Number(order.total_w_tax).toFixed(2)}` : '—'}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
              <div className="modal-footer-actions task-details-footer-actions">
                {(String(task.status || '').toLowerCase() === 'unassigned') && (
                  <>
                    <button type="button" className="btn btn-primary" onClick={openAssignModal} disabled={actionLoading}>Assign driver</button>
                  </>
                )}
                {(String(task.status || '').toLowerCase() !== 'unassigned') && !assignOpen && (
                  <button type="button" className="btn btn-primary" onClick={openAssignModal} disabled={actionLoading}>
                    Re-assign Agent
                  </button>
                )}
                {!changeStatusOpen && !editOpen && !assignOpen && (
                  <button type="button" className="btn" onClick={openEdit} disabled={actionLoading}>Edit task</button>
                )}
                {!changeStatusOpen && !editOpen && !assignOpen && (
                  <button type="button" className="btn" onClick={openChangeStatus} disabled={actionLoading}>Change status</button>
                )}
                <CustomerNotifyButton
                  taskId={taskId}
                  orderId={notifyOrderId}
                  disabled={actionLoading || !hasAssignedDriverForNotify}
                />
                {directionsMapSettings && (
                  <button type="button" className="btn" onClick={openDirectionsModal} disabled={actionLoading}>
                    Get directions
                  </button>
                )}
                {directionsUrl && (
                  <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className="btn">Open in Google Maps</a>
                )}
                <button type="button" className="btn" onClick={openDeleteConfirm} disabled={actionLoading}>Delete task</button>
                <button type="button" className="btn" onClick={handleClose}>Close</button>
              </div>
            </>
        )}
      </div>
      {assignOpen && (
        <div
          className="task-modal-nested-overlay"
          role="presentation"
          onClick={cancelAssignModal}
        >
          <div
            className="modal-box task-detail-assign-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-assign-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="task-assign-modal-title">
                {isErrandTask ? 'Mangan Order' : 'Task ID'} :{' '}
                {isErrandTask && task?.st_order_id != null ? task.st_order_id : task?.task_id ?? taskId ?? '…'}
              </h3>
              <button
                type="button"
                className="task-detail-edit-modal-close"
                onClick={cancelAssignModal}
                disabled={actionLoading}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <form onSubmit={doAssign} className="task-detail-assign-form">
                <label className="modal-label" htmlFor="task-assign-team">Select team</label>
                <select
                  id="task-assign-team"
                  className="form-control"
                  value={assignTeamId}
                  onChange={(e) => setAssignTeamId(e.target.value)}
                  disabled={actionLoading}
                  aria-label="Select team"
                >
                  <option value="">Select team</option>
                  {(teams || []).map((t) => (
                    <option key={t.team_id ?? t.id} value={String(t.team_id ?? t.id)}>
                      {t.team_name ?? t.name ?? `Team ${t.team_id ?? t.id}`}
                    </option>
                  ))}
                </select>
                {!!assignTeamId && (
                  <>
                    <label className="modal-label" htmlFor="task-assign-driver">Select driver</label>
                    <select
                      id="task-assign-driver"
                      className="form-control"
                      value={assignDriverId}
                      onChange={(e) => setAssignDriverId(e.target.value)}
                      disabled={actionLoading}
                      required
                      aria-label="Select driver"
                    >
                      <option value="">Select driver</option>
                      {(drivers || [])
                        .filter((d) => String(d.team_id ?? d.team) === String(assignTeamId))
                        .map((d) => (
                          <option key={d.driver_id ?? d.id} value={String(d.driver_id ?? d.id)}>
                            {d.full_name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.username || d.email || `Driver ${d.driver_id ?? d.id}`}
                          </option>
                        ))}
                    </select>
                  </>
                )}
                <div className="task-detail-assign-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={actionLoading || !assignTeamId || !assignDriverId}
                  >
                    {actionLoading ? 'Submitting…' : 'Submit'}
                  </button>
                  <button type="button" className="btn" onClick={cancelAssignModal} disabled={actionLoading}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
      {changeStatusOpen && (
        <div
          className="task-modal-nested-overlay"
          role="presentation"
          onClick={cancelChangeStatusModal}
        >
          <div
            className="modal-box task-detail-change-status-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-change-status-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="task-change-status-modal-title">
                {isErrandTask ? 'Mangan Order' : 'Task ID'} : {taskManagementDisplayId ?? '…'}
              </h3>
              <button
                type="button"
                className="task-detail-edit-modal-close"
                onClick={cancelChangeStatusModal}
                disabled={actionLoading}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <form onSubmit={handleChangeStatus} className="task-detail-change-status-form">
                <label className="modal-label" htmlFor="task-change-status-select">Status</label>
                <select
                  id="task-change-status-select"
                  className="form-control task-change-status-select"
                  value={changeStatusValue}
                  onChange={(e) => setChangeStatusValue(e.target.value)}
                  required
                  disabled={actionLoading}
                  aria-label="Task status"
                >
                  <option value="">Please select status</option>
                  {TASK_CHANGE_STATUS_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <label className="modal-label task-change-status-reason-label" htmlFor="task-change-status-reason">Reason (optional)</label>
                <input
                  id="task-change-status-reason"
                  type="text"
                  className="form-control"
                  placeholder="Reason (optional)"
                  value={changeStatusReason}
                  onChange={(e) => setChangeStatusReason(e.target.value)}
                  disabled={actionLoading}
                />
                <div className="task-change-status-actions">
                  <button type="submit" className="btn btn-primary" disabled={actionLoading}>
                    {actionLoading ? 'Updating…' : 'Update'}
                  </button>
                  <button type="button" className="btn" onClick={cancelChangeStatusModal} disabled={actionLoading}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
      {deleteConfirmOpen && (
        <div
          className="task-modal-nested-overlay task-delete-overlay"
          role="presentation"
          onClick={cancelDeleteConfirm}
        >
          <div
            className="modal-box task-detail-delete-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-delete-confirm-title"
            aria-describedby="task-delete-confirm-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="task-delete-confirm-close"
              onClick={cancelDeleteConfirm}
              disabled={actionLoading}
              aria-label="Close"
            >
              ×
            </button>
            <div className="task-delete-confirm-visual" aria-hidden="true">
              <span className="task-delete-confirm-icon-wrap">
                <svg className="task-delete-confirm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6" />
                </svg>
              </span>
            </div>
            <div className="modal-body task-detail-delete-confirm-body">
              <h3 id="task-delete-confirm-title" className="task-delete-confirm-title">
                Delete this task?
              </h3>
              <p id="task-delete-confirm-desc" className="task-detail-delete-confirm-text">
                This removes the task from the system permanently. Orders or history linked to it may be affected.
              </p>
              <div className="task-delete-confirm-id-row">
                <span className="task-delete-confirm-id-label">{isErrandTask ? 'Order' : 'Task ID'}</span>
                <span className="task-delete-confirm-id-value">#{taskManagementDisplayId ?? taskId}</span>
              </div>
              <div className="task-detail-delete-confirm-actions">
                <button
                  type="button"
                  className="btn task-delete-confirm-btn-cancel"
                  onClick={cancelDeleteConfirm}
                  disabled={actionLoading}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn task-delete-confirm-btn-delete"
                  onClick={confirmDeleteTask}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Deleting…' : 'Delete task'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {editOpen && task && (
        <div
          className="task-detail-edit-modal new-task-modal"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-edit-modal-title"
        >
          <header className="new-task-modal-header">
            <h1 id="task-edit-modal-title" className="new-task-modal-title">
              Edit task
              {task?.task_id != null ? (
                <span className="task-detail-edit-task-id">
                  {' '}
                  · {isErrandTask ? 'Order' : 'Task ID'} {taskManagementDisplayId ?? task.task_id}
                </span>
              ) : null}
            </h1>
            <button type="button" className="new-task-modal-close" onClick={() => setEditOpen(false)} aria-label="Close" disabled={actionLoading}>
              ×
            </button>
          </header>
          <div className="new-task-modal-body">
            <div className="new-task-form-col">
              <form className="new-task-form" onSubmit={handleSaveEdit}>
                <div className="new-task-field">
                  <label className="new-task-label" htmlFor="edit-task-description">Task description</label>
                  <textarea
                    id="edit-task-description"
                    className="new-task-input new-task-textarea"
                    rows={3}
                    value={editForm.task_description}
                    onChange={(e) => setEditForm((f) => ({ ...f, task_description: e.target.value }))}
                    placeholder="Enter task details…"
                  />
                </div>
                <div className="new-task-field">
                  <span className="new-task-label">Task type</span>
                  <p className="new-task-type-hint task-detail-edit-readonly-type">{editTaskTypeLabel}</p>
                </div>
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label" htmlFor="edit-contact-number">Customer contact number</label>
                    <div className="new-task-contact-wrap">
                      <CountryCodeDropdown
                        value={editContactCountryCode}
                        onChange={(dial) => setEditContactCountryCode(dial)}
                        ariaLabel="Country code"
                      />
                      <input
                        id="edit-contact-number"
                        type="text"
                        className="new-task-contact-input"
                        value={editForm.contact_number}
                        onChange={(e) => setEditForm((f) => ({ ...f, contact_number: e.target.value }))}
                        placeholder="Phone number"
                      />
                    </div>
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label" htmlFor="edit-email">Email address</label>
                    <input
                      id="edit-email"
                      type="email"
                      className="new-task-input"
                      value={editForm.email_address}
                      onChange={(e) => setEditForm((f) => ({ ...f, email_address: e.target.value }))}
                      placeholder="Email address"
                    />
                  </div>
                </div>
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label" htmlFor="edit-customer-name">Name</label>
                    <input
                      id="edit-customer-name"
                      type="text"
                      className="new-task-input"
                      value={editForm.customer_name}
                      onChange={(e) => setEditForm((f) => ({ ...f, customer_name: e.target.value }))}
                      placeholder="Customer name"
                    />
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label" htmlFor="edit-delivery-date">
                      {editModalIsPickup ? 'Pickup before' : 'Delivery before'}
                    </label>
                    <input
                      id="edit-delivery-date"
                      type="datetime-local"
                      className="new-task-input"
                      value={editForm.delivery_date}
                      onChange={(e) => setEditForm((f) => ({ ...f, delivery_date: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="new-task-field">
                  <label className="new-task-label" htmlFor="edit-delivery-address">
                    {editModalIsPickup ? 'Pickup address' : 'Delivery address'}
                  </label>
                  <input
                    id="edit-delivery-address"
                    type="text"
                    className="new-task-input"
                    value={editForm.delivery_address}
                    onChange={(e) => setEditForm((f) => ({ ...f, delivery_address: e.target.value }))}
                    placeholder="Street address"
                  />
                </div>
                <h3 className="new-task-section-title">Pickup details</h3>
                <div className="new-task-field">
                  <label className="new-task-label">Merchant</label>
                  <input type="text" className="new-task-input" readOnly value={editPickupMerchantLabel} tabIndex={-1} aria-readonly="true" />
                </div>
                <div className="new-task-field">
                  <label className="new-task-label">Pickup / merchant address</label>
                  <textarea className="new-task-input new-task-textarea" readOnly rows={2} value={editPickupAddrReadonly} tabIndex={-1} aria-readonly="true" />
                </div>
                <div className="new-task-field">
                  <label className="new-task-label" htmlFor="edit-select-team">Select team</label>
                  <select
                    id="edit-select-team"
                    className="new-task-input new-task-select"
                    value={editTeamId}
                    onChange={(e) => setEditTeamId(e.target.value)}
                    disabled={actionLoading}
                    aria-label="Select team"
                  >
                    <option value="">Select a team</option>
                    {(editTeams || []).map((tm) => (
                      <option key={tm.team_id ?? tm.id} value={String(tm.team_id ?? tm.id)}>
                        {tm.team_name ?? tm.name ?? `Team ${tm.team_id ?? tm.id}`}
                      </option>
                    ))}
                  </select>
                </div>
                {!!editTeamId && (
                  <div className="new-task-field">
                    <label className="new-task-label" htmlFor="edit-assign-agent">Select driver</label>
                    <select
                      id="edit-assign-agent"
                      className="new-task-input new-task-select"
                      value={editDriverId}
                      onChange={(e) => setEditDriverId(e.target.value)}
                      disabled={actionLoading}
                      aria-label="Select driver"
                    >
                      <option value="">Select driver</option>
                      {(editDrivers || [])
                        .filter((d) => String(d.team_id ?? d.team) === String(editTeamId))
                        .map((d) => (
                          <option key={d.driver_id ?? d.id} value={String(d.driver_id ?? d.id)}>
                            {d.full_name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.username || d.email || `Driver ${d.driver_id ?? d.id}`}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
                <div className="new-task-actions">
                  <button type="submit" className="new-task-btn new-task-btn-submit" disabled={actionLoading}>
                    {actionLoading ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" className="new-task-btn new-task-btn-cancel" onClick={() => setEditOpen(false)} disabled={actionLoading}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
            <div className="new-task-map-col">
              {!editModalIsPickup && (
                <>
                  <div className="new-task-map-wrap new-task-map-customer">
                    <p className="new-task-map-label">Customer location</p>
                    <div className="new-task-map-inner">
                      <MapView
                        key={`edit-task-customer-${taskId}`}
                        locations={[]}
                        merchants={[]}
                        mapProvider={editMapProvider}
                        apiKey={editGoogleApiKey}
                        mapboxToken={editMapboxToken}
                        center={[12.8797, 121.774]}
                        zoom={4}
                        googleMapStyle={editGoogleMapStyle}
                      />
                    </div>
                  </div>
                  <div className="new-task-map-wrap new-task-map-merchant">
                    <p className="new-task-map-label">Merchant / Restaurant location</p>
                    <div className="new-task-map-inner">
                      <MapView
                        key={`edit-task-merchant-${taskId}`}
                        locations={[]}
                        merchants={[]}
                        mapProvider={editMapProvider}
                        apiKey={editGoogleApiKey}
                        mapboxToken={editMapboxToken}
                        center={[12.8797, 121.774]}
                        zoom={4}
                        googleMapStyle={editGoogleMapStyle}
                      />
                    </div>
                  </div>
                </>
              )}
              {editModalIsPickup && (
                <>
                  <div className="new-task-map-wrap new-task-map-customer">
                    <p className="new-task-map-label">Pickup location</p>
                    <div className="new-task-map-inner">
                      <MapView
                        key={`edit-task-pickup-${taskId}`}
                        locations={[]}
                        merchants={[]}
                        mapProvider={editMapProvider}
                        apiKey={editGoogleApiKey}
                        mapboxToken={editMapboxToken}
                        center={[12.8797, 121.774]}
                        zoom={4}
                        googleMapStyle={editGoogleMapStyle}
                      />
                    </div>
                  </div>
                  <div className="new-task-map-wrap new-task-map-merchant">
                    <p className="new-task-map-label">Drop location</p>
                    <div className="new-task-map-inner">
                      <MapView
                        key={`edit-task-drop-${taskId}`}
                        locations={[]}
                        merchants={[]}
                        mapProvider={editMapProvider}
                        apiKey={editGoogleApiKey}
                        mapboxToken={editMapboxToken}
                        center={[12.8797, 121.774]}
                        zoom={4}
                        googleMapStyle={editGoogleMapStyle}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {locationPreview != null && (
        <LocationPreviewModal
          lat={locationPreview.lat}
          lng={locationPreview.lng}
          startLat={locationPreview.startLat}
          startLng={locationPreview.startLng}
          startLegendLabel={locationPreview.startLegendLabel || 'Accepted here'}
          mapboxToken={directionsMapSettings?.mapboxToken || ''}
          onClose={() => setLocationPreview(null)}
          caption={
            task
              ? displaySanitized(task.delivery_address) ||
                displaySanitized(task.delivery_landmark) ||
                ''
              : ''
          }
        />
      )}
      {directionsContext != null && directionsMapSettings && (
        <DirectionsModal
          onClose={() => setDirectionsContext(null)}
          taskId={directionsContext.taskId}
          origin={directionsContext.origin}
          destination={directionsContext.destination}
          destinationCoords={directionsContext.destinationCoords}
          mapProvider={directionsMapSettings.mapProvider === 'google' ? 'google' : 'mapbox'}
          mapboxToken={directionsMapSettings.mapboxToken || ''}
          googleApiKey={directionsMapSettings.googleApiKey || ''}
          googleMapStyle={directionsMapSettings.googleMapStyle || ''}
          externalMapsUrl={directionsContext.externalMapsUrl}
        />
      )}
    </div>
  );
}
