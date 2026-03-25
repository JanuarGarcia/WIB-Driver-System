import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, resolveUploadUrl } from '../api';
import { useTableAutoRefresh } from '../hooks/useTableAutoRefresh';
import { useTablePagination, PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';
import { useTableSort } from '../hooks/useTableSort';
import TablePaginationControls from '../components/TablePaginationControls';
import TableSortControls from '../components/TableSortControls';
import { sanitizeMerchantDisplayName } from '../utils/displayText';

function sectionDate() {
  const d = new Date();
  return `${d.toLocaleString('en-US', { month: 'short' })}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
}

const MERCHANT_SORT_OPTIONS = [
  { key: 'merchant_id', label: 'Merchant ID', compare: (a, b) => String(a.merchant_id ?? '').localeCompare(b.merchant_id ?? '') },
  {
    key: 'restaurant_name',
    label: 'Restaurant',
    compare: (a, b) =>
      (sanitizeMerchantDisplayName(a.restaurant_name) || '').localeCompare(
        sanitizeMerchantDisplayName(b.restaurant_name) || '',
        undefined,
        { sensitivity: 'base' }
      ),
  },
];

function logoUrl(logo) {
  if (!logo || !String(logo).trim()) return null;
  const s = String(logo).trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return resolveUploadUrl(`/uploads/merchants/${encodeURIComponent(s)}`);
}

export default function Merchants() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [merchants, setMerchants] = useState([]);
  const [loading, setLoading] = useState(true);
  const sortKey = searchParams.get('sort') || 'restaurant_name';
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

  const fetchMerchants = () => {
    setLoading(true);
    api('merchants').then(setMerchants).catch(() => setMerchants([])).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchMerchants();
  }, []);

  useTableAutoRefresh(fetchMerchants);

  const sortedMerchants = useTableSort(merchants || [], sortKey, sortOrder, MERCHANT_SORT_OPTIONS);
  const {
    paginatedItems: paginatedMerchants,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalItems,
    startRow,
    endRow,
  } = useTablePagination(sortedMerchants, 10, {
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
            sortOptions={MERCHANT_SORT_OPTIONS.map(({ key, label }) => ({ key, label }))}
            sortKey={sortKey}
            sortOrder={sortOrder}
            onSortChange={setSort}
          />
          <div className="listing-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Logo</th>
                  <th>Merchant ID</th>
                  <th>Restaurant</th>
                </tr>
              </thead>
              <tbody>
                {paginatedMerchants.map((m) => {
                const src = logoUrl(m.logo);
                return (
                  <tr key={m.merchant_id}>
                    <td className="merchant-logo-cell">
                      {src ? (
                        <img
                          src={src}
                          alt=""
                          className="merchant-table-logo"
                          loading="lazy"
                          onError={(e) => {
                            e.target.style.display = 'none';
                            const next = e.target.nextElementSibling;
                            if (next) next.hidden = false;
                          }}
                        />
                      ) : null}
                      <span className="merchant-table-logo-fallback" hidden={!!src}>
                        —
                      </span>
                    </td>
                    <td>{m.merchant_id ?? '—'}</td>
                    <td>{sanitizeMerchantDisplayName(m.restaurant_name) || '—'}</td>
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
      )}
    </div>
  );
}
