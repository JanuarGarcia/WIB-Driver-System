/**
 * Sort controls for tables: "Sort by [dropdown] [Ascending ↓ / Descending ↑]"
 * sortOptions: [{ key: 'name', label: 'Name' }, ...]
 * sortKey, sortOrder, onSortChange({ sortKey, sortOrder })
 */
export default function TableSortControls({ sortOptions = [], sortKey, sortOrder, onSortChange }) {
  if (!sortOptions.length) return null;

  const current = sortOptions.find((o) => o.key === sortKey) || sortOptions[0];
  const effectiveKey = current?.key ?? sortOptions[0].key;

  return (
    <div className="table-sort-controls">
      <span className="table-sort-label">Sort by</span>
      <select
        className="table-sort-select"
        value={effectiveKey}
        onChange={(e) => onSortChange({ sortKey: e.target.value, sortOrder: sortOrder || 'asc' })}
        aria-label="Sort by column"
      >
        {sortOptions.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="table-sort-select"
        value={sortOrder || 'asc'}
        onChange={(e) => onSortChange({ sortKey: effectiveKey, sortOrder: e.target.value })}
        aria-label="Sort order"
      >
        <option value="asc">Ascending ↑</option>
        <option value="desc">Descending ↓</option>
      </select>
    </div>
  );
}
