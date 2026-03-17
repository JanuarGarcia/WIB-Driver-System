import { useState, useMemo, useEffect } from 'react';

export const PAGE_SIZE_OPTIONS = [5, 10, 15];

/**
 * Hook for client-side table pagination.
 * @param {Array} items - Full array of items to paginate
 * @param {number} defaultPageSize - Default rows per page (5, 10, or 15)
 * @param {{ initialPage?: number, initialPageSize?: number, page?: number, pageSize?: number, onPageChange?: (n: number) => void, onPageSizeChange?: (n: number) => void }} options - Initial state or controlled (page/pageSize + callbacks) e.g. from URL
 * @returns {Object} { paginatedItems, pageSize, setPageSize, currentPage, setCurrentPage, totalPages, totalItems, startRow, endRow }
 */
export function useTablePagination(items = [], defaultPageSize = 10, options = {}) {
  const { initialPage, initialPageSize, page: controlledPage, pageSize: controlledPageSize, onPageChange, onPageSizeChange } = options;
  const isControlled = controlledPage != null && onPageChange != null;
  const sizeDefault = PAGE_SIZE_OPTIONS.includes(initialPageSize ?? defaultPageSize) ? (initialPageSize ?? defaultPageSize) : (PAGE_SIZE_OPTIONS.includes(defaultPageSize) ? defaultPageSize : 10);
  const [pageSize, setPageSizeState] = useState(sizeDefault);
  const initialP = initialPage != null && initialPage >= 1 ? Math.floor(initialPage) : 1;
  const [currentPage, setCurrentPageState] = useState(initialP);

  const pageSizeVal = isControlled && controlledPageSize != null ? (PAGE_SIZE_OPTIONS.includes(controlledPageSize) ? controlledPageSize : 10) : pageSize;
  const currentPageVal = isControlled && controlledPage != null ? Math.max(1, Math.floor(controlledPage)) : currentPage;

  const totalItems = (items || []).length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSizeVal));

  useEffect(() => {
    if (currentPageVal > totalPages) {
      const clamped = Math.max(1, totalPages);
      if (isControlled) onPageChange(clamped);
      else setCurrentPageState(clamped);
    }
  }, [totalPages, currentPageVal, isControlled, onPageChange]);

  const paginatedItems = useMemo(() => {
    const list = items || [];
    const start = (currentPageVal - 1) * pageSizeVal;
    return list.slice(start, start + pageSizeVal);
  }, [items, currentPageVal, pageSizeVal]);

  const startRow = totalItems === 0 ? 0 : (currentPageVal - 1) * pageSizeVal + 1;
  const endRow = Math.min(currentPageVal * pageSizeVal, totalItems);

  const setCurrentPage = (p) => {
    const n = Math.max(1, Math.min(totalPages, Math.floor(p)));
    if (isControlled) onPageChange(n);
    else setCurrentPageState(n);
  };

  const setPageSizeWithReset = (val) => {
    const n = typeof val === 'function' ? val(pageSizeVal) : val;
    const next = PAGE_SIZE_OPTIONS.includes(n) ? n : pageSizeVal;
    if (isControlled) {
      onPageSizeChange?.(next);
      onPageChange?.(1);
    } else {
      setPageSizeState(next);
      setCurrentPageState(1);
    }
  };

  return {
    paginatedItems,
    pageSize: pageSizeVal,
    setPageSize: setPageSizeWithReset,
    currentPage: currentPageVal,
    setCurrentPage,
    totalPages,
    totalItems,
    startRow,
    endRow,
  };
}
