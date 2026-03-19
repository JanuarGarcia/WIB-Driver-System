import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';
import DriverDetailsModal from '../components/DriverDetailsModal';

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'pending', label: 'Pending' },
  { id: 'active', label: 'Active' },
  { id: 'expired', label: 'Expired' },
  { id: 'blocked', label: 'Blocked' },
];

const DRIVER_SORT_OPTIONS = [
  { key: 'id', label: 'ID', compare: (a, b) => (a.id ?? a.driver_id ?? 0) - (b.id ?? b.driver_id ?? 0) },
  { key: 'username', label: 'Username', compare: (a, b) => String(a.username ?? '').localeCompare(b.username ?? '') },
  { key: 'name', label: 'Name', compare: (a, b) => String(a.full_name ?? '').localeCompare(b.full_name ?? '') },
  { key: 'email', label: 'Email', compare: (a, b) => String(a.email ?? '').localeCompare(b.email ?? '') },
  { key: 'phone', label: 'Phone', compare: (a, b) => String(a.phone ?? '').localeCompare(b.phone ?? '') },
  { key: 'team', label: 'Team', compare: (a, b) => String(a.team_name ?? '').localeCompare(b.team_name ?? '') },
  { key: 'vehicle', label: 'Vehicle', compare: (a, b) => String(a.vehicle ?? '').localeCompare(b.vehicle ?? '') },
  { key: 'device', label: 'Device', compare: (a, b) => String(a.device ?? '').localeCompare(b.device ?? '') },
  { key: 'status', label: 'Status', compare: (a, b) => String(a.status ?? '').localeCompare(b.status ?? '') },
];
const DRIVER_STATUS_UPDATED_EVENT = 'wib:driver-status-updated';
const DRIVER_STATUS_UPDATED_AT_KEY = 'wib-driver-status-updated-at';

function driverStatusClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'status-green';
  if (s === 'pending') return 'status-amber';
  if (s === 'suspended') return 'status-suspended';
  if (s === 'blocked') return 'status-red';
  if (s === 'expired') return 'status-default';
  return 'status-default';
}

function formatStatusDate(isoOrDate) {
  if (!isoOrDate) return null;
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function formatStatusTime(isoOrDate) {
  if (!isoOrDate) return null;
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Drivers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const statusFilter = searchParams.get('status') || 'all';
  const [searchQuery, setSearchQuery] = useState('');
  const sortKey = searchParams.get('sort') || 'name';
  const sortOrder = searchParams.get('order') || 'asc';
  const urlPage = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const urlSize = PAGE_SIZE_OPTIONS.includes(parseInt(searchParams.get('size'), 10)) ? parseInt(searchParams.get('size'), 10) : 10;
  const [pushDriver, setPushDriver] = useState(null);
  const [pushTitle, setPushTitle] = useState('');
  const [pushMessage, setPushMessage] = useState('');
  const [pushSending, setPushSending] = useState(false);
  const [teams, setTeams] = useState([]);
  const [driverModal, setDriverModal] = useState(null);
  const [driverForm, setDriverForm] = useState({ username: '', password: '', first_name: '', last_name: '', email: '', phone: '', team_id: '', vehicle: '', status: 'active' });
  const [driverSaving, setDriverSaving] = useState(false);
  const [editDriverLoading, setEditDriverLoading] = useState(false);
  const [selectedDriverIds, setSelectedDriverIds] = useState(new Set());
  const [bulkPushOpen, setBulkPushOpen] = useState(false);
  const [bulkPushMode, setBulkPushMode] = useState('selected'); // 'all' | 'selected'
  const [bulkPushTitle, setBulkPushTitle] = useState('');
  const [bulkPushMessage, setBulkPushMessage] = useState('');
  const [bulkPushSending, setBulkPushSending] = useState(false);
  /** Row object for read-only details modal (same as Agent panel Details) */
  const [viewDriver, setViewDriver] = useState(null);

  const setStatusFilter = (id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('status', id);
      next.set('page', '1');
      return next;
    });
  };
  const setSort = ({ sortKey: k, sortOrder: o }) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('sort', k);
      next.set('order', o || 'asc');
      next.set('page', '1');
      return next;
    });
  };
  const setPageAndUrl = (p) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('page', String(Math.max(1, p)));
      return next;
    });
  };
  const setPageSizeAndUrl = (s) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('size', String(s));
      next.set('page', '1');
      return next;
    });
  };

  const fetchDrivers = () => {
    setLoading(true);
    api('drivers').then(setDrivers).catch(() => setDrivers([])).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchDrivers();
  }, []);

  useEffect(() => {
    api('teams').then((t) => setTeams(Array.isArray(t) ? t : [])).catch(() => setTeams([]));
  }, []);

  useTableAutoRefresh(fetchDrivers);

  const openCreateDriver = () => {
    setDriverModal({});
    setDriverForm({ username: '', password: '', first_name: '', last_name: '', email: '', phone: '', team_id: '', vehicle: '', status: 'active' });
  };

  const openEditDriver = (d) => {
    const id = d.id ?? d.driver_id;
    if (id == null) {
      alert('Cannot edit: driver ID is missing.');
      return;
    }
    setDriverModal({ id });
    setDriverForm({ username: '', password: '', first_name: '', last_name: '', email: '', phone: '', team_id: '', vehicle: '', status: 'active' });
    setEditDriverLoading(true);
    api(`drivers/${id}`)
      .then((driver) => {
        setDriverModal(driver);
        setDriverForm({
          username: driver.username ?? '',
          password: '',
          first_name: driver.first_name ?? '',
          last_name: driver.last_name ?? '',
          email: driver.email ?? '',
          phone: driver.phone ?? '',
          team_id: driver.team_id != null ? String(driver.team_id) : '',
          vehicle: driver.vehicle ?? '',
          status: driver.status ?? 'active',
        });
      })
      .catch((err) => {
        const msg = err?.error || err?.message || 'Failed to load driver';
        alert(msg === 'Driver not found'
          ? 'Driver not found. It may have been deleted, or the list is out of date. Try refreshing the list.'
          : msg);
        setDriverModal(null);
      })
      .finally(() => setEditDriverLoading(false));
  };

  const closeDriverModal = () => setDriverModal(null);

  const saveDriver = (e) => {
    e.preventDefault();
    const id = driverModal?.id;
    const payload = {
      username: (driverForm.username || '').trim(),
      first_name: (driverForm.first_name || '').trim(),
      last_name: (driverForm.last_name || '').trim(),
      email: (driverForm.email || '').trim(),
      phone: (driverForm.phone || '').trim(),
      team_id: driverForm.team_id || undefined,
      vehicle: (driverForm.vehicle || '').trim(),
      status: (driverForm.status || 'active').trim(),
    };
    if (!id && !payload.username) { alert('Username required'); return; }
    if (!id && !(driverForm.password || '').trim()) { alert('Password required for new driver'); return; }
    if ((driverForm.password || '').trim()) payload.password = driverForm.password.trim();
    setDriverSaving(true);
    (id ? api(`drivers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }) : api('drivers', { method: 'POST', body: JSON.stringify(payload) }))
      .then(() => { closeDriverModal(); fetchDrivers(); })
      .catch((err) => alert(err?.error || err?.message || 'Save failed'))
      .finally(() => setDriverSaving(false));
  };

  const deleteDriver = (d) => {
    if (!window.confirm(`Delete driver "${d.full_name || d.username || '#' + d.id}"? This cannot be undone.`)) return;
    setDriverSaving(true);
    api(`drivers/${d.id}`, { method: 'DELETE' })
      .then(() => fetchDrivers())
      .catch((err) => alert(err?.error || err?.message || 'Delete failed'))
      .finally(() => setDriverSaving(false));
  };

  const setDriverOnDuty = (d, onDuty) => {
    const id = d.id ?? d.driver_id;
    api(`drivers/${id}/status`, { method: 'PUT', body: JSON.stringify({ on_duty: onDuty ? 1 : 2 }) })
      .then(() => {
        fetchDrivers();
        window.dispatchEvent(new CustomEvent(DRIVER_STATUS_UPDATED_EVENT));
        try {
          localStorage.setItem(DRIVER_STATUS_UPDATED_AT_KEY, String(Date.now()));
        } catch (_) {}
      })
      .catch((err) => alert(err?.error || err?.message || 'Update failed'));
  };

  const setDriverStatus = (d, newStatus) => {
    const id = d.id ?? d.driver_id;
    api(`drivers/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) })
      .then(() => {
        fetchDrivers();
        window.dispatchEvent(new CustomEvent(DRIVER_STATUS_UPDATED_EVENT));
        try {
          localStorage.setItem(DRIVER_STATUS_UPDATED_AT_KEY, String(Date.now()));
        } catch (_) {}
        setSelectedDriverIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      })
      .catch((err) => alert(err?.error || err?.message || 'Update failed'));
  };

  const toggleDriverSelection = (id) => {
    setSelectedDriverIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllOnPage = () => {
    const ids = paginatedDrivers.map((d) => d.id ?? d.driver_id).filter(Boolean);
    if (ids.every((id) => selectedDriverIds.has(id))) {
      setSelectedDriverIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
    } else {
      setSelectedDriverIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.add(id)); return next; });
    }
  };
  const openBulkPush = () => {
    setBulkPushTitle('Notification');
    setBulkPushMessage('');
    setBulkPushOpen(true);
  };
  const sendBulkPush = async () => {
    const targets = bulkPushMode === 'all' ? filteredDrivers : filteredDrivers.filter((d) => selectedDriverIds.has(d.id ?? d.driver_id));
    const ids = targets.map((d) => d.id ?? d.driver_id).filter(Boolean);
    if (ids.length === 0) {
      alert(bulkPushMode === 'all' ? 'No drivers to send to.' : 'Select at least one driver.');
      return;
    }
    setBulkPushSending(true);
    const title = bulkPushTitle.trim() || 'Notification';
    const message = bulkPushMessage.trim() || 'You have a new notification.';
    let failed = 0;
    for (const id of ids) {
      try {
        await api(`drivers/${id}/send-push`, { method: 'POST', body: JSON.stringify({ title, message }) });
      } catch (_) {
        failed += 1;
      }
    }
    setBulkPushSending(false);
    setBulkPushOpen(false);
    setSelectedDriverIds(new Set());
    fetchDrivers();
    if (failed > 0) alert(`Push sent to ${ids.length - failed} driver(s). ${failed} failed.`);
  };

  const exportAgentsCsv = () => {
    const list = filteredDrivers;
    const headers = ['ID', 'Username', 'Name', 'Email', 'Phone', 'Team', 'Vehicle', 'Device', 'Status'];
    const escape = (v) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [headers.join(',')].concat(
      list.map((d) =>
        [d.id ?? d.driver_id, d.username, d.full_name, d.email, d.phone, d.team_name, d.vehicle, d.device, d.status].map(escape).join(',')
      )
    );
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `agents-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const filteredByStatus = (drivers || []).filter((d) => {
    const s = (d.status || 'active').toLowerCase();
    if (statusFilter === 'all') return true;
    return s === statusFilter;
  });

  const q = (searchQuery || '').trim().toLowerCase();
  const filteredDrivers = q
    ? filteredByStatus.filter((d) => {
        const id = String(d.id ?? '');
        const username = (d.username ?? '').toLowerCase();
        const name = (d.full_name ?? '').toLowerCase();
        const email = (d.email ?? '').toLowerCase();
        const phone = (d.phone ?? '').toLowerCase();
        const teamName = (d.team_name ?? '').toLowerCase();
        const vehicle = (d.vehicle ?? '').toLowerCase();
        const device = (d.device ?? '').toLowerCase();
        const status = (d.status ?? '').toLowerCase();
        return [id, username, name, email, phone, teamName, vehicle, device, status].some((v) => v.includes(q));
      })
    : filteredByStatus;

  const sortedDrivers = useTableSort(filteredDrivers, sortKey, sortOrder, DRIVER_SORT_OPTIONS);

  const {
    paginatedItems: paginatedDrivers,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalItems,
    startRow,
    endRow,
  } = useTablePagination(sortedDrivers, 10, {
    page: urlPage,
    pageSize: urlSize,
    onPageChange: setPageAndUrl,
    onPageSizeChange: setPageSizeAndUrl,
  });

  const openSendPush = (d) => {
    setPushDriver(d);
    setPushTitle('Notification');
    setPushMessage('');
  };

  const openViewDriver = (d) => {
    const id = d.id ?? d.driver_id;
    if (id == null) {
      alert('Cannot view: driver ID is missing.');
      return;
    }
    setViewDriver({ ...d, id });
  };

  const sendPush = async () => {
    if (!pushDriver) return;
    setPushSending(true);
    try {
      await api(`drivers/${pushDriver.id}/send-push`, {
        method: 'POST',
        body: JSON.stringify({ title: pushTitle.trim() || 'Notification', message: pushMessage.trim() || 'You have a new notification.' }),
      });
      setPushDriver(null);
    } catch (err) {
      alert(err.error || 'Failed to send push');
    } finally {
      setPushSending(false);
    }
  };

  return (
    <div className="listing-section drivers-listing">
      <div className="listing-tasks-header">
        <div className="listing-toolbar">
          <button type="button" className="btn btn-primary" onClick={openCreateDriver}>
            Add driver
          </button>
          <button type="button" className="btn btn-sm" onClick={() => fetchDrivers()} disabled={loading} title="Refresh list">
            Refresh
          </button>
          <button type="button" className="btn btn-sm" onClick={exportAgentsCsv} disabled={loading || filteredDrivers.length === 0} title="Export filtered list as CSV">
            Export agents
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={openBulkPush} disabled={loading} title="Send push to all or selected drivers">
            Send bulk push
          </button>
          <div className="listing-toolbar-right">
            <div className="filter-pills">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`filter-pill ${statusFilter === f.id ? 'active' : ''}`}
                  onClick={() => setStatusFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <input
              type="search"
              className="listing-search-input"
              placeholder="Search drivers…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search drivers"
            />
          </div>
        </div>
      </div>
      {loading && <div className="loading">Loading…</div>}
      {!loading && (
        <div className="listing-table-card">
          <TableSortControls
            sortOptions={DRIVER_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onSortChange={setSort}
          />
          <div className="listing-table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="drivers-col-select">
                    <input
                      type="checkbox"
                      className="drivers-checkbox"
                      aria-label="Select all on page"
                      checked={paginatedDrivers.length > 0 && paginatedDrivers.every((d) => selectedDriverIds.has(d.id ?? d.driver_id))}
                      onChange={selectAllOnPage}
                    />
                  </th>
                  <th>ID</th>
                  <th>Username</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Team</th>
                  <th>Vehicle</th>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedDrivers.map((d) => {
                  const rowId = d.id ?? d.driver_id;
                  const isPending = String(d.status || '').toLowerCase() === 'pending';
                  return (
                <tr key={rowId}>
                  <td className="drivers-col-select">
                    <input
                      type="checkbox"
                      className="drivers-checkbox"
                      aria-label={`Select ${d.full_name || d.username || rowId}`}
                      checked={selectedDriverIds.has(rowId)}
                      onChange={() => toggleDriverSelection(rowId)}
                    />
                  </td>
                  <td>{rowId ?? '—'}</td>
                  <td>{d.username ?? '—'}</td>
                  <td className="driver-name-cell">{d.full_name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.username || '—'}</td>
                  <td>{d.email ?? '—'}</td>
                  <td>{d.phone ?? '—'}</td>
                  <td>{d.team_name ?? '—'}</td>
                  <td>{d.vehicle ?? '—'}</td>
                  <td>{d.device ?? '—'}</td>
                  <td>
                    <div className="driver-status-cell">
                      <span className="driver-status-date">{formatStatusDate(d.status_updated_at) ?? '—'}</span>
                      <span className="driver-status-time">{formatStatusTime(d.status_updated_at) ?? '—'}</span>
                      <span className={`tag ${driverStatusClass(d.status)}`}>
                        {(d.status || 'active').toLowerCase()}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="table-actions">
                      {isPending && (
                        <>
                          <button type="button" className="btn btn-sm btn-success" onClick={() => setDriverStatus(d, 'active')} title="Approve signup">Approve</button>
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => setDriverStatus(d, 'blocked')} title="Deny signup">Deny</button>
                        </>
                      )}
                      <button type="button" className="btn btn-sm btn-outline-view" onClick={() => openViewDriver(d)} title="View profile and tasks">
                        View
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setDriverOnDuty(d, !d.on_duty)} title={d.on_duty ? 'Set off duty' : 'Set on duty'}>
                        {d.on_duty ? 'On duty' : 'Off'}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => openEditDriver(d)}>Edit</button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => openSendPush(d)} title="Send push">Send push</button>
                      <button type="button" className="btn btn-sm" onClick={() => deleteDriver(d)} disabled={driverSaving}>Delete</button>
                    </div>
                  </td>
                </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredDrivers.length === 0 && (
              <p className="listing-empty-msg">No drivers match the current filters.</p>
            )}
          </div>
          <TablePaginationControls
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            startRow={startRow}
            endRow={endRow}
          />
        </div>
      )}

      {driverModal !== null && (
        <div className="modal-backdrop driver-form-backdrop" onClick={() => !driverSaving && closeDriverModal()}>
          <div className="modal-box driver-form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="driver-form-modal-header">
              <div>
                <h3 className="driver-form-modal-title">{driverModal.id ? 'Edit driver' : 'Add driver'}</h3>
                <p className="driver-form-modal-hint">
                  {driverModal.id ? 'Update account details and assignment. Leave password blank to keep the current one.' : 'Create a new rider account for the app.'}
                </p>
              </div>
              <button type="button" className="send-push-modal-close" onClick={() => !driverSaving && closeDriverModal()} aria-label="Close">×</button>
            </div>
            <form onSubmit={saveDriver}>
              <div className="driver-form-modal-body">
                {editDriverLoading ? (
                  <div className="loading">Loading…</div>
                ) : (
                  <>
                    <div className="driver-form-section">
                      <span className="driver-form-section-label">Account</span>
                      <div className="driver-form-grid">
                        <div className="send-push-field driver-form-field-full">
                          <label className="modal-label" htmlFor="driver-username">Username *</label>
                          <input id="driver-username" type="text" className="form-control send-push-input" value={driverForm.username} onChange={(e) => setDriverForm((f) => ({ ...f, username: e.target.value }))} required autoComplete="username" />
                        </div>
                        <div className="send-push-field driver-form-field-full">
                          <label className="modal-label" htmlFor="driver-password">Password {driverModal.id ? <span className="driver-form-label-muted">(leave blank to keep)</span> : <span className="driver-form-label-muted">*</span>}</label>
                          <input id="driver-password" type="password" className="form-control send-push-input" value={driverForm.password} onChange={(e) => setDriverForm((f) => ({ ...f, password: e.target.value }))} placeholder={driverModal.id ? '••••••••' : ''} autoComplete={driverModal.id ? 'new-password' : 'new-password'} />
                        </div>
                      </div>
                    </div>
                    <div className="driver-form-section">
                      <span className="driver-form-section-label">Profile</span>
                      <div className="driver-form-grid driver-form-grid-2">
                        <div className="send-push-field">
                          <label className="modal-label" htmlFor="driver-first">First name</label>
                          <input id="driver-first" type="text" className="form-control send-push-input" value={driverForm.first_name} onChange={(e) => setDriverForm((f) => ({ ...f, first_name: e.target.value }))} autoComplete="given-name" />
                        </div>
                        <div className="send-push-field">
                          <label className="modal-label" htmlFor="driver-last">Last name</label>
                          <input id="driver-last" type="text" className="form-control send-push-input" value={driverForm.last_name} onChange={(e) => setDriverForm((f) => ({ ...f, last_name: e.target.value }))} autoComplete="family-name" />
                        </div>
                        <div className="send-push-field">
                          <label className="modal-label" htmlFor="driver-email">Email</label>
                          <input id="driver-email" type="email" className="form-control send-push-input" value={driverForm.email} onChange={(e) => setDriverForm((f) => ({ ...f, email: e.target.value }))} autoComplete="email" />
                        </div>
                        <div className="send-push-field">
                          <label className="modal-label" htmlFor="driver-phone">Phone</label>
                          <input id="driver-phone" type="tel" className="form-control send-push-input" value={driverForm.phone} onChange={(e) => setDriverForm((f) => ({ ...f, phone: e.target.value }))} autoComplete="tel" />
                        </div>
                      </div>
                    </div>
                    <div className="driver-form-section">
                      <span className="driver-form-section-label">Assignment &amp; status</span>
                      <div className="driver-form-grid driver-form-grid-2">
                        <div className="send-push-field driver-form-field-span-2">
                          <label className="modal-label" htmlFor="driver-team">Team</label>
                          <select id="driver-team" className="form-control send-push-input" value={driverForm.team_id} onChange={(e) => setDriverForm((f) => ({ ...f, team_id: e.target.value }))}>
                            <option value="">— Select team —</option>
                            {(teams || []).map((t) => (
                              <option key={t.id ?? t.team_id} value={String(t.id ?? t.team_id ?? '')}>{t.name ?? t.team_name ?? `Team ${t.id ?? t.team_id}`}</option>
                            ))}
                          </select>
                        </div>
                        <div className="send-push-field">
                          <label className="modal-label" htmlFor="driver-vehicle">Vehicle</label>
                          <input id="driver-vehicle" type="text" className="form-control send-push-input" value={driverForm.vehicle} onChange={(e) => setDriverForm((f) => ({ ...f, vehicle: e.target.value }))} />
                        </div>
                        <div className="send-push-field">
                          <label className="modal-label" htmlFor="driver-status">Status</label>
                          <select id="driver-status" className="form-control send-push-input" value={driverForm.status} onChange={(e) => setDriverForm((f) => ({ ...f, status: e.target.value }))}>
                            <option value="active">active</option>
                            <option value="pending">pending</option>
                            <option value="suspended">suspended</option>
                            <option value="blocked">blocked</option>
                            <option value="expired">expired</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div className="driver-form-modal-footer">
                <button type="button" className="btn send-push-cancel" onClick={() => !driverSaving && !editDriverLoading && closeDriverModal()} disabled={driverSaving || editDriverLoading}>Cancel</button>
                <button type="submit" className="btn btn-primary send-push-submit" disabled={driverSaving || editDriverLoading}>
                  {driverSaving ? 'Saving…' : driverModal?.id ? 'Save changes' : 'Create driver'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {viewDriver && (
        <DriverDetailsModal
          size="wide"
          driverId={viewDriver.id ?? viewDriver.driver_id}
          summaryDriver={viewDriver}
          onClose={() => setViewDriver(null)}
          footer={
            <>
              <button
                type="button"
                className="agent-detail-modal-btn agent-detail-modal-btn--primary"
                onClick={() => {
                  const d = viewDriver;
                  setViewDriver(null);
                  openEditDriver(d);
                }}
              >
                Edit driver
              </button>
              <button
                type="button"
                className="agent-detail-modal-btn"
                onClick={() => {
                  const d = viewDriver;
                  setViewDriver(null);
                  openSendPush(d);
                }}
              >
                Send push
              </button>
              <button type="button" className="agent-detail-modal-btn" onClick={() => setViewDriver(null)}>
                Close
              </button>
            </>
          }
        />
      )}

      {pushDriver && (
        <div className="modal-backdrop" onClick={() => !pushSending && setPushDriver(null)}>
          <div className="modal-box send-push-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header send-push-modal-header">
              <h3>Send push to {pushDriver.full_name || pushDriver.username || `Driver #${pushDriver.id}`}</h3>
              <button type="button" className="send-push-modal-close" onClick={() => !pushSending && setPushDriver(null)} aria-label="Close">×</button>
            </div>
            <div className="modal-body send-push-modal-body">
              <div className="send-push-field">
                <label className="modal-label" htmlFor="send-push-title">Title</label>
                <input
                  type="text"
                  id="send-push-title"
                  className="form-control send-push-input"
                  value={pushTitle}
                  onChange={(e) => setPushTitle(e.target.value)}
                  placeholder="Notification title"
                />
              </div>
              <div className="send-push-field">
                <label className="modal-label" htmlFor="send-push-message">Message</label>
                <textarea
                  id="send-push-message"
                  className="form-control send-push-textarea"
                  rows={4}
                  value={pushMessage}
                  onChange={(e) => setPushMessage(e.target.value)}
                  placeholder="Message body"
                />
                <span className="send-push-char-count" aria-live="polite">
                  {pushMessage.length} characters
                </span>
              </div>
              <div className="modal-actions send-push-modal-actions">
                <button type="button" className="btn btn-primary send-push-submit" onClick={sendPush} disabled={pushSending}>
                  {pushSending ? 'Sending…' : 'Send push'}
                </button>
                <button type="button" className="btn send-push-cancel" onClick={() => !pushSending && setPushDriver(null)} disabled={pushSending}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {bulkPushOpen && (
        <div className="modal-backdrop" onClick={() => !bulkPushSending && setBulkPushOpen(false)}>
          <div className="modal-box send-push-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header send-push-modal-header">
              <h3>Send bulk push</h3>
              <button type="button" className="send-push-modal-close" onClick={() => !bulkPushSending && setBulkPushOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="modal-body send-push-modal-body">
              <div className="send-push-field">
                <span className="modal-label">Send to</span>
                <div className="drivers-bulk-push-options">
                  <label className="drivers-bulk-push-option">
                    <input type="radio" name="bulkPushMode" checked={bulkPushMode === 'all'} onChange={() => setBulkPushMode('all')} />
                    <span>All drivers ({filteredDrivers.length})</span>
                  </label>
                  <label className="drivers-bulk-push-option">
                    <input type="radio" name="bulkPushMode" checked={bulkPushMode === 'selected'} onChange={() => setBulkPushMode('selected')} />
                    <span>Selected drivers ({selectedDriverIds.size})</span>
                  </label>
                </div>
              </div>
              <div className="send-push-field">
                <label className="modal-label" htmlFor="bulk-push-title">Title</label>
                <input
                  type="text"
                  id="bulk-push-title"
                  className="form-control send-push-input"
                  value={bulkPushTitle}
                  onChange={(e) => setBulkPushTitle(e.target.value)}
                  placeholder="Notification title"
                />
              </div>
              <div className="send-push-field">
                <label className="modal-label" htmlFor="bulk-push-message">Message</label>
                <textarea
                  id="bulk-push-message"
                  className="form-control send-push-textarea"
                  rows={4}
                  value={bulkPushMessage}
                  onChange={(e) => setBulkPushMessage(e.target.value)}
                  placeholder="Message body"
                />
              </div>
              <div className="modal-actions send-push-modal-actions">
                <button type="button" className="btn btn-primary send-push-submit" onClick={sendBulkPush} disabled={bulkPushSending}>
                  {bulkPushSending ? 'Sending…' : 'Send'}
                </button>
                <button type="button" className="btn send-push-cancel" onClick={() => !bulkPushSending && setBulkPushOpen(false)} disabled={bulkPushSending}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
