import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';

function smsMobile(r) {
  return String(r?.mobile_number ?? r?.to ?? r?.phone ?? r?.recipient ?? '').trim();
}

const SMSLOG_SORT_OPTIONS = [
  { key: 'id', label: 'ID', compare: (a, b) => (Number(a.id ?? a.sms_id) || 0) - (Number(b.id ?? b.sms_id) || 0) },
  {
    key: 'mobile',
    label: 'Mobile number',
    compare: (a, b) => smsMobile(a).localeCompare(smsMobile(b), undefined, { sensitivity: 'base' }),
  },
  {
    key: 'message',
    label: 'Message',
    compare: (a, b) => String(a.message ?? a.sms_message ?? a.body ?? '').localeCompare(String(b.message ?? b.sms_message ?? b.body ?? ''), undefined, { sensitivity: 'base' }),
  },
  {
    key: 'gateway',
    label: 'Gateway',
    compare: (a, b) => String(a.gateway ?? a.provider ?? '').localeCompare(String(b.gateway ?? b.provider ?? ''), undefined, { sensitivity: 'base' }),
  },
  {
    key: 'status',
    label: 'Status',
    compare: (a, b) => String(a.status ?? '').localeCompare(String(b.status ?? ''), undefined, { sensitivity: 'base' }),
  },
  {
    key: 'date',
    label: 'Date',
    compare: (a, b) =>
      new Date(a.date_created ?? a.date_sent ?? a.date ?? a.created_at ?? 0) -
      new Date(b.date_created ?? b.date_sent ?? b.date ?? b.created_at ?? 0),
  },
];

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
                <tr key={l.id ?? l.sms_id ?? `${l.mobile_number}-${l.date_created}`}>
                  <td>{l.id ?? l.sms_id ?? '—'}</td>
                  <td>{l.mobile_number ?? l.to ?? l.phone ?? l.recipient ?? '—'}</td>
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
