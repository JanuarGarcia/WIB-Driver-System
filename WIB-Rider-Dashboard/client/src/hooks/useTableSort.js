import { useMemo } from 'react';

/**
 * Returns a sorted copy of items based on sortKey and sortOrder.
 * @param {Array} items - Array to sort
 * @param {string} sortKey - Key identifying which field to sort by (must match a key in sortOptions)
 * @param {'asc'|'desc'} sortOrder - Sort direction
 * @param {Array<{key: string, label: string, compare: (a,b)=>number}>} sortOptions - Options with compare functions
 * @returns {Array} Sorted array (new reference only when needed)
 */
export function useTableSort(items = [], sortKey, sortOrder, sortOptions = []) {
  return useMemo(() => {
    const list = items || [];
    if (!sortKey || !sortOrder || list.length <= 1) return list;
    const option = sortOptions.find((o) => o.key === sortKey);
    if (!option || typeof option.compare !== 'function') return list;
    const sorted = [...list].sort(option.compare);
    return sortOrder === 'desc' ? sorted.reverse() : sorted;
  }, [items, sortKey, sortOrder, sortOptions]);
}
