import { PAGE_SIZE_OPTIONS } from '../hooks/useTablePagination';

export default function TablePaginationControls({
  pageSize,
  onPageSizeChange,
  currentPage,
  onPageChange,
  totalPages,
  totalItems,
  startRow,
  endRow,
}) {
  const canFirst = currentPage > 1;
  const canPrev = currentPage > 1;
  const canNext = currentPage < totalPages;
  const canLast = totalPages > 1 && currentPage < totalPages;

  return (
    <div className="table-pagination">
      <div className="table-pagination-left">
        <span className="table-pagination-label">Rows:</span>
        <select
          className="table-pagination-select"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="table-pagination-center">
        <span className="table-pagination-range">
          {totalItems === 0 ? '0' : `${startRow}–${endRow}`} of {totalItems}
        </span>
      </div>
      <div className="table-pagination-right">
        <button
          type="button"
          className="table-pagination-btn table-pagination-btn-icon"
          disabled={!canFirst}
          onClick={() => onPageChange(1)}
          aria-label="First page"
        >
          &#171;
        </button>
        <button
          type="button"
          className="table-pagination-btn table-pagination-btn-icon"
          disabled={!canPrev}
          onClick={() => onPageChange(currentPage - 1)}
          aria-label="Previous page"
        >
          &#8249;
        </button>
        <button
          type="button"
          className="table-pagination-btn table-pagination-btn-page active"
          aria-label={`Page ${currentPage}`}
          aria-current="true"
        >
          {currentPage}
        </button>
        <button
          type="button"
          className="table-pagination-btn table-pagination-btn-icon"
          disabled={!canNext}
          onClick={() => onPageChange(currentPage + 1)}
          aria-label="Next page"
        >
          &#8250;
        </button>
        <button
          type="button"
          className="table-pagination-btn table-pagination-btn-icon"
          disabled={!canLast}
          onClick={() => onPageChange(totalPages)}
          aria-label="Last page"
        >
          &#187;
        </button>
      </div>
    </div>
  );
}
