import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import TrackbackMap from '../components/TrackbackMap';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Normalize to YYYY-MM-DD for API and state. */
function toDateOnly(v) {
  if (!v) return todayStr();
  const s = typeof v === 'string' ? v : (v && v.date) || '';
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : todayStr();
}

/** Human-readable date for display. */
function formatDateLabel(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(toDateOnly(dateStr) + 'T12:00:00');
  return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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

export default function DriverTrackback() {
  const [drivers, setDrivers] = useState([]);
  const [selectedDriver, setSelectedDriver] = useState('');
  const [trackbackDates, setTrackbackDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [loading, setLoading] = useState(true);
  const [datesLoading, setDatesLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [trackPoints, setTrackPoints] = useState([]);
  const [replayError, setReplayError] = useState(null);
  const [dateCalendarOpen, setDateCalendarOpen] = useState(false);
  const [datePopoverRect, setDatePopoverRect] = useState({ top: 0, left: 0 });
  const [calendarViewMonth, setCalendarViewMonth] = useState(() => new Date().getMonth() + 1);
  const [calendarViewYear, setCalendarViewYear] = useState(() => new Date().getFullYear());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState(() => new Date());
  const dateTriggerRef = useRef(null);

  useEffect(() => {
    api('drivers').then((list) => setDrivers(Array.isArray(list) ? list : (list && list.drivers) || [])).catch(() => setDrivers([])).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedDriver) {
      setTrackbackDates([]);
      setReplayError(null);
      return;
    }
    setDatesLoading(true);
    setReplayError(null);
    api('driver-trackback/dates?driver_id=' + encodeURIComponent(selectedDriver))
      .then((dates) => {
        const raw = Array.isArray(dates) ? dates : [];
        const list = raw.map((d) => toDateOnly(typeof d === 'string' ? d : d?.date ?? d));
        setTrackbackDates(list);
        const current = toDateOnly(selectedDate);
        if (list.length && !list.includes(current)) setSelectedDate(list[0]);
      })
      .catch(() => setTrackbackDates([]))
      .finally(() => setDatesLoading(false));
  }, [selectedDriver]);

  const handleReplay = () => {
    if (!selectedDriver) return;
    const dateOnly = toDateOnly(selectedDate);
    setReplayError(null);
    setReplayLoading(true);
    api('driver-trackback?driver_id=' + encodeURIComponent(selectedDriver) + '&date=' + encodeURIComponent(dateOnly))
      .then((data) => {
        const points = Array.isArray(data) ? data : (data && data.points) || [];
        setTrackPoints(points);
        setReplayError(points.length === 0 ? 'No track points for this date. Location history is recorded when the driver app is in use.' : null);
      })
      .catch((err) => {
        setTrackPoints([]);
        setReplayError(err?.error || err?.message || 'Failed to load track. Try another date or check the backend.');
      })
      .finally(() => setReplayLoading(false));
  };

  useLayoutEffect(() => {
    if (!dateCalendarOpen || !dateTriggerRef.current) return;
    const rect = dateTriggerRef.current.getBoundingClientRect();
    setDatePopoverRect({ top: rect.bottom, left: rect.left });
  }, [dateCalendarOpen]);

  useEffect(() => {
    if (!dateCalendarOpen) return;
    const handleClickOutside = (e) => {
      if (e.target.closest('[data-trackback-date-popover]') || dateTriggerRef.current?.contains(e.target)) return;
      setDateCalendarOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dateCalendarOpen]);

  const openDateCalendar = () => {
    const d = dateOnly ? new Date(dateOnly + 'T12:00:00') : new Date();
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

  const dateOnly = toDateOnly(selectedDate);

  return (
    <div className="listing-section driver-trackback-page">
      <div className="trackback-toolbar">
        <label className="trackback-label">
          <span className="trackback-label-text">Driver</span>
          <select className="form-control trackback-select" value={selectedDriver} onChange={(e) => setSelectedDriver(e.target.value)} disabled={loading} aria-label="Select driver">
            <option value="">Choose driver</option>
            {(drivers || []).map((d) => (
              <option key={d.driver_id || d.id} value={d.driver_id || d.id}>
                {d.full_name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.email || 'Driver ' + (d.driver_id || d.id)}
              </option>
            ))}
          </select>
        </label>
        <label className="trackback-label">
          <span className="trackback-label-text">Date</span>
          <button
            type="button"
            ref={dateTriggerRef}
            className="form-control trackback-date-input trackback-date-trigger"
            onClick={() => (dateCalendarOpen ? closeDateCalendar() : openDateCalendar())}
            disabled={loading || datesLoading}
            aria-label="Select date"
            aria-expanded={dateCalendarOpen}
          >
            <span className="trackback-date-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/></svg>
            </span>
            <span className="trackback-date-text">{dateOnly ? formatDateLabel(dateOnly) : 'Select date'}</span>
          </button>
          {dateCalendarOpen && createPortal(
            <div
              className="tasks-panel-calendar-popover tasks-panel-calendar-widget tasks-panel-calendar-portal"
              data-trackback-date-popover
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
        <button type="button" className="btn btn-sm btn-primary trackback-replay-btn" onClick={handleReplay} disabled={loading || replayLoading || !selectedDriver}>
          {replayLoading ? 'Loading…' : 'Replay'}
        </button>
      </div>
      <div className="trackback-map-section">
        {replayLoading && trackPoints.length === 0 ? (
          <div className="track-map-placeholder track-map-empty">
            <p className="trackback-placeholder-text">Loading track…</p>
          </div>
        ) : trackPoints.length > 0 ? (
          <TrackbackMap points={trackPoints} />
        ) : (
          <div className="track-map-placeholder track-map-empty">
            <p className="trackback-placeholder-text">Select a driver and date, then click <strong>Replay</strong> to load track history.</p>
            {replayError && <p className="trackback-placeholder-hint">{replayError}</p>}
          </div>
        )}
      </div>
      {trackPoints.length > 0 && (
        <p className="trackback-summary text-muted">
          {trackPoints.length} point{trackPoints.length !== 1 ? 's' : ''} on {formatDateLabel(dateOnly)}.
        </p>
      )}
    </div>
  );
}
