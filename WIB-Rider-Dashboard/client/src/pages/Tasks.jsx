import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api, formatDate, statusDisplayClass } from '../api';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';
import TaskDetailsModal from '../components/TaskDetailsModal';
import { useTheme } from '../context/ThemeContext';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDateLabel(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getCalendarGrid(viewYear, viewMonth) {
  const first = new Date(viewYear, viewMonth - 1, 1);
  const firstDay = first.getDay();
  const last = new Date(viewYear, viewMonth, 0);
  const daysInMonth = last.getDate();
  const prevMonth = viewMonth === 1 ? 12 : viewMonth - 1;
  const prevYear = viewMonth === 1 ? viewYear - 1 : viewYear;
  const prevLast = new Date(prevYear, prevMonth, 0);
  const prevDays = prevLast.getDate();
  const leading = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    leading.push({ day: prevDays - i, month: prevMonth, year: prevYear, isOther: true });
  }
  const current = [];
  for (let d = 1; d <= daysInMonth; d++) {
    current.push({ day: d, month: viewMonth, year: viewYear, isOther: false });
  }
  const all = [...leading, ...current];
  const remainder = 42 - all.length;
  const nextMonth = viewMonth === 12 ? 1 : viewMonth + 1;
  const nextYear = viewMonth === 12 ? viewYear + 1 : viewYear;
  for (let d = 1; d <= remainder; d++) {
    all.push({ day: d, month: nextMonth, year: nextYear, isOther: true });
  }
  return all;
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unassigned', label: 'Pending' },
  { id: 'assigned', label: 'Acknowledged' },
  { id: 'completed', label: 'Completed' },
];

const TASK_SORT_OPTIONS = [
  { key: 'task_id', label: 'Ref#', compare: (a, b) => (a.task_id ?? 0) - (b.task_id ?? 0) },
  { key: 'delivery_date', label: 'Complete by', compare: (a, b) => new Date(a.delivery_date || 0) - new Date(b.delivery_date || 0) },
  { key: 'status', label: 'Status', compare: (a, b) => String(a.status ?? '').localeCompare(b.status ?? '') },
  { key: 'driver_name', label: 'Driver', compare: (a, b) => String(a.driver_name ?? '').localeCompare(b.driver_name ?? '') },
];

function toDateString(d) {
  const x = d instanceof Date ? d : new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(d) {
  const t = d instanceof Date ? d : new Date(d);
  const h = t.getHours();
  const m = t.getMinutes();
  const s = t.getSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
}

export default function Tasks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(() => new Date());
  const selectedDate = searchParams.get('date') || toDateString(new Date());
  const filter = searchParams.get('filter') || 'all';
  const [searchQuery, setSearchQuery] = useState('');
  const [assignTaskId, setAssignTaskId] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const [drivers, setDrivers] = useState([]);
  const [selectedDriver, setSelectedDriver] = useState('');
  const [detailsTaskId, setDetailsTaskId] = useState(null);
  const [activityRefreshIntervalMs, setActivityRefreshIntervalMs] = useState(30000);
  const [dateCalendarOpen, setDateCalendarOpen] = useState(false);
  const [datePopoverRect, setDatePopoverRect] = useState({ top: 0, left: 0 });
  const [calendarViewMonth, setCalendarViewMonth] = useState(() => new Date().getMonth() + 1);
  const [calendarViewYear, setCalendarViewYear] = useState(() => new Date().getFullYear());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState(() => new Date());
  const dateTriggerRef = useRef(null);
  const [directionsMapSettings, setDirectionsMapSettings] = useState(null);
  const { theme } = useTheme();
  const sortKey = searchParams.get('sort') || 'delivery_date';
  const sortOrder = searchParams.get('order') || 'desc';
  const urlPage = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const urlSize = PAGE_SIZE_OPTIONS.includes(parseInt(searchParams.get('size'), 10)) ? parseInt(searchParams.get('size'), 10) : 10;

  useEffect(() => {
    api('settings')
      .then((s) => {
        const disabled = s.disable_activity_tracking === '1';
        const sec = parseInt(s.activity_refresh_interval, 10);
        const intervalSec = Number.isFinite(sec) && sec >= 5 ? sec : 60;
        setActivityRefreshIntervalMs(disabled ? 86400000 : Math.max(5000, intervalSec * 1000));
        const provider = (s.map_provider || '').toString().trim().toLowerCase();
        setDirectionsMapSettings({
          mapProvider: provider === 'google' ? 'google' : 'mapbox',
          mapboxToken: (s.mapbox_access_token || '').toString().trim(),
          googleApiKey: s.google_api_key || '',
          googleMapStyle: s.google_map_style != null ? String(s.google_map_style) : '',
        });
      })
      .catch(() => {
        setActivityRefreshIntervalMs(30000);
        setDirectionsMapSettings(null);
      });
  }, []);

  const setSelectedDate = (d) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('date', d);
      next.set('page', '1');
      return next;
    });
  };

  const setFilter = (id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('filter', id);
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

  useLayoutEffect(() => {
    if (!dateCalendarOpen || !dateTriggerRef.current) return;
    const rect = dateTriggerRef.current.getBoundingClientRect();
    setDatePopoverRect({ top: rect.bottom, left: rect.left });
  }, [dateCalendarOpen]);

  useEffect(() => {
    if (!dateCalendarOpen) return;
    const handleClickOutside = (e) => {
      if (e.target.closest('[data-tasks-date-popover]') || dateTriggerRef.current?.contains(e.target)) return;
      setDateCalendarOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dateCalendarOpen]);

  const openDateCalendar = () => {
    const d = selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date();
    setCalendarSelectedDate(Number.isNaN(d.getTime()) ? new Date() : d);
    setCalendarViewMonth(d.getMonth() + 1);
    setCalendarViewYear(d.getFullYear());
    setDateCalendarOpen(true);
  };
  const closeDateCalendar = () => setDateCalendarOpen(false);
  const applyDateAndClose = () => {
    const d = calendarSelectedDate;
    setSelectedDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    closeDateCalendar();
  };
  const goPrevMonth = () => {
    if (calendarViewMonth === 1) {
      setCalendarViewMonth(12);
      setCalendarViewYear((y) => y - 1);
    } else setCalendarViewMonth((m) => m - 1);
  };
  const goNextMonth = () => {
    if (calendarViewMonth === 12) {
      setCalendarViewMonth(1);
      setCalendarViewYear((y) => y + 1);
    } else setCalendarViewMonth((m) => m + 1);
  };
  const selectDay = (cell) => {
    const d = new Date(calendarSelectedDate);
    d.setFullYear(cell.year);
    d.setMonth(cell.month - 1);
    d.setDate(cell.day);
    setCalendarSelectedDate(d);
    setCalendarViewMonth(cell.month);
    setCalendarViewYear(cell.year);
  };
  const isSelectedDay = (cell) =>
    calendarSelectedDate.getDate() === cell.day &&
    calendarSelectedDate.getMonth() + 1 === cell.month &&
    calendarSelectedDate.getFullYear() === cell.year;
  const calendarGrid = getCalendarGrid(calendarViewYear, calendarViewMonth);

  const fetchTasks = useCallback(() => {
    setLoading(true);
    const url = selectedDate ? `tasks?date=${encodeURIComponent(selectedDate)}` : 'tasks';
    api(url)
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => {
        setLoading(false);
        setLastUpdated(new Date());
      });
  }, [selectedDate]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useTableAutoRefresh(fetchTasks, activityRefreshIntervalMs);

  const highlightId = searchParams.get('highlight');
  useEffect(() => {
    if (highlightId && !detailsTaskId) {
      const id = parseInt(highlightId, 10);
      if (id) setDetailsTaskId(id);
    }
  }, [highlightId, detailsTaskId]);

  useEffect(() => {
    if (assignTaskId) {
      api('drivers').then(setDrivers).catch(() => setDrivers([]));
      setSelectedDriver('');
    }
  }, [assignTaskId]);

  const doAssign = () => {
    if (!assignTaskId || !selectedDriver) return;
    setAssigning(true);
    api(`tasks/${assignTaskId}/assign`, { method: 'PUT', body: JSON.stringify({ driver_id: parseInt(selectedDriver, 10) }) })
      .then(() => {
        setAssignTaskId(null);
        setSelectedDriver('');
        return api('tasks');
      })
      .then(setTasks)
      .catch((e) => alert(e.error || 'Assign failed'))
      .finally(() => setAssigning(false));
  };

  const openDetails = (taskId) => setDetailsTaskId(taskId);
  const clearHighlight = () => setSearchParams(sp => { const p = new URLSearchParams(sp); p.delete('highlight'); return p; });

  const filteredByStatus = (tasks || []).filter((t) => {
    const s = (t.status || '').toLowerCase();
    if (filter === 'all') return true;
    if (filter === 'unassigned') return s === 'unassigned';
    if (filter === 'assigned') return s === 'assigned';
    if (filter === 'completed') return s === 'completed' || s === 'delivered' || s === 'successful';
    return true;
  });

  const q = (searchQuery || '').trim().toLowerCase();
  const filteredTasks = q
    ? filteredByStatus.filter((t) => {
        const ref = `#${String(t.task_id).padStart(3, '0')}`;
        const order = String(t.order_id ?? '');
        const type = (t.trans_type ?? '').toLowerCase();
        const desc = (t.task_description ?? '').toLowerCase();
        const driver = (t.driver_name ?? '').toLowerCase();
        const customer = (t.customer_name ?? '').toLowerCase();
        const address = (t.delivery_address ?? '').toLowerCase();
        const status = (t.status ?? '').toLowerCase();
        return [ref, order, type, desc, driver, customer, address, status].some((v) => v.includes(q));
      })
    : filteredByStatus;

  const sortedTasks = useTableSort(filteredTasks, sortKey, sortOrder, TASK_SORT_OPTIONS);

  const {
    paginatedItems: paginatedTasks,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalItems,
    startRow,
    endRow,
  } = useTablePagination(sortedTasks, 10, {
    page: urlPage,
    pageSize: urlSize,
    onPageChange: setPageAndUrl,
    onPageSizeChange: setPageSizeAndUrl,
  });

  return (
    <div className="listing-section tasks-listing">
      <div className="listing-tasks-header">
        <div className="listing-tasks-header-left">
          <div className="listing-tasks-date-row">
            <label className="listing-date-picker-wrap">
              <span className="listing-date-picker-label">Show tasks for</span>
              <button
                type="button"
                ref={dateTriggerRef}
                className="listing-date-input listing-date-trigger"
                onClick={() => (dateCalendarOpen ? closeDateCalendar() : openDateCalendar())}
                aria-label="Pick day, month, and year"
                aria-expanded={dateCalendarOpen}
              >
                <span className="listing-date-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/></svg>
                </span>
                <span className="listing-date-text">{selectedDate ? formatDateLabel(selectedDate) : 'Select date'}</span>
              </button>
              {dateCalendarOpen && createPortal(
                <div data-theme={theme} style={{ position: 'fixed', zIndex: 10000 }}>
                  <div
                    className="tasks-panel-calendar-popover tasks-panel-calendar-widget tasks-panel-calendar-portal"
                    data-tasks-date-popover
                    style={{
                      position: 'fixed',
                      left: datePopoverRect.left,
                      top: datePopoverRect.top + 4,
                      width: 320,
                      minWidth: 320,
                    }}
                    onKeyDown={(e) => e.key === 'Escape' && closeDateCalendar()}
                    role="dialog"
                    aria-label="Choose date"
                  >
                  <div className="tasks-panel-calendar-input-bar">
                    {formatDateLabel(`${calendarSelectedDate.getFullYear()}-${String(calendarSelectedDate.getMonth() + 1).padStart(2, '0')}-${String(calendarSelectedDate.getDate()).padStart(2, '0')}`)}
                  </div>
                  <div className="tasks-panel-calendar-nav">
                    <button type="button" className="tasks-panel-calendar-nav-btn" onClick={goPrevMonth} aria-label="Previous month">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                    </button>
                    <button type="button" className="tasks-panel-calendar-nav-btn" onClick={() => { const n = new Date(); setCalendarSelectedDate(n); setCalendarViewMonth(n.getMonth() + 1); setCalendarViewYear(n.getFullYear()); }} aria-label="Today">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
                    </button>
                    <select
                      className="tasks-panel-calendar-month-select"
                      value={calendarViewMonth}
                      onChange={(e) => {
                        const m = parseInt(e.target.value, 10);
                        setCalendarViewMonth(m);
                        const d = new Date(calendarSelectedDate);
                        d.setMonth(m - 1);
                        if (d.getMonth() !== m - 1) d.setDate(0);
                        setCalendarSelectedDate(d);
                      }}
                      aria-label="Select month"
                    >
                      {MONTH_NAMES.map((name, i) => (
                        <option key={i} value={i + 1}>{name}</option>
                      ))}
                    </select>
                    <select
                      className="tasks-panel-calendar-year-select"
                      value={calendarViewYear}
                      onChange={(e) => {
                        const y = parseInt(e.target.value, 10);
                        setCalendarViewYear(y);
                        const d = new Date(calendarSelectedDate);
                        d.setFullYear(y);
                        if (d.getFullYear() !== y) d.setDate(0);
                        setCalendarSelectedDate(d);
                      }}
                      aria-label="Select year"
                    >
                      {(() => {
                        const y = new Date().getFullYear();
                        const years = [];
                        for (let i = y - 10; i <= y + 2; i++) years.push(i);
                        return years.map((yr) => <option key={yr} value={yr}>{yr}</option>);
                      })()}
                    </select>
                    <button type="button" className="tasks-panel-calendar-nav-btn" onClick={goNextMonth} aria-label="Next month">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
                    </button>
                  </div>
                  <div className="tasks-panel-calendar-headers">
                    {DAY_HEADERS.map((h) => (
                      <span key={h} className="tasks-panel-calendar-day-header">{h}</span>
                    ))}
                  </div>
                  <div className="tasks-panel-calendar-grid">
                    {calendarGrid.map((cell, idx) => (
                      <button
                        key={`${cell.year}-${cell.month}-${cell.day}-${idx}`}
                        type="button"
                        className={`tasks-panel-calendar-day ${cell.isOther ? 'tasks-panel-calendar-day-other' : ''} ${isSelectedDay(cell) ? 'tasks-panel-calendar-day-selected' : ''}`}
                        onClick={() => selectDay(cell)}
                      >
                        {cell.day}
                      </button>
                    ))}
                  </div>
                  <div className="tasks-panel-calendar-actions">
                    <button type="button" className="tasks-panel-calendar-today" onClick={() => { setCalendarSelectedDate(new Date()); applyDateAndClose(); }}>
                      Today
                    </button>
                    <button type="button" className="tasks-panel-calendar-close" onClick={applyDateAndClose}>
                      Done
                    </button>
                  </div>
                </div>
                </div>,
                document.body
              )}
            </label>
            <span className="listing-section-date">
              Last updated: {formatTime(lastUpdated)}
            </span>
          </div>
        </div>
        <div className="listing-toolbar">
          <div className="filter-pills">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`filter-pill ${filter === f.id ? 'active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="listing-search-input"
            placeholder="Search tasks…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search tasks"
          />
        </div>
      </div>
      {loading && <div className="loading">Loading…</div>}
      {!loading && (
        <div className="listing-table-card">
          <TableSortControls
            sortOptions={TASK_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onSortChange={setSort}
          />
          <div className="listing-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ref#</th>
                  <th>Order no.</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Driver</th>
                  <th>Customer</th>
                  <th>Address</th>
                  <th>Complete by</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginatedTasks.map((t) => (
                <tr key={t.task_id}>
                  <td>#{String(t.task_id).padStart(3, '0')}</td>
                  <td>{t.order_id ?? '—'}</td>
                  <td>{t.trans_type ?? '—'}</td>
                  <td>{(t.task_description || '').slice(0, 40)}{(t.task_description || '').length > 40 ? '…' : ''}</td>
                  <td>{t.driver_name ?? '—'}</td>
                  <td>{t.customer_name ?? '—'}</td>
                  <td>{(t.delivery_address || '—').slice(0, 30)}{(t.delivery_address || '').length > 30 ? '…' : ''}</td>
                  <td>{formatDate(t.delivery_date)}</td>
                  <td>
                    <span className={`tag ${statusDisplayClass(t.status)}`}>{t.status ?? '—'}</span>
                  </td>
                  <td className="tasks-actions-cell">
                    <div className="task-row-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => openDetails(t.task_id)} title="View details">View</button>
                      {(t.status || '').toLowerCase() === 'unassigned' && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => setAssignTaskId(t.task_id)}>Assign</button>
                      )}
                      {(t.delivery_address || '').trim() && (
                        <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent((t.delivery_address || '').trim())}`} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-ghost" title="Open directions">Directions</a>
                      )}
                    </div>
                  </td>
                </tr>
                ))}
              </tbody>
            </table>
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

      {/* Assign modal */}
      {assignTaskId && (
        <div className="modal-backdrop" onClick={() => !assigning && setAssignTaskId(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Assign task #{assignTaskId}</h3>
              <button type="button" onClick={() => !assigning && setAssignTaskId(null)}>×</button>
            </div>
            <div className="modal-body">
              <label>Driver</label>
              <select value={selectedDriver} onChange={(e) => setSelectedDriver(e.target.value)} className="form-control" style={{ width: '100%' }} disabled={assigning}>
                <option value="">Choose driver</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>{d.full_name || d.username}</option>
                ))}
              </select>
              <div className="modal-actions">
                <button type="button" className="btn btn-primary" onClick={doAssign} disabled={assigning || !selectedDriver}>{assigning ? 'Assigning…' : 'Assign'}</button>
                <button type="button" onClick={() => !assigning && setAssignTaskId(null)} disabled={assigning}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Task details modal */}
      {detailsTaskId != null && (
        <TaskDetailsModal
          taskId={detailsTaskId}
          onClose={() => { setDetailsTaskId(null); if (highlightId) clearHighlight(); }}
          onAssignDriver={(id) => { setDetailsTaskId(null); if (highlightId) clearHighlight(); setAssignTaskId(id); }}
          onTaskListInvalidate={fetchTasks}
          onTaskDeleted={() => { setDetailsTaskId(null); if (highlightId) clearHighlight(); }}
          directionsMapSettings={directionsMapSettings}
        />
      )}
    </div>
  );
}
