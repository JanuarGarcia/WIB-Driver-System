import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';

/** Build chart data: tasks per day with counts by status (completed, cancelled, failed, other). */
function buildChartData(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const byDate = {};
  for (const r of rows) {
    const raw = r.date_created || r.created_at;
    const dateStr = raw ? new Date(raw).toISOString().slice(0, 10) : null;
    if (!dateStr) continue;
    if (!byDate[dateStr]) {
      byDate[dateStr] = { date: dateStr, completed: 0, cancelled: 0, failed: 0, other: 0, total: 0 };
    }
    const s = String(r.status || '').toLowerCase().replace(/\s+/g, '');
    if (s === 'completed' || s === 'successful' || s === 'delivered') byDate[dateStr].completed += 1;
    else if (s === 'cancelled') byDate[dateStr].cancelled += 1;
    else if (s === 'failed') byDate[dateStr].failed += 1;
    else byDate[dateStr].other += 1;
    byDate[dateStr].total += 1;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

const REPORT_SORT_OPTIONS = [
  { key: 'task_id', label: 'Task ID', compare: (a, b) => (a.task_id ?? a.id ?? 0) - (b.task_id ?? b.id ?? 0) },
  { key: 'date_created', label: 'Date', compare: (a, b) => new Date(a.date_created || a.created_at || 0) - new Date(b.date_created || b.created_at || 0) },
  { key: 'driver_name', label: 'Driver', compare: (a, b) => String(a.driver_name ?? '').localeCompare(b.driver_name ?? '') },
  { key: 'status', label: 'Status', compare: (a, b) => String(a.status ?? '').localeCompare(b.status ?? '') },
];

export default function Reports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [teams, setTeams] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [timeSelection, setTimeSelection] = useState('week');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [teamId, setTeamId] = useState('');
  const [driverId, setDriverId] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(false);
  const sortKey = searchParams.get('sort') || 'date_created';
  const sortOrder = searchParams.get('order') || 'desc';
  const urlPage = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const urlSize = PAGE_SIZE_OPTIONS.includes(parseInt(searchParams.get('size'), 10)) ? parseInt(searchParams.get('size'), 10) : 10;

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

  useEffect(() => {
    api('teams').then((t) => setTeams(Array.isArray(t) ? t : (t && t.teams) || [])).catch(() => setTeams([]));
    api('drivers').then((d) => setDrivers(Array.isArray(d) ? d : (d && d.drivers) || [])).catch(() => setDrivers([]));
  }, []);

  const loadReport = () => {
    setLoading(true);
    const params = new URLSearchParams({ time: timeSelection, team_id: teamId || '', driver_id: driverId === 'all' ? '' : driverId, status: statusFilter });
    if (timeSelection === 'custom' && startDate) params.set('start_date', startDate);
    if (timeSelection === 'custom' && endDate) params.set('end_date', endDate);
    api('reports?' + params).then(setReportData).catch(() => setReportData(null)).finally(() => setLoading(false));
  };

  const clearFilters = () => {
    setTimeSelection('week');
    setStartDate('');
    setEndDate('');
    setTeamId('');
    setDriverId('all');
    setStatusFilter('all');
    setReportData(null);
  };

  const driversForTeam = teamId
    ? (drivers || []).filter((d) => String(d.team_id ?? d.team) === String(teamId))
    : (drivers || []);
  const hasActiveFilters = timeSelection !== 'week' || teamId || driverId !== 'all' || statusFilter !== 'all' || startDate || endDate;

  const rows = Array.isArray(reportData) ? reportData : [];
  const chartData = useMemo(() => buildChartData(rows), [rows]);
  const chartMax = chartData.length ? Math.max(...chartData.map((d) => d.total), 1) : 1;
  /** Plot area height in px — bar heights are computed in px so they are not broken by flex % layout. */
  const CHART_TRACK_PX = 220;
  const barFillPx = (total) => {
    if (total <= 0) return 6;
    return Math.max(16, Math.round((total / chartMax) * CHART_TRACK_PX));
  };
  const segmentPx = (count, total, barPx) => {
    if (count <= 0 || total <= 0 || barPx <= 0) return 0;
    return Math.max(count > 0 ? 3 : 0, Math.round((count / total) * barPx));
  };
  const sortedRows = useTableSort(rows, sortKey, sortOrder, REPORT_SORT_OPTIONS);
  const {
    paginatedItems: paginatedRows,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalItems,
    startRow,
    endRow,
  } = useTablePagination(sortedRows, 10, {
    page: urlPage,
    pageSize: urlSize,
    onPageChange: setPageAndUrl,
    onPageSizeChange: setPageSizeAndUrl,
  });

  return (
    <div className="listing-section">
      <div className="reports-filters">
        <div className="reports-filters-row">
          <div className="reports-filter-group">
            <label className="reports-filter-label">Time range</label>
            <select className="form-control reports-filter-select" value={timeSelection} onChange={(e) => setTimeSelection(e.target.value)}>
              <option value="week">Past week</option>
              <option value="month">Past month</option>
              <option value="custom">Custom date range</option>
            </select>
            {timeSelection === 'custom' && (
              <div className="reports-filter-custom-dates">
                <label className="reports-filter-label">Start</label>
                <input type="date" className="form-control" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <label className="reports-filter-label">End</label>
                <input type="date" className="form-control" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            )}
          </div>
          <div className="reports-filter-group">
            <label className="reports-filter-label">Team</label>
            <select className="form-control reports-filter-select" value={teamId} onChange={(e) => { setTeamId(e.target.value); setDriverId('all'); }}>
              <option value="">All teams</option>
              {(teams || []).map((t) => <option key={t.team_id || t.id} value={t.team_id || t.id}>{t.team_name || t.name}</option>)}
            </select>
          </div>
          <div className="reports-filter-group">
            <label className="reports-filter-label">Driver</label>
            <select className="form-control reports-filter-select" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="all">All drivers</option>
              {driversForTeam.map((d) => (
                <option key={d.driver_id || d.id} value={d.driver_id || d.id}>
                  {d.full_name || [d.first_name, d.last_name].filter(Boolean).join(' ') || d.email || 'Driver ' + (d.driver_id || d.id)}
                </option>
              ))}
            </select>
          </div>
          <div className="reports-filter-group">
            <label className="reports-filter-label">Status</label>
            <select className="form-control reports-filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <div className="reports-filter-actions">
            <button type="button" className="btn btn-sm btn-primary reports-load-btn" onClick={loadReport} disabled={loading}>
              {loading && <span className="reports-load-spinner" aria-hidden />}
              {loading ? 'Loading…' : 'Load report'}
            </button>
            {hasActiveFilters && (
              <button type="button" className="btn btn-sm reports-clear-btn" onClick={clearFilters} disabled={loading}>
                Clear filters
              </button>
            )}
          </div>
        </div>
      </div>
      {reportData && (
        <>
          {chartData.length > 0 && (
            <div className="reports-chart-card listing-table-card">
              <h3 className="reports-chart-title">Task completion over time</h3>
              <div className="reports-chart-legend">
                <span className="reports-chart-legend-item reports-chart-legend-completed">Completed</span>
                <span className="reports-chart-legend-item reports-chart-legend-cancelled">Cancelled</span>
                <span className="reports-chart-legend-item reports-chart-legend-failed">Failed</span>
                <span className="reports-chart-legend-item reports-chart-legend-other">Other</span>
              </div>
              <div className="reports-chart-bars-wrap">
                <div
                  className="reports-chart-bars"
                  style={{ '--reports-chart-track': `${CHART_TRACK_PX}px` }}
                  role="img"
                  aria-label="Bar chart of tasks per day by status"
                >
                  {chartData.map((d, i) => {
                    const barPx = barFillPx(d.total);
                    return (
                      <div key={d.date} className="reports-chart-bar-col" style={{ animationDelay: `${i * 45}ms` }}>
                        <div className="reports-chart-bar-track">
                          <div className="reports-chart-bar-guides" aria-hidden />
                          <div className="reports-chart-bar" style={{ height: `${barPx}px` }}>
                            {d.completed > 0 && (
                              <div
                                className="reports-chart-bar-segment reports-chart-bar-completed"
                                style={{ height: `${segmentPx(d.completed, d.total, barPx)}px` }}
                                title={`${d.date}: ${d.completed} completed (${d.total} total)`}
                              />
                            )}
                            {d.cancelled > 0 && (
                              <div
                                className="reports-chart-bar-segment reports-chart-bar-cancelled"
                                style={{ height: `${segmentPx(d.cancelled, d.total, barPx)}px` }}
                                title={`${d.date}: ${d.cancelled} cancelled (${d.total} total)`}
                              />
                            )}
                            {d.failed > 0 && (
                              <div
                                className="reports-chart-bar-segment reports-chart-bar-failed"
                                style={{ height: `${segmentPx(d.failed, d.total, barPx)}px` }}
                                title={`${d.date}: ${d.failed} failed (${d.total} total)`}
                              />
                            )}
                            {d.other > 0 && (
                              <div
                                className="reports-chart-bar-segment reports-chart-bar-other"
                                style={{ height: `${segmentPx(d.other, d.total, barPx)}px` }}
                                title={`${d.date}: ${d.other} other (${d.total} total)`}
                              />
                            )}
                          </div>
                        </div>
                        <span className="reports-chart-x-label" title={d.date}>
                          {d.date.slice(5)}
                        </span>
                        <span className="reports-chart-bar-total" aria-hidden="true">
                          {d.total}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <p className="reports-chart-hint text-muted">Tasks per day by status. Hover a bar for counts; number below each day is the daily total.</p>
            </div>
          )}
          <div className="listing-table-card" style={{ marginTop: '1.5rem' }}>
          <p className="text-muted" style={{ margin: '1rem 1rem 0', padding: 0 }}>Task completion for the selected time range and filters.</p>
          <TableSortControls
            sortOptions={REPORT_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onSortChange={setSort}
          />
          <div className="listing-table-wrap">
            {rows.length > 0 ? (
              <table>
                <thead>
                  <tr><th>Task ID</th><th>Driver</th><th>Status</th><th>Date</th></tr>
                </thead>
                <tbody>
                  {paginatedRows.map((r) => (
                    <tr key={r.task_id || r.id}>
                      <td>{r.task_id || r.id}</td>
                      <td>{r.driver_name || '-'}</td>
                      <td>{r.status || '-'}</td>
                      <td>{formatDate(r.date_created || r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="listing-empty-msg">No data for the selected filters.</p>
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
        </>
      )}
    </div>
  );
}
