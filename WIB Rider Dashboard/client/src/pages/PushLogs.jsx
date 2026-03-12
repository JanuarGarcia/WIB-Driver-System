import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDateString(d) {
  const x = d instanceof Date ? d : new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

function formatTime(d) {
  const t = d instanceof Date ? d : new Date(d);
  const h = t.getHours();
  const m = t.getMinutes();
  const s = t.getSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
}

const PUSHLOG_SORT_OPTIONS = [
  { key: 'id', label: 'ID', compare: (a, b) => (a.id ?? 0) - (b.id ?? 0) },
  { key: 'date', label: 'Date', compare: (a, b) => new Date(a.date || 0) - new Date(b.date || 0) },
];

export default function PushLogs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(() => new Date());
  const selectedDate = searchParams.get('date') || toDateString(new Date());
  const [searchQuery, setSearchQuery] = useState('');
  const sortKey = searchParams.get('sort') || 'date';
  const sortOrder = searchParams.get('order') || 'desc';
  const urlPage = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const urlSize = PAGE_SIZE_OPTIONS.includes(parseInt(searchParams.get('size'), 10)) ? parseInt(searchParams.get('size'), 10) : 10;
  const [dateCalendarOpen, setDateCalendarOpen] = useState(false);
  const [datePopoverRect, setDatePopoverRect] = useState({ top: 0, left: 0 });
  const [calendarViewMonth, setCalendarViewMonth] = useState(() => new Date().getMonth() + 1);
  const [calendarViewYear, setCalendarViewYear] = useState(() => new Date().getFullYear());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState(() => new Date());
  const dateTriggerRef = useRef(null);

  const setSelectedDate = (d) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('date', d);
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
      if (e.target.closest('[data-pushlogs-date-popover]') || dateTriggerRef.current?.contains(e.target)) return;
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

  const fetchLogs = useCallback(() => {
    setLoading(true);
    const url = selectedDate ? `driver-push-logs?date=${encodeURIComponent(selectedDate)}` : 'driver-push-logs';
    api(url)
      .then(setLogs)
      .catch(() => setLogs([]))
      .finally(() => {
        setLoading(false);
        setLastUpdated(new Date());
      });
  }, [selectedDate]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useTableAutoRefresh(fetchLogs);

  const q = (searchQuery || '').trim().toLowerCase();
  const filteredLogs = q
    ? (logs || []).filter((l) => {
        const title = (l.title ?? '').toLowerCase();
        const message = (l.message ?? '').toLowerCase();
        const type = (l.type ?? '').toLowerCase();
        const driverId = String(l.driver_id ?? '');
        const status = (l.status ? 'read' : 'unread');
        return [title, message, type, driverId, status].some((v) => v.includes(q));
      })
    : (logs || []);

  const sortedLogs = useTableSort(filteredLogs, sortKey, sortOrder, PUSHLOG_SORT_OPTIONS);
  const {
    paginatedItems: paginatedLogs,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalItems,
    startRow,
    endRow,
  } = useTablePagination(sortedLogs, 10, {
    page: urlPage,
    pageSize: urlSize,
    onPageChange: setPageAndUrl,
    onPageSizeChange: setPageSizeAndUrl,
  });

  return (
    <div className="listing-section push-logs-listing">
      <div className="listing-tasks-header">
        <div className="listing-tasks-header-left">
          <div className="listing-tasks-date-row">
            <label className="listing-date-picker-wrap">
              <span className="listing-date-picker-label">Show logs for</span>
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
                <div
                  className="tasks-panel-calendar-popover tasks-panel-calendar-widget tasks-panel-calendar-portal"
                  data-pushlogs-date-popover
                  style={{
                    position: 'fixed',
                    left: datePopoverRect.left,
                    top: datePopoverRect.top + 4,
                    zIndex: 10000,
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
          <input
            type="search"
            className="listing-search-input"
            placeholder="Search logs…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search push logs"
          />
        </div>
      </div>
      {loading && <div className="loading">Loading…</div>}
      {!loading && (
        <div className="listing-table-card">
          <TableSortControls
            sortOptions={PUSHLOG_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onSortChange={setSort}
          />
          <div className="listing-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Driver ID</th>
                  <th>Title</th>
                  <th>Message</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {paginatedLogs.map((l) => (
                <tr key={l.id}>
                  <td>{l.id}</td>
                  <td>{l.driver_id}</td>
                  <td>{l.title}</td>
                  <td>{(l.message || '').slice(0, 50)}{(l.message || '').length > 50 ? '…' : ''}</td>
                  <td>{l.type}</td>
                  <td>{formatDate(l.date)}</td>
                  <td>{l.status ? 'Read' : 'Unread'}</td>
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
    </div>
  );
}
