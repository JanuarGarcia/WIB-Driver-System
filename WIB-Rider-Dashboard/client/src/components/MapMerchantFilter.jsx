import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { sanitizeMerchantDisplayName } from '../utils/displayText';

export const MAP_MERCHANT_FILTER_STORAGE_KEY = 'wib-map-merchant-filter-ids';

export function loadMapMerchantFilterFromSession() {
  try {
    const raw = sessionStorage.getItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

const FILTER_CHANGED = 'wib-map-merchant-filter-changed';

export function saveMapMerchantFilterToSession(ids) {
  const normalized = Array.isArray(ids) ? ids.map((x) => String(x)).filter(Boolean) : [];
  try {
    if (normalized.length === 0) sessionStorage.removeItem(MAP_MERCHANT_FILTER_STORAGE_KEY);
    else sessionStorage.setItem(MAP_MERCHANT_FILTER_STORAGE_KEY, JSON.stringify(normalized));
  } catch (_) {}
  try {
    window.dispatchEvent(new CustomEvent(FILTER_CHANGED, { detail: { ids: normalized } }));
  } catch (_) {}
}

/** Subscribe to dashboard map merchant filter (session + cross-tab). */
export function useMapMerchantFilterSelection() {
  const [ids, setIds] = useState(loadMapMerchantFilterFromSession);
  useEffect(() => {
    const sync = () => setIds(loadMapMerchantFilterFromSession());
    window.addEventListener(FILTER_CHANGED, sync);
    const onStorage = (e) => {
      if (e.key === MAP_MERCHANT_FILTER_STORAGE_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FILTER_CHANGED, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return ids;
}

function merchantRowId(m) {
  return String(m.merchant_id ?? m.id ?? '').trim();
}

function merchantLabel(m) {
  const id = merchantRowId(m);
  const cleaned = sanitizeMerchantDisplayName(m.restaurant_name || '');
  return cleaned || (id ? `Merchant ${id}` : '—');
}

/**
 * Chips + searchable multi-select. Persists to sessionStorage; dashboard map reads via `useMapMerchantFilterSelection`.
 * @param {{ options: Array<{ merchant_id?: number, id?: number, restaurant_name?: string }>, className?: string }} props
 */
export default function MapMerchantFilter({ options = [], className = '' }) {
  const [selectedIds, setSelectedIds] = useState(loadMapMerchantFilterFromSession);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const sync = () => setSelectedIds(loadMapMerchantFilterFromSession());
    const onStorage = (e) => {
      if (e.key === MAP_MERCHANT_FILTER_STORAGE_KEY) sync();
    };
    window.addEventListener(FILTER_CHANGED, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(FILTER_CHANGED, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const selectedSet = useMemo(() => new Set((selectedIds || []).map((x) => String(x))), [selectedIds]);

  const sortedOptions = useMemo(() => {
    const rows = (options || []).filter((m) => merchantRowId(m));
    const byId = new Map();
    rows.forEach((m) => {
      const id = merchantRowId(m);
      if (!byId.has(id)) byId.set(id, m);
    });
    return [...byId.values()].sort((a, b) => merchantLabel(a).localeCompare(merchantLabel(b), undefined, { sensitivity: 'base' }));
  }, [options]);

  const available = useMemo(
    () => sortedOptions.filter((m) => !selectedSet.has(merchantRowId(m))),
    [sortedOptions, selectedSet]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((m) => {
      const name = merchantLabel(m).toLowerCase();
      const id = merchantRowId(m);
      return name.includes(q) || id.includes(q);
    });
  }, [available, query]);

  useEffect(() => {
    const onDoc = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const addId = useCallback(
    (id) => {
      const s = String(id).trim();
      if (!s || selectedSet.has(s)) return;
      const next = [...selectedIds, s];
      setSelectedIds(next);
      saveMapMerchantFilterToSession(next);
      setQuery('');
      setOpen(false);
    },
    [selectedIds, selectedSet]
  );

  const removeId = useCallback(
    (id) => {
      const s = String(id);
      const next = selectedIds.filter((x) => String(x) !== s);
      setSelectedIds(next);
      saveMapMerchantFilterToSession(next);
    },
    [selectedIds]
  );

  const clearAll = useCallback(() => {
    setSelectedIds([]);
    saveMapMerchantFilterToSession([]);
    setQuery('');
    setOpen(false);
  }, []);

  const labelById = useMemo(() => {
    const map = new Map();
    sortedOptions.forEach((m) => {
      const id = merchantRowId(m);
      if (id) map.set(id, merchantLabel(m));
    });
    return map;
  }, [sortedOptions]);

  const rootClass = ['map-merchant-filter', className].filter(Boolean).join(' ');

  return (
    <div className={rootClass} ref={containerRef}>
      <div className="map-merchant-filter-head">
        <span className="map-merchant-filter-label">Merchant filter</span>
        {selectedIds.length > 0 ? (
          <button type="button" className="map-merchant-filter-clear" onClick={clearAll}>
            Clear all
          </button>
        ) : null}
      </div>
      {selectedIds.length > 0 ? (
        <div className="map-merchant-filter-tags" aria-label="Selected merchants">
          {selectedIds.map((id) => (
            <span key={id} className="map-merchant-filter-tag">
              <span className="map-merchant-filter-tag-text">{labelById.get(String(id)) || `Merchant ${id}`}</span>
              <button
                type="button"
                className="map-merchant-filter-tag-remove"
                aria-label={`Remove ${labelById.get(String(id)) || id}`}
                onClick={() => removeId(id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="map-merchant-filter-select-wrap">
        <div className="map-merchant-filter-input-row">
          <input
            type="text"
            className="map-merchant-filter-input"
            placeholder={sortedOptions.length ? 'Search merchants to add…' : 'Loading merchants…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            aria-label="Search merchants"
            aria-expanded={open}
            aria-haspopup="listbox"
            autoComplete="off"
            disabled={sortedOptions.length === 0}
          />
          <span className="map-merchant-filter-chevron" aria-hidden>
            ▼
          </span>
        </div>
        {open && sortedOptions.length > 0 && (
          <ul className="map-merchant-filter-dropdown" role="listbox">
            {filtered.length === 0 ? (
              <li className="map-merchant-filter-option map-merchant-filter-option-empty">No merchants match</li>
            ) : (
              filtered.map((m) => {
                const id = merchantRowId(m);
                return (
                  <li
                    key={id}
                    role="option"
                    className="map-merchant-filter-option"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addId(id);
                    }}
                  >
                    <span className="map-merchant-filter-option-name">{merchantLabel(m)}</span>
                    <span className="map-merchant-filter-option-id">{id}</span>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>
      {selectedIds.length === 0 ? (
        <p className="map-merchant-filter-hint">Leave empty to show all merchants and riders on the dashboard map.</p>
      ) : null}
    </div>
  );
}
