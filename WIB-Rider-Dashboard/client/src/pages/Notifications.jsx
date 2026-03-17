import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';

const NOTIFICATION_SORT_OPTIONS = [
  { key: 'trigger', label: 'Trigger', compare: (a, b) => String(a.trigger ?? '').localeCompare(b.trigger ?? '') },
  { key: 'group', label: 'Group', compare: (a, b) => String(a.group ?? '').localeCompare(b.group ?? '') },
];

export default function Notifications() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [list, setList] = useState({ PICKUP: [], DELIVERY: [] });
  const [toggles, setToggles] = useState({});
  const sortKey = searchParams.get('sort') || 'trigger';
  const sortOrder = searchParams.get('order') || 'asc';
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
    api('notification-settings')
      .then((data) => {
        setList(data.list || { PICKUP: [], DELIVERY: [] });
        setToggles(data.toggles || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = (key, value) => setToggles((prev) => ({ ...prev, [key]: value }));
  const handleSave = () => {
    setSaving(true);
    api('notification-settings', { method: 'PUT', body: JSON.stringify({ toggles }) })
      .then(() => {})
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  // Build rows from list (hooks must run unconditionally, so compute before any return)
  const rows = (() => {
    const r = [
      ...(list.PICKUP || []).map((key) => ({ trigger: key, group: 'PICKUP' })),
      ...(list.DELIVERY || []).map((key) => ({ trigger: key, group: 'DELIVERY' })),
    ];
    if (r.length === 0) {
      r.push({ trigger: 'New task assigned', group: 'PICKUP' }, { trigger: 'Task completed', group: 'DELIVERY' });
    }
    return r;
  })();

  const sortedRows = useTableSort(rows, sortKey, sortOrder, NOTIFICATION_SORT_OPTIONS);

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

  if (loading) {
    return (
      <div className="listing-section">
        <div className="loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className="listing-section notifications-page">
      <div className="listing-table-card">
        <TableSortControls
          sortOptions={NOTIFICATION_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
          sortKey={sortKey}
          sortOrder={sortOrder}
          onSortChange={setSort}
        />
        <div className="listing-table-wrap">
          <table>
          <thead>
            <tr>
              <th>Triggers</th>
              <th>Mobile Push</th>
              <th>SMS</th>
              <th>Email</th>
            </tr>
          </thead>
          <tbody>
            {paginatedRows.map(({ trigger, group }) => {
              const prefix = `${group}_${trigger.replace(/\s/g, '_')}`;
              const pushKey = `${prefix}_push`;
              const smsKey = `${prefix}_sms`;
              const emailKey = `${prefix}_email`;
              return (
                <tr key={prefix}>
                  <td>{trigger}</td>
                  <td>
                    <input type="checkbox" checked={!!toggles[pushKey]} onChange={(e) => handleToggle(pushKey, e.target.checked)} />
                  </td>
                  <td>
                    <input type="checkbox" checked={!!toggles[smsKey]} onChange={(e) => handleToggle(smsKey, e.target.checked)} />
                  </td>
                  <td>
                    <input type="checkbox" checked={!!toggles[emailKey]} onChange={(e) => handleToggle(emailKey, e.target.checked)} />
                  </td>
                </tr>
              );
            })}
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
      <div className="notifications-actions">
        <button type="button" className="btn btn-primary notifications-save-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
