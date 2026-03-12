import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';

function sectionDate() {
  const d = new Date();
  return `${d.toLocaleString('en-US', { month: 'short' })}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
}

export default function SmsLogs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const sortKey = searchParams.get('sort') || 'date';
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

  const fetchLogs = () => {
    setLoading(true);
    api('sms-logs').then((data) => setLogs(Array.isArray(data) ? data : (data && data.logs) || [])).catch(() => setLogs([])).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  useTableAutoRefresh(fetchLogs);

  const sortedLogs = useTableSort(logs || [], sortKey, sortOrder, SMSLOG_SORT_OPTIONS);
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
    <div className="listing-section">
      {loading && <div className="loading">Loading…</div>}
      {!loading && (
        <div className="listing-table-card">
          <TableSortControls
            sortOptions={SMSLOG_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onSortChange={setSort}
          />
          <div className="listing-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Mobile number</th>
                  <th>Message</th>
                  <th>Gateway</th>
                  <th>Status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {paginatedLogs.map((l) => (
                <tr key={l.id}>
                  <td>{l.id}</td>
                  <td>{l.mobile_number ?? l.to ?? '—'}</td>
                  <td>{(l.message || '').slice(0, 60)}{(l.message || '').length > 60 ? '…' : ''}</td>
                  <td>{l.gateway ?? '—'}</td>
                  <td>{l.status ?? '—'}</td>
                  <td>{formatDate(l.date_created ?? l.date)}</td>
                </tr>
                ))}
              </tbody>
            </table>
            {(!logs || logs.length === 0) && <p className="listing-empty-msg">No SMS logs.</p>}
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
