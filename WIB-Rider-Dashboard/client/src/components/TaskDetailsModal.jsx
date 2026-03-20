import { useState, useEffect } from 'react';
import { api, formatDate, statusDisplayClass } from '../api';
import { sanitizeLocationDisplayName, pickLocalizedMenuString } from '../utils/displayText';
import { getAdvanceOrderLines } from '../utils/advanceOrder';

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

/** Title-case category heading for order line groups (e.g. mt_category.category_name). */
function formatCategoryTitle(str) {
  const t = (str || '').trim();
  if (!t) return '';
  const cleaned = displaySanitized(t) || t;
  if (!cleaned.trim()) return '';
  return cleaned.trim().replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
}

/** Display category like legacy driver UI: bold uppercase (e.g. MAIN, NON-COFFEE (DRINKS)). */
function formatOrderItemsCategoryHeader(label) {
  if (!label || !String(label).trim()) return 'ITEMS';
  const t = String(label).trim();
  if (t.toLowerCase() === 'other items') return 'ITEMS';
  return t
    .split(' — ')
    .map((part) => part.trim().toUpperCase())
    .join(' — ');
}

/** Line item title: resolve JSON locale blobs from API / DB. */
function displayOrderItemName(item) {
  const raw = item.item_name_display ?? item.item_name;
  const picked = pickLocalizedMenuString(raw);
  if (picked) return sanitizeLocationDisplayName(picked) || picked;
  const str = raw != null ? String(raw).trim() : '';
  if (str.startsWith('{') && /"en"|"EN"|"CSTM"|"ADMIN"/i.test(str)) return 'Item';
  return displaySanitized(str) || 'Item';
}

function displayOrderItemSize(size) {
  if (size == null || String(size).trim() === '') return '';
  const picked = pickLocalizedMenuString(size);
  if (picked) return sanitizeLocationDisplayName(picked) || picked;
  return displaySanitized(size) || String(size).trim();
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

/** Order summary row: mt_order.cart_tip_percentage + cart_tip_value. */
function formatOrderTipRow(order) {
  if (!order || typeof order !== 'object') return { label: 'Tips', display: '—' };
  const valRaw = order.cart_tip_value;
  const pctRaw = order.cart_tip_percentage;
  const valNum = valRaw != null && String(valRaw).trim() !== '' ? Number(valRaw) : NaN;
  const pctNum = pctRaw != null && String(pctRaw).trim() !== '' ? Number(pctRaw) : NaN;
  let pctLabel = null;
  if (!Number.isNaN(pctNum) && pctNum > 0) {
    const rounded = Math.round(pctNum * 10000) / 10000;
    pctLabel = Number.isInteger(rounded) ? String(rounded) : String(parseFloat(rounded.toFixed(4)));
  }
  const label = pctLabel ? `Tips ${pctLabel}%` : 'Tips';
  const display = !Number.isNaN(valNum) ? `₱${valNum.toFixed(2)}` : '—';
  return { label, display };
}

/** Normalize photo filename: strip duplicate extension (e.g. .jpg.jpg -> .jpg). */
function normalizePhotoName(photoName) {
  if (!photoName || typeof photoName !== 'string') return '';
  const s = photoName.trim();
  let name = s;
  const doubleExt = /\.(jpg|jpeg|png|gif|webp)\.(jpg|jpeg|png|gif|webp)$/i.exec(s);
  if (doubleExt) name = s.slice(0, -(doubleExt[1].length + 1));
  return name;
}

/** Build task photo URL. Tries task_photos subfolder first; use tryRootOnError to also try /uploads/{name} when the first 404s. */
function taskPhotoUrl(photoName, useRoot = false) {
  if (!photoName || typeof photoName !== 'string') return '';
  const s = photoName.trim();
  if (s.startsWith('http') || s.startsWith('/')) return s;
  const name = normalizePhotoName(s);
  if (!name) return '';
  if (useRoot) return `/uploads/${encodeURIComponent(name)}`;
  return `/uploads/task_photos/${encodeURIComponent(name)}`;
}

/** Renders proof-of-delivery image. Uses /api/task-photos/:id/image when photoId is set (image from DB); otherwise tries uploads paths. */
function TaskPhotoImage({ photoId, photoName }) {
  const [useRoot, setUseRoot] = useState(false);
  const apiImageUrl = photoId ? `/api/task-photos/${encodeURIComponent(photoId)}/image` : null;
  const uploadsUrl = taskPhotoUrl(photoName, useRoot);
  const url = apiImageUrl || uploadsUrl;
  return (
    <div className="activity-timeline-photo-wrap">
      <a href={url} target="_blank" rel="noopener noreferrer" className="activity-timeline-photo-link">
        <img
          src={url}
          alt="Proof of delivery"
          className="activity-timeline-photo"
          loading="lazy"
          onError={() => { if (!useRoot && !apiImageUrl) setUseRoot(true); }}
        />
      </a>
    </div>
  );
}

const TASK_STATUS_OPTIONS = ['unassigned', 'assigned', 'acknowledged', 'started', 'inprogress', 'successful', 'failed', 'declined', 'cancelled', 'canceled', 'delivered', 'completed'];

export default function TaskDetailsModal({ taskId, onClose, onAssignDriver, onTaskDeleted, onShowDirections }) {
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

  useEffect(() => {
    if (!taskId) {
      setData(null);
      setOrderHistory([]);
      setError(null);
      setTab('details');
      return;
    }
    setData(null);
    setOrderHistory([]);
    setError(null);
    setTab('details');
    setLoading(true);
    api(`tasks/${taskId}`)
      .then((res) => {
        if (res && typeof res === 'object' && !res.error) {
          setData(res);
          const fromTask = Array.isArray(res.order_history) ? res.order_history : Array.isArray(res.mt_order_history) ? res.mt_order_history : [];
          if (fromTask.length > 0) {
            setOrderHistory(fromTask);
          }
        } else {
          setData(null);
          setError(res?.error || 'Failed to load task');
        }
      })
      .catch((err) => {
        setData(null);
        setError(err?.error || err?.message || 'Failed to load task');
      })
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !data?.task) return;
    const fromTask = Array.isArray(data.order_history) ? data.order_history : Array.isArray(data.mt_order_history) ? data.mt_order_history : [];
    if (fromTask.length > 0) return;
    api(`tasks/${taskId}/order-history`)
      .then((list) => setOrderHistory(Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : list?.order_history || []))
      .catch(() => setOrderHistory([]));
  }, [taskId, data?.task, data?.order_history, data?.mt_order_history]);

  if (!taskId) return null;

  const handleClose = () => {
    onClose?.();
  };

  const handleAssignDriver = () => {
    setAssignOpen(true);
    setChangeStatusOpen(false);
    setEditOpen(false);
  };

  useEffect(() => {
    if (!assignOpen) return;
    api('teams').then((t) => setTeams(Array.isArray(t) ? t : (t?.teams || []))).catch(() => setTeams([]));
    api('drivers').then((d) => setDrivers(Array.isArray(d) ? d : (d?.drivers || []))).catch(() => setDrivers([]));
  }, [assignOpen]);

  useEffect(() => {
    if (!assignOpen) return;
    // Reset driver when team changes
    setAssignDriverId('');
  }, [assignOpen, assignTeamId]);

  const doAssign = (e) => {
    e.preventDefault();
    const driver_id = parseInt(assignDriverId, 10);
    const team_id = assignTeamId ? parseInt(assignTeamId, 10) : undefined;
    if (!driver_id) return;
    setActionLoading(true);
    api(`tasks/${taskId}/assign`, { method: 'PUT', body: JSON.stringify({ driver_id, team_id }) })
      .then(() => {
        setAssignOpen(false);
        setAssignTeamId('');
        setAssignDriverId('');
        // Refresh task details to reflect assignment
        return api(`tasks/${taskId}`);
      })
      .then((res) => {
        if (res && typeof res === 'object' && !res.error) setData(res);
      })
      .catch((err) => alert(err?.error || err?.message || 'Assign failed'))
      .finally(() => setActionLoading(false));
  };

  const handleDelete = () => {
    if (!window.confirm('Delete this task? This cannot be undone.')) return;
    setActionLoading(true);
    api(`tasks/${taskId}`, { method: 'DELETE' })
      .then(() => { onTaskDeleted?.(); handleClose(); })
      .catch((err) => alert(err?.error || err?.message || 'Delete failed'))
      .finally(() => setActionLoading(false));
  };

  const handleChangeStatus = (e) => {
    e.preventDefault();
    const status = (changeStatusValue || '').trim();
    if (!status) return;
    setActionLoading(true);
    api(`tasks/${taskId}/status`, { method: 'PUT', body: JSON.stringify({ status, reason: (changeStatusReason || '').trim() || undefined }) })
      .then(() => { setChangeStatusOpen(false); setChangeStatusValue(''); setChangeStatusReason(''); setData((prev) => prev && prev.task ? { ...prev, task: { ...prev.task, status } } : prev); })
      .catch((err) => alert(err?.error || err?.message || 'Update failed'))
      .finally(() => setActionLoading(false));
  };

  const handleAssignToAll = () => {
    if (!window.confirm('Send this task to all drivers? They will receive a push notification.')) return;
    setActionLoading(true);
    api(`tasks/${taskId}/assign-all`, { method: 'POST' })
      .then(() => {})
      .catch((err) => alert(err?.error || err?.message || 'Failed'))
      .finally(() => setActionLoading(false));
  };

  const handleRetryAutoAssign = () => {
    setActionLoading(true);
    api(`tasks/${taskId}/retry-auto-assign`, { method: 'POST' })
      .then(() => {})
      .catch((err) => alert(err?.error || err?.message || 'Failed'))
      .finally(() => setActionLoading(false));
  };

  const openEdit = () => {
    const t = data?.task ?? data;
    if (t) {
      setEditForm({
        task_description: displaySanitized(t.task_description) || (t.task_description ?? ''),
        delivery_address: displaySanitized(t.delivery_address) || (t.delivery_address ?? ''),
        customer_name: displaySanitized(t.customer_name) || (t.customer_name ?? ''),
        contact_number: t.contact_number ?? '',
        delivery_date: t.delivery_date ? (typeof t.delivery_date === 'string' && t.delivery_date.length >= 10 ? t.delivery_date.slice(0, 10) : t.delivery_date) : '',
        email_address: t.email_address ?? '',
      });
      setEditOpen(true);
    }
  };

  const handleSaveEdit = (e) => {
    e.preventDefault();
    setActionLoading(true);
    api(`tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(editForm) })
      .then(() => {
        setData((prev) => prev && prev.task ? { ...prev, task: { ...prev.task, ...editForm } } : prev);
        setEditOpen(false);
      })
      .catch((err) => alert(err?.error || err?.message || 'Update failed'))
      .finally(() => setActionLoading(false));
  };

  const directionsUrl = (() => {
    const t = data?.task ?? data;
    if (!t) return null;
    const pickup = (t.pickup_address || t.drop_address || t.merchant_address || '').trim();
    const dest = (t.delivery_address || '').trim();
    if (!dest) return null;
    const params = new URLSearchParams({ api: '1', destination: dest });
    if (pickup) params.set('origin', pickup);
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  })();

  const task = data && (data.task ?? data);
  const order = data?.order ?? null;
  const orderDetails = Array.isArray(data?.order_details) ? data.order_details : [];
  const merchant = data?.merchant ?? null;
  const legacyTimeline = Array.isArray(data?.order_status_timeline) ? data.order_status_timeline : [];
  const taskPhotos = Array.isArray(data?.task_photos) ? data.task_photos : [];
  const historyEntries = (orderHistory || [])
    .filter(Boolean)
    .map((row) => ({
      type: 'history',
      id: row.id,
      order_id: row.order_id,
      status: row.status,
      remarks: row.remarks || row.remarks2,
      date_created: row.date_created,
      reason: row.reason,
      update_by_name: row.update_by_name,
      update_by_type: row.update_by_type,
      driver_id: row.driver_id,
      notes: row.notes,
    }));
  const photoEntries = taskPhotos
    .filter(Boolean)
    .map((row) => ({
      type: 'photo',
      id: `photo-${row.id}`,
      photo_id: row.id,
      photo_name: row.photo_name,
      date_created: row.date_created,
      ip_address: row.ip_address,
    }));
  const combined = [...historyEntries, ...photoEntries].sort((a, b) => {
    const da = a.date_created ? new Date(a.date_created).getTime() : 0;
    const db = b.date_created ? new Date(b.date_created).getTime() : 0;
    return db - da;
  });
  const timeline = combined.length > 0 ? combined : legacyTimeline.map((e) => ({ ...e, type: 'legacy' }));
  const customerName = displaySanitizedOrDash(task?.customer_name);
  const merchantName = (() => {
    const fromMerchant = merchant && (merchant.restaurant_name || '').trim();
    if (fromMerchant) return displaySanitizedOrDash(fromMerchant);
    const fromTaskJoin = task && String(task.restaurant_name || '').trim();
    if (fromTaskJoin) return displaySanitizedOrDash(fromTaskJoin);
    const fromTask = task && String(task.dropoff_merchant || '').trim();
    if (fromTask && !/^\d+$/.test(fromTask)) return displaySanitizedOrDash(fromTask);
    return '—';
  })();
  const deliveryAddressDisplay = (() => {
    const d = task?.delivery_address;
    if (d != null && String(d).trim() !== '') return displaySanitizedOrDash(d);
    if (merchant) {
      const line = [merchant.street, merchant.city, merchant.state, merchant.post_code]
        .filter(Boolean)
        .map((p) => displaySanitized(p))
        .filter(Boolean)
        .join(', ');
      return line || '—';
    }
    return '—';
  })();
  const taskDescriptionDisplay = displaySanitized(task?.task_description) || '—';
  const deliveryInstructionDisplay = displaySanitizedOrDash(order?.delivery_instruction ?? task?.delivery_instruction);
  const teamNameDisplay = displaySanitizedOrDash(task?.team_name);
  const driverNameDisplay = displaySanitizedOrDash(task?.driver_name);
  const completeBefore = order?.delivery_date && order?.delivery_time
    ? `${formatDate(order.delivery_date)} ${String(order.delivery_time).slice(0, 5)}`
    : formatDate(task?.delivery_date);
  const advanceLinesModal = order ? getAdvanceOrderLines(order, task?.date_created) : null;

  return (
    <div className={`modal-backdrop task-details-backdrop ${editOpen ? 'task-details-backdrop-edit-open' : ''}`} onClick={() => !loading && !editOpen && handleClose()}>
      <div className="modal-box modal-box-lg task-details-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Task ID : {task?.task_id ?? taskId ?? '…'}</h3>
        </div>
        {loading && (
          <div className="modal-body"><div className="loading">Loading…</div></div>
        )}
        {!loading && error && (
          <div className="modal-body">
            <p className="muted">{error}</p>
            <div className="modal-footer-actions">
              <button type="button" className="btn" onClick={handleClose}>Close</button>
            </div>
          </div>
        )}
        {!loading && !error && data && task && (
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
                          <span className="task-detail-value">{deliveryAddressDisplay}</span>
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
                          <span className="task-detail-value">{customerName}</span>
                        </div>
                        <div className="task-detail-pickup-item">
                          <span className="task-detail-label">Contact number</span>
                          <span className="task-detail-value">{task.contact_number ?? '—'}</span>
                        </div>
                        <div className="task-detail-pickup-item task-detail-pickup-address">
                          <span className="task-detail-label">Address</span>
                          <span className="task-detail-value">{deliveryAddressDisplay}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {tab === 'timeline' && (
                  <div className="task-details-content">
                    <div className="task-detail-section">
                      <div className="activity-timeline">
                        {timeline.length ? timeline.filter(Boolean).map((entry, i) => (
                          <div key={entry.id ?? entry.stats_id ?? i} className={`activity-timeline-item ${entry.type === 'photo' ? 'activity-timeline-item-photo' : 'activity-timeline-item-history'}`}>
                            {entry.type === 'photo' ? (
                              <>
                                <span className="tag status-green">Proof of delivery</span>
                                <span className="activity-timeline-time">{formatDate(entry?.date_created)}</span>
                                {(entry.photo_name || entry.photo_id) && (
                                  <TaskPhotoImage photoId={entry.photo_id} photoName={entry.photo_name} />
                                )}
                              </>
                            ) : (
                              <>
                                <span className={`tag ${statusDisplayClass(entry?.status ?? entry?.description)}`}>{entry?.status ?? entry?.description ?? '—'}</span>
                                <span className="activity-timeline-time">{formatDate(entry?.date_created)}</span>
                                {(entry?.update_by_name || entry?.update_by_type) && (
                                  <span className="activity-timeline-by">by {entry.update_by_name || entry.update_by_type || '—'}</span>
                                )}
                                {(entry?.remarks || entry?.reason) && (
                                  <div className="activity-timeline-remarks">{displaySanitized(entry.remarks || entry.reason) || entry.remarks || entry.reason}</div>
                                )}
                                {entry?.notes && (
                                  <div className="activity-timeline-notes">{displaySanitized(entry.notes) || entry.notes}</div>
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
                  <div className="task-details-content order-details-panel">
                    <div className="task-detail-section">
                      <div className="task-detail-section-title">Customer & merchant</div>
                      <div className="task-detail-section-row">
                        <div className="task-detail-row"><span className="task-detail-label">Customer name</span><span className="task-detail-value">{customerName}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Merchant name</span><span className="task-detail-value">{merchantName}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Telephone</span><span className="task-detail-value">{task.contact_number ?? merchant?.restaurant_phone ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Address</span><span className="task-detail-value">{deliveryAddressDisplay}</span></div>
                      </div>
                    </div>
                    <div className="task-detail-section">
                      <div className="task-detail-section-title">Transaction</div>
                      <div className="task-detail-section-row">
                        <div className="task-detail-row"><span className="task-detail-label">TRN type</span><span className="task-detail-value">{order?.trans_type ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Payment type</span><span className="task-detail-value">{order?.payment_type ?? task.payment_type ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Reference #</span><span className="task-detail-value">{order?.order_id ?? task.order_id ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">TRN date</span><span className="task-detail-value">{order?.date_created ? formatDate(order.date_created) : '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Delivery date</span><span className="task-detail-value">{order?.delivery_date ? formatDate(order.delivery_date) : '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Delivery instruction</span><span className="task-detail-value">{deliveryInstructionDisplay}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Contact number</span><span className="task-detail-value">{task.contact_number ?? '—'}</span></div>
                        <div className="task-detail-row"><span className="task-detail-label">Change</span><span className="task-detail-value">{order?.order_change != null ? `₱${Number(order.order_change).toFixed(2)}` : '—'}</span></div>
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
                        <div className="task-detail-section order-items-block order-items-block--modal order-items-block--legacy-layout">
                          <div className="order-items-card-shell">
                            <div className="order-items-section-label" id={`order-items-label-${taskId}`}>Ordered items</div>
                            <div className="order-items-by-category" aria-labelledby={`order-items-label-${taskId}`}>
                            {categoryBuckets.map(({ key, label, items }) => (
                              <div key={key} className="order-items-category order-items-category--legacy">
                                <div
                                  className="order-items-category-header order-items-category-header--legacy"
                                  role="group"
                                  aria-label={formatOrderItemsCategoryHeader(label)}
                                >
                                  {formatOrderItemsCategoryHeader(label)}
                                </div>
                                <ul className="order-items-list order-items-list--legacy">
                                  {items.map((item) => {
                                    const qty = Number(item.qty) || 0;
                                    const unitPrice = item.discounted_price != null ? Number(item.discounted_price) : item.normal_price != null ? Number(item.normal_price) : null;
                                    const subtotal = unitPrice != null && !Number.isNaN(unitPrice) ? qty * unitPrice : null;
                                    const unitStr = unitPrice != null && !Number.isNaN(unitPrice) ? `₱${unitPrice.toFixed(2)}` : '—';
                                    const subtotalStr = subtotal != null ? `₱${subtotal.toFixed(2)}` : '—';
                                    const lineName = displayOrderItemName(item);
                                    const sizePart = displayOrderItemSize(item.size);
                                    const withSize = sizePart ? `${lineName} (${sizePart})` : lineName;
                                    const nameWithQty = `${qty}x ${withSize}`;
                                    return (
                                      <li key={item.id ?? item._idx} className="order-item-row order-item-row--legacy">
                                        <div className="order-item-line order-item-line--legacy">
                                          <div className="order-item-line-text">
                                            <span className="order-item-name order-item-name--legacy">{nameWithQty}</span>
                                            {unitStr !== '—' ? (
                                              <span className="order-item-unit-price order-item-unit-price--legacy" aria-label="Unit price">{unitStr}</span>
                                            ) : null}
                                          </div>
                                          <span className="order-item-line-total order-item-line-total--legacy">{subtotalStr}</span>
                                        </div>
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
                        </div>
                      );
                    })()}
                    {(order?.sub_total != null || order?.total_w_tax != null) && (
                      <div className="task-detail-section order-summary-block">
                        <div className="task-detail-section-title">Order summary</div>
                        <div className="task-detail-section-row">
                          <div className="task-detail-row"><span className="task-detail-label">Sub total</span><span className="task-detail-value">{order.sub_total != null ? `₱${Number(order.sub_total).toFixed(2)}` : '—'}</span></div>
                          <div className="task-detail-row">
                            <span className="task-detail-label">Convenience</span>
                            <span className="task-detail-value">
                              {(() => {
                                const raw = order.packaging != null && String(order.packaging).trim() !== ''
                                  ? order.packaging
                                  : order.convenience_fee;
                                const n = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
                                return !Number.isNaN(n) ? `₱${n.toFixed(2)}` : '—';
                              })()}
                            </span>
                          </div>
                          {(() => {
                            const tipRow = formatOrderTipRow(order);
                            return (
                              <div className="task-detail-row">
                                <span className="task-detail-label">{tipRow.label}</span>
                                <span className="task-detail-value">{tipRow.display}</span>
                              </div>
                            );
                          })()}
                          <div className="task-detail-row"><span className="task-detail-label">Total</span><span className="task-detail-value task-detail-value-total">{order?.total_w_tax != null ? `₱${Number(order.total_w_tax).toFixed(2)}` : '—'}</span></div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {changeStatusOpen && (
                  <div className="task-detail-change-status-wrap task-detail-inner-form" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: '1rem', marginTop: '1rem' }}>
                    <form onSubmit={handleChangeStatus} className="task-detail-change-status-form">
                      <label className="modal-label" htmlFor="task-change-status-select">Change status</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-start' }}>
                        <select
                          id="task-change-status-select"
                          className="form-control"
                          value={changeStatusValue}
                          onChange={(e) => setChangeStatusValue(e.target.value)}
                          required
                          style={{ minWidth: '140px' }}
                        >
                          <option value="">Select status</option>
                          {TASK_STATUS_OPTIONS.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          className="form-control"
                          placeholder="Reason (optional)"
                          value={changeStatusReason}
                          onChange={(e) => setChangeStatusReason(e.target.value)}
                          style={{ minWidth: '160px', flex: 1 }}
                        />
                        <button type="submit" className="btn btn-primary" disabled={actionLoading}>Update</button>
                        <button type="button" className="btn" onClick={() => { setChangeStatusOpen(false); setChangeStatusValue(''); setChangeStatusReason(''); }} disabled={actionLoading}>Cancel</button>
                      </div>
                    </form>
                  </div>
                )}
                {assignOpen && (
                  <div className="task-detail-assign-wrap task-detail-inner-form" style={{ borderTop: '1px solid var(--border-soft)', paddingTop: '1rem', marginTop: '1rem' }}>
                    <form onSubmit={doAssign} className="task-detail-assign-form">
                      <label className="modal-label" htmlFor="task-assign-team">Assign to team</label>
                      <select
                        id="task-assign-team"
                        className="form-control"
                        value={assignTeamId}
                        onChange={(e) => setAssignTeamId(e.target.value)}
                        disabled={actionLoading}
                      >
                        <option value="">All teams</option>
                        {(teams || []).map((t) => (
                          <option key={t.team_id ?? t.id} value={String(t.team_id ?? t.id)}>
                            {t.team_name ?? t.name ?? `Team ${t.team_id ?? t.id}`}
                          </option>
                        ))}
                      </select>

                      <label className="modal-label" htmlFor="task-assign-driver" style={{ marginTop: '0.75rem' }}>Assign to driver</label>
                      <select
                        id="task-assign-driver"
                        className="form-control"
                        value={assignDriverId}
                        onChange={(e) => setAssignDriverId(e.target.value)}
                        disabled={actionLoading}
                        required
                      >
                        <option value="">Select driver…</option>
                        {(drivers || [])
                          .filter((d) => !assignTeamId || String(d.team_id ?? d.team) === String(assignTeamId))
                          .map((d) => (
                            <option key={d.driver_id ?? d.id} value={String(d.driver_id ?? d.id)}>
                              {d.full_name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.username || d.email || `Driver ${d.driver_id ?? d.id}`}
                            </option>
                          ))}
                      </select>

                      <div className="modal-actions" style={{ marginTop: '0.75rem' }}>
                        <button type="submit" className="btn btn-primary" disabled={actionLoading || !assignDriverId}>
                          {actionLoading ? 'Assigning…' : 'Assign'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => { setAssignOpen(false); setAssignTeamId(''); setAssignDriverId(''); }}
                          disabled={actionLoading}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
              <div className="modal-footer-actions task-details-footer-actions">
                {(String(task.status || '').toLowerCase() === 'unassigned') && (
                  <>
                    <button type="button" className="btn btn-primary" onClick={handleAssignDriver} disabled={actionLoading}>Assign driver</button>
                    <button type="button" className="btn" onClick={handleAssignToAll} disabled={actionLoading}>Assign to all drivers</button>
                    <button type="button" className="btn" onClick={handleRetryAutoAssign} disabled={actionLoading}>Retry auto-assign</button>
                  </>
                )}
                {!changeStatusOpen && !editOpen && !assignOpen && (
                  <button type="button" className="btn" onClick={openEdit} disabled={actionLoading}>Edit</button>
                )}
                {!changeStatusOpen && !editOpen && !assignOpen && (
                  <button type="button" className="btn" onClick={() => setChangeStatusOpen(true)} disabled={actionLoading}>Change status</button>
                )}
                {onShowDirections && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onShowDirections?.({ task, order, merchant })}
                    disabled={actionLoading}
                  >
                    Get directions
                  </button>
                )}
                {directionsUrl && (
                  <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className="btn">Open in Google Maps</a>
                )}
                <button type="button" className="btn" onClick={handleDelete} disabled={actionLoading}>Delete task</button>
                <button type="button" className="btn" onClick={handleClose}>Close</button>
              </div>
            </>
        )}
      </div>
      {editOpen && (
        <div className="modal-box modal-box-lg task-detail-edit-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Edit task</h3>
            <button type="button" className="task-detail-edit-modal-close" onClick={() => setEditOpen(false)} aria-label="Close">×</button>
          </div>
          <div className="modal-body">
            <form onSubmit={handleSaveEdit} className="task-detail-edit-form">
              <div className="task-detail-edit-fields">
                <label className="modal-label" htmlFor="edit-task-description">Task description</label>
                <textarea id="edit-task-description" className="form-control" rows={2} value={editForm.task_description} onChange={(e) => setEditForm((f) => ({ ...f, task_description: e.target.value }))} />
                <label className="modal-label" htmlFor="edit-delivery-address">Delivery address</label>
                <input id="edit-delivery-address" type="text" className="form-control" value={editForm.delivery_address} onChange={(e) => setEditForm((f) => ({ ...f, delivery_address: e.target.value }))} />
                <label className="modal-label" htmlFor="edit-customer-name">Customer name</label>
                <input id="edit-customer-name" type="text" className="form-control" value={editForm.customer_name} onChange={(e) => setEditForm((f) => ({ ...f, customer_name: e.target.value }))} />
                <label className="modal-label" htmlFor="edit-contact-number">Contact number</label>
                <input id="edit-contact-number" type="text" className="form-control" value={editForm.contact_number} onChange={(e) => setEditForm((f) => ({ ...f, contact_number: e.target.value }))} />
                <label className="modal-label" htmlFor="edit-email">Email</label>
                <input id="edit-email" type="email" className="form-control" value={editForm.email_address} onChange={(e) => setEditForm((f) => ({ ...f, email_address: e.target.value }))} />
                <label className="modal-label" htmlFor="edit-delivery-date">Delivery date</label>
                <input id="edit-delivery-date" type="date" className="form-control" value={editForm.delivery_date} onChange={(e) => setEditForm((f) => ({ ...f, delivery_date: e.target.value }))} />
              </div>
              <div className="modal-footer-actions">
                <button type="submit" className="btn btn-primary" disabled={actionLoading}>Save</button>
                <button type="button" className="btn" onClick={() => setEditOpen(false)} disabled={actionLoading}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
