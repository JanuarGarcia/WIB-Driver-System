import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import MapView from './MapView';
import { sanitizeMerchantDisplayName } from '../utils/displayText';
import { RIDER_NOTIFICATIONS_POLL_EVENT } from '../hooks/useNotifications';

export const COUNTRY_CODES = [
  { code: 'PH', dial: '+63', name: 'Philippines', flag: '🇵🇭' },
  { code: 'US', dial: '+1', name: 'United States', flag: '🇺🇸' },
  { code: 'GB', dial: '+44', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'AU', dial: '+61', name: 'Australia', flag: '🇦🇺' },
  { code: 'JP', dial: '+81', name: 'Japan', flag: '🇯🇵' },
  { code: 'SG', dial: '+65', name: 'Singapore', flag: '🇸🇬' },
  { code: 'HK', dial: '+852', name: 'Hong Kong', flag: '🇭🇰' },
  { code: 'AE', dial: '+971', name: 'United Arab Emirates', flag: '🇦🇪' },
  { code: 'SA', dial: '+966', name: 'Saudi Arabia', flag: '🇸🇦' },
  { code: 'IN', dial: '+91', name: 'India', flag: '🇮🇳' },
  { code: 'MY', dial: '+60', name: 'Malaysia', flag: '🇲🇾' },
  { code: 'TH', dial: '+66', name: 'Thailand', flag: '🇹🇭' },
  { code: 'VN', dial: '+84', name: 'Vietnam', flag: '🇻🇳' },
  { code: 'ID', dial: '+62', name: 'Indonesia', flag: '🇮🇩' },
  { code: 'KR', dial: '+82', name: 'South Korea', flag: '🇰🇷' },
  { code: 'CN', dial: '+86', name: 'China', flag: '🇨🇳' },
  { code: 'TW', dial: '+886', name: 'Taiwan', flag: '🇹🇼' },
  { code: 'CA', dial: '+1', name: 'Canada', flag: '🇨🇦' },
  { code: 'PE', dial: '+51', name: 'Peru', flag: '🇵🇪' },
  { code: 'PA', dial: '+507', name: 'Panama', flag: '🇵🇦' },
  { code: 'PY', dial: '+595', name: 'Paraguay', flag: '🇵🇾' },
  { code: 'PG', dial: '+675', name: 'Papua New Guinea', flag: '🇵🇬' },
  { code: 'PS', dial: '+970', name: 'Palestine', flag: '🇵🇸' },
];

const flagImageUrl = (code) => `https://flagcdn.com/w40/${(code || '').toLowerCase()}.png`;

export function CountryCodeDropdown({ value, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = COUNTRY_CODES.find((c) => c.dial === value) || COUNTRY_CODES[0];
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <div className="new-task-country-dropdown" ref={ref}>
      <button
        type="button"
        className="new-task-country-code new-task-country-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <img src={flagImageUrl(selected.code)} alt="" className="new-task-country-flag-img" />
        <span className="new-task-country-chevron" aria-hidden>▼</span>
      </button>
      {open && (
        <div className="new-task-country-list" role="listbox">
          {COUNTRY_CODES.map((c) => (
            <button
              type="button"
              key={c.code}
              role="option"
              aria-selected={c.dial === value}
              className={`new-task-country-option ${c.dial === value ? 'new-task-country-option-selected' : ''}`}
              onClick={() => {
                onChange(c.dial);
                setOpen(false);
              }}
            >
              <img src={flagImageUrl(c.code)} alt="" className="new-task-country-option-flag" />
              <span className="new-task-country-option-text">{c.name} {c.dial}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const DEBOUNCE_MS = 400;
const MAPBOX_GEOCODE_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

function highlightAddressMatch(displayName, query) {
  const q = (query || '').trim();
  if (!q || !displayName) return displayName;
  const lower = displayName.toLowerCase();
  const pos = lower.indexOf(q.toLowerCase());
  if (pos === -1) return displayName;
  return (
    <>
      {displayName.slice(0, pos)}
      <strong>{displayName.slice(pos, pos + q.length)}</strong>
      {displayName.slice(pos + q.length)}
    </>
  );
}

/** Parse Mapbox feature.context into { region, place (city), postcode } for Option C structured address */
function parseMapboxContext(feature) {
  const ctx = feature?.context;
  if (!Array.isArray(ctx)) return null;
  let region = '';
  let place = '';
  let postcode = '';
  for (const c of ctx) {
    const id = (c.id || '').toString();
    const text = (c.text || '').toString().trim();
    if (id.startsWith('region.')) region = text;
    else if (id.startsWith('place.')) place = text;
    else if (id.startsWith('postcode.')) postcode = text;
  }
  if (!region && !place && !postcode) return null;
  return { region, place, postcode };
}

function AddressAutocomplete({ value, onChange, placeholder, required, id, mapboxToken, onSelectWithCoords, onSelectWithStructured }) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const ref = useRef(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  const closeDropdown = () => {
    setOpen(false);
    setSuggestions([]);
    setHighlightIndex(0);
  };

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) closeDropdown();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const looksLikeCompleteAddress = (v) => {
    const s = (v || '').trim();
    return s.length >= 15 && s.includes(',');
  };

  useEffect(() => {
    const q = (value || '').trim();
    if (!q || q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    if (looksLikeCompleteAddress(value)) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    if (!mapboxToken || !mapboxToken.trim()) {
      setSuggestions([]);
      setOpen(true);
      setHighlightIndex(0);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setOpen(true);
      const searchText = encodeURIComponent(q + ', Philippines');
      const params = new URLSearchParams({
        access_token: mapboxToken.trim(),
        country: 'PH',
        limit: '6',
      });
      fetch(`${MAPBOX_GEOCODE_URL}/${searchText}.json?${params}`, {
        method: 'GET',
        signal: controller.signal,
      })
        .then((res) => res.json())
        .then((data) => {
          if (!controller.signal.aborted) {
            const features = Array.isArray(data?.features) ? data.features : [];
            setSuggestions(features);
            setOpen(true);
            setHighlightIndex(0);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [value, mapboxToken]);

  const handleSelect = (displayName, coords, feature) => {
    onChange(displayName);
    if (typeof onSelectWithCoords === 'function' && Array.isArray(coords) && coords.length >= 2) {
      onSelectWithCoords(displayName, coords);
    }
    const structured = feature ? parseMapboxContext(feature) : null;
    if (structured && typeof onSelectWithStructured === 'function') {
      onSelectWithStructured(displayName, coords, structured);
    }
    closeDropdown();
  };

  const handleKeyDown = (e) => {
    if (!open) {
      if (e.key === 'Escape') closeDropdown();
      return;
    }
    if (suggestions.length === 0) {
      if (e.key === 'Escape') closeDropdown();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const feat = suggestions[highlightIndex];
      if (feat && feat.place_name) handleSelect(feat.place_name, feat.geometry?.coordinates, feat);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDropdown();
    }
  };

  const listId = id ? `${id}-suggestions` : 'delivery-address-suggestions';

  return (
    <div className="new-task-address-wrap" ref={ref}>
      <input
        type="text"
        id={id}
        className="new-task-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => !looksLikeCompleteAddress(value) && suggestions.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && suggestions[highlightIndex] ? `suggestion-${highlightIndex}` : undefined}
      />
      {open && (
        <ul
          id={listId}
          className="new-task-address-suggestions"
          role="listbox"
        >
          {!mapboxToken?.trim() && value?.trim().length >= 2 && (
            <li className="new-task-address-suggestion new-task-address-suggestion--muted">Add Mapbox token in Settings to search addresses</li>
          )}
          {mapboxToken?.trim() && loading && suggestions.length === 0 && (
            <li className="new-task-address-suggestion new-task-address-suggestion--muted">Searching…</li>
          )}
          {mapboxToken?.trim() && !loading && suggestions.length === 0 && value?.trim().length >= 2 && (
            <li className="new-task-address-suggestion new-task-address-suggestion--muted">No addresses found</li>
          )}
          {suggestions.map((feat, i) => (
            <li
              key={feat.id || i}
              id={`suggestion-${i}`}
              role="option"
              aria-selected={i === highlightIndex}
              className={`new-task-address-suggestion ${i === highlightIndex ? 'new-task-address-suggestion--highlight' : ''}`}
              onMouseEnter={() => setHighlightIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(feat.place_name, feat.geometry?.coordinates, feat);
              }}
            >
              {highlightAddressMatch(feat.place_name, value.trim())}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function NewTaskModal({ onClose, onSuccess }) {
  const [drivers, setDrivers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [merchants, setMerchants] = useState([]);
  const [selectedMerchantId, setSelectedMerchantId] = useState('');
  const [mapboxToken, setMapboxToken] = useState('');
  const [mapProvider, setMapProvider] = useState('mapbox');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [googleMapStyle, setGoogleMapStyle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    task_description: '',
    trans_type: '', // '' until user picks Pickup or Delivery
    customer_name: '',
    contact_number: '',
    contact_country_code: '+63',
    email_address: '',
    delivery_address: '',
    delivery_address_center: null, // [lng, lat] from Mapbox for customer map
    delivery_date: '',
    driver_id: '',
    team_id: '',
    pickup_option: '',
    pickup_name: '',
    pickup_contact_number: '',
    pickup_contact_country_code: '+63',
    pickup_address: '',
    pickup_address_center: null, // [lng, lat] from Mapbox for merchant map
  });

  const hasChosenType = form.trans_type === 'pickup' || form.trans_type === 'delivery';

  const handleMerchantChange = (merchantId) => {
    const id = merchantId ? String(merchantId).trim() : '';
    setSelectedMerchantId(id);
    if (!id) return;

    const selected = (merchants || []).find((m) => String(m.merchant_id ?? m.id) === id);
    if (selected) {
      const decodedName = sanitizeMerchantDisplayName(selected.restaurant_name);
      setForm((f) => ({
        ...f,
        pickup_name: decodedName || f.pickup_name,
      }));
    }

    api('merchants/' + encodeURIComponent(id) + '/address')
      .then((addr) => {
        const addressStr = (addr.address && String(addr.address).trim()) || [addr.street, addr.city, addr.state, addr.post_code].filter(Boolean).join(', ').trim() || '';
        const center = (addr.longitude != null && addr.latitude != null) ? [Number(addr.longitude), Number(addr.latitude)] : null;
        const phone = (addr.contact_phone && String(addr.contact_phone).trim()) ? String(addr.contact_phone).replace(/^\+/, '') : (addr.restaurant_phone && String(addr.restaurant_phone).trim()) ? String(addr.restaurant_phone).replace(/^\+/, '') : '';
        setForm((f) => ({
          ...f,
          pickup_name:
            sanitizeMerchantDisplayName(addr.restaurant_name) ||
            (addr.contact_name && String(addr.contact_name).trim()) ||
            f.pickup_name,
          pickup_address: addressStr,
          pickup_address_center: center,
          pickup_contact_number: phone || f.pickup_contact_number,
        }));
      })
      .catch((err) => {
        console.error('Merchant address failed:', err);
        if (err?.error && typeof alert === 'function') alert(err.error || 'Could not load merchant address.');
      });
  };

  useEffect(() => {
    api('drivers').then(setDrivers).catch(() => setDrivers([]));
    api('teams').then(setTeams).catch(() => setTeams([]));
    api('merchants').then((list) => setMerchants(Array.isArray(list) ? list : [])).catch(() => setMerchants([]));
    api('settings')
      .then((s) => {
        const provider = (s.map_provider || '').toString().trim().toLowerCase();
        setMapProvider(provider === 'google' ? 'google' : 'mapbox');
        setGoogleApiKey(s.google_api_key || '');
        setMapboxToken((s.mapbox_access_token || '').toString().trim());
        setGoogleMapStyle(s.google_map_style != null ? String(s.google_map_style) : '');
      })
      .catch(() => { setMapboxToken(''); setGoogleApiKey(''); });
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!hasChosenType) return;
    setSubmitting(true);
    const contactFull = (form.contact_country_code || '') + (String(form.contact_number || '').trim());
    const payload = {
      task_description: form.task_description,
      trans_type: form.trans_type,
      customer_name: form.customer_name,
      contact_number: contactFull || undefined,
      email_address: form.email_address || undefined,
      delivery_address: form.delivery_address,
      delivery_date: form.delivery_date || undefined,
    };
    if (form.trans_type === 'pickup') {
      payload.pickup_address = form.pickup_address || undefined;
      payload.pickup_name = form.pickup_name || undefined;
      payload.pickup_contact_number = (form.pickup_contact_country_code || '') + (String(form.pickup_contact_number || '').trim()) || undefined;
    } else if (form.trans_type === 'delivery') {
      payload.merchant_name = form.pickup_name || undefined;
      payload.merchant_address = form.pickup_address || undefined;
    }
    const driverToAssign = form.pickup_option || form.driver_id;
    api('tasks', { method: 'POST', body: JSON.stringify(payload) })
      .then((res) => {
        if (res.id && driverToAssign) {
          return api(`tasks/${res.id}/assign`, { method: 'PUT', body: JSON.stringify({ driver_id: parseInt(driverToAssign, 10) }) });
        }
      })
      .then(() => {
        try {
          window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 0 } }));
        } catch {
          /* ignore */
        }
        if (typeof onSuccess === 'function') onSuccess();
      })
      .catch((err) => alert(err.error || 'Failed to create task'))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="new-task-modal">
      <header className="new-task-modal-header">
        <h1 id="new-task-modal-title" className="new-task-modal-title">New Task</h1>
        <button type="button" className="new-task-modal-close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="new-task-modal-body">
        <div className="new-task-form-col">
          <form className="new-task-form" onSubmit={handleSubmit}>
            <div className="new-task-field">
              <label className="new-task-label">Task description</label>
              <textarea
                className="new-task-input new-task-textarea"
                value={form.task_description}
                onChange={(e) => setForm((f) => ({ ...f, task_description: e.target.value }))}
                rows={3}
                placeholder="Enter task details…"
              />
            </div>

            <div className="new-task-field">
              <span className="new-task-label">Task type</span>
              {!hasChosenType && (
                <p className="new-task-type-hint">Select Pickup or Delivery to continue</p>
              )}
              <div className="new-task-radio-group">
                <label className="new-task-radio-wrap">
                  <input
                    type="radio"
                    name="trans_type"
                    value="pickup"
                    checked={form.trans_type === 'pickup'}
                    onChange={() => setForm((f) => ({ ...f, trans_type: 'pickup' }))}
                    className="new-task-radio"
                  />
                  <span className="new-task-radio-label">Pickup</span>
                </label>
                <label className="new-task-radio-wrap">
                  <input
                    type="radio"
                    name="trans_type"
                    value="delivery"
                    checked={form.trans_type === 'delivery'}
                    onChange={() => setForm((f) => ({ ...f, trans_type: 'delivery' }))}
                    className="new-task-radio"
                  />
                  <span className="new-task-radio-label">Delivery</span>
                </label>
              </div>
            </div>

            {hasChosenType && form.trans_type === 'pickup' && (
              <>
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label">Contact number</label>
                    <div className="new-task-contact-wrap">
                      <CountryCodeDropdown
                        value={form.contact_country_code}
                        onChange={(dial) => setForm((f) => ({ ...f, contact_country_code: dial }))}
                        ariaLabel="Country code"
                      />
                      <input
                        type="text"
                        className="new-task-contact-input"
                        value={form.contact_number}
                        onChange={(e) => setForm((f) => ({ ...f, contact_number: e.target.value }))}
                        placeholder="Phone number"
                      />
                    </div>
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label">Email address</label>
                    <input
                      type="email"
                      className="new-task-input"
                      value={form.email_address}
                      onChange={(e) => setForm((f) => ({ ...f, email_address: e.target.value }))}
                      placeholder="Email address"
                    />
                  </div>
                </div>
                <h3 className="new-task-section-title">Pickup Details</h3>
                <div className="new-task-field">
                  <label className="new-task-label">Select some options</label>
                  <select
                    className="new-task-input new-task-select"
                    value={selectedMerchantId}
                    onChange={(e) => handleMerchantChange(e.target.value || '')}
                    aria-label="Select merchant to prefill address"
                  >
                    <option value="">Select Some Options</option>
                    {(merchants || []).map((m) => (
                      <option key={m.merchant_id ?? m.id} value={m.merchant_id ?? m.id}>
                        {sanitizeMerchantDisplayName(m.restaurant_name) || `Merchant ${m.merchant_id ?? m.id}`}
                      </option>
                    ))}
                  </select>
                  <p className="new-task-merchant-hint">Selecting a merchant prefills name and pickup/merchant address.</p>
                </div>
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label">Name</label>
                    <input
                      type="text"
                      className="new-task-input"
                      value={form.customer_name}
                      onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                      required
                      placeholder="Enter customer name"
                    />
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label">Pickup before</label>
                    <input
                      type="datetime-local"
                      className="new-task-input"
                      value={form.delivery_date}
                      onChange={(e) => setForm((f) => ({ ...f, delivery_date: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="new-task-field">
                  <label className="new-task-label">Pickup Address</label>
                  <AddressAutocomplete
                    value={form.pickup_address}
                    onChange={(v) => setForm((f) => ({ ...f, pickup_address: v, ...(v?.trim() ? {} : { pickup_address_center: null }) }))}
                    placeholder="Street address"
                    required
                    id="pickup-address-pickup"
                    mapboxToken={mapboxToken}
                    onSelectWithCoords={(_, coords) => setForm((f) => ({ ...f, pickup_address_center: coords }))}
                  />
                </div>
                <h3 className="new-task-section-title">Drop Details</h3>
                {form.team_id && (
                  <div className="new-task-field">
                    <label className="new-task-label">Assign driver</label>
                    <select
                      className="new-task-input new-task-select"
                      value={form.pickup_option}
                      onChange={(e) => setForm((f) => ({ ...f, pickup_option: e.target.value }))}
                    >
                      <option value="">Select driver</option>
                      {drivers
                        .filter((d) => String(d.team_id) === String(form.team_id))
                        .map((d) => (
                          <option key={d.id} value={d.id}>{d.full_name || d.username}</option>
                        ))}
                    </select>
                  </div>
                )}
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label">Name</label>
                    <input
                      type="text"
                      className="new-task-input"
                      value={form.pickup_name}
                      onChange={(e) => setForm((f) => ({ ...f, pickup_name: e.target.value }))}
                      placeholder="Drop contact name"
                    />
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label">Contact number</label>
                    <div className="new-task-contact-wrap">
                      <CountryCodeDropdown
                        value={form.pickup_contact_country_code}
                        onChange={(dial) => setForm((f) => ({ ...f, pickup_contact_country_code: dial }))}
                        ariaLabel="Drop country code"
                      />
                      <input
                        type="text"
                        className="new-task-contact-input"
                        value={form.pickup_contact_number}
                        onChange={(e) => setForm((f) => ({ ...f, pickup_contact_number: e.target.value }))}
                        placeholder="Phone number"
                      />
                    </div>
                  </div>
                </div>
                <div className="new-task-field">
                  <label className="new-task-label">Drop Address</label>
                  <AddressAutocomplete
                    value={form.delivery_address}
                    onChange={(v) => setForm((f) => ({ ...f, delivery_address: v, ...(v?.trim() ? {} : { delivery_address_center: null }) }))}
                    placeholder="Street address"
                    id="delivery-address-pickup"
                    mapboxToken={mapboxToken}
                    onSelectWithCoords={(_, coords) => setForm((f) => ({ ...f, delivery_address_center: coords }))}
                  />
                </div>
              </>
            )}

            {hasChosenType && form.trans_type === 'delivery' && (
              <>
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label">Contact number</label>
                    <div className="new-task-contact-wrap">
                      <CountryCodeDropdown
                        value={form.contact_country_code}
                        onChange={(dial) => setForm((f) => ({ ...f, contact_country_code: dial }))}
                        ariaLabel="Country code"
                      />
                      <input
                        type="text"
                        className="new-task-contact-input"
                        value={form.contact_number}
                        onChange={(e) => setForm((f) => ({ ...f, contact_number: e.target.value }))}
                        placeholder="Phone number"
                      />
                    </div>
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label">Email address</label>
                    <input
                      type="email"
                      className="new-task-input"
                      value={form.email_address}
                      onChange={(e) => setForm((f) => ({ ...f, email_address: e.target.value }))}
                      placeholder="Email address"
                    />
                  </div>
                </div>
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label">Name</label>
                    <input
                      type="text"
                      className="new-task-input"
                      value={form.customer_name}
                      onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                      required
                      placeholder="Enter customer name"
                    />
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label">Delivery before</label>
                    <input
                      type="datetime-local"
                      className="new-task-input"
                      value={form.delivery_date}
                      onChange={(e) => setForm((f) => ({ ...f, delivery_date: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="new-task-field">
                  <label className="new-task-label">Delivery Address</label>
                  <AddressAutocomplete
                    value={form.delivery_address}
                    onChange={(v) => setForm((f) => ({ ...f, delivery_address: v, ...(v?.trim() ? {} : { delivery_address_center: null }) }))}
                    placeholder="Street address"
                    required
                    id="delivery-address-delivery"
                    mapboxToken={mapboxToken}
                    onSelectWithCoords={(_, coords) => setForm((f) => ({ ...f, delivery_address_center: coords }))}
                  />
                </div>
                <h3 className="new-task-section-title">Pickup Details</h3>
                <div className="new-task-field">
                  <label className="new-task-label">Select some options</label>
                  <select
                    className="new-task-input new-task-select"
                    value={selectedMerchantId}
                    onChange={(e) => handleMerchantChange(e.target.value || '')}
                    aria-label="Select merchant to prefill address"
                  >
                    <option value="">Select Some Options</option>
                    {(merchants || []).map((m) => (
                      <option key={m.merchant_id ?? m.id} value={m.merchant_id ?? m.id}>
                        {sanitizeMerchantDisplayName(m.restaurant_name) || `Merchant ${m.merchant_id ?? m.id}`}
                      </option>
                    ))}
                  </select>
                  <p className="new-task-merchant-hint">Selecting a merchant prefills name and pickup/merchant address.</p>
                </div>
                {form.team_id && (
                  <div className="new-task-field">
                    <label className="new-task-label">Assign driver</label>
                    <select
                      className="new-task-input new-task-select"
                      value={form.pickup_option}
                      onChange={(e) => setForm((f) => ({ ...f, pickup_option: e.target.value }))}
                    >
                      <option value="">Select driver</option>
                      {drivers
                        .filter((d) => String(d.team_id) === String(form.team_id))
                        .map((d) => (
                          <option key={d.id} value={d.id}>{d.full_name || d.username}</option>
                        ))}
                    </select>
                  </div>
                )}
                <div className="new-task-row">
                  <div className="new-task-field">
                    <label className="new-task-label">Name</label>
                    <input
                      type="text"
                      className="new-task-input"
                      value={form.pickup_name}
                      onChange={(e) => setForm((f) => ({ ...f, pickup_name: e.target.value }))}
                      placeholder="Pickup contact name"
                    />
                  </div>
                  <div className="new-task-field">
                    <label className="new-task-label">Contact number</label>
                    <div className="new-task-contact-wrap">
                      <CountryCodeDropdown
                        value={form.pickup_contact_country_code}
                        onChange={(dial) => setForm((f) => ({ ...f, pickup_contact_country_code: dial }))}
                        ariaLabel="Pickup country code"
                      />
                      <input
                        type="text"
                        className="new-task-contact-input"
                        value={form.pickup_contact_number}
                        onChange={(e) => setForm((f) => ({ ...f, pickup_contact_number: e.target.value }))}
                        placeholder="Phone number"
                      />
                    </div>
                  </div>
                </div>
                <div className="new-task-field">
                  <label className="new-task-label">Pickup Address</label>
                  <AddressAutocomplete
                    value={form.pickup_address}
                    onChange={(v) => setForm((f) => ({ ...f, pickup_address: v, ...(v?.trim() ? {} : { pickup_address_center: null }) }))}
                    placeholder="Street address"
                    id="pickup-address-delivery"
                    mapboxToken={mapboxToken}
                    onSelectWithCoords={(_, coords) => setForm((f) => ({ ...f, pickup_address_center: coords }))}
                  />
                </div>
              </>
            )}

            {hasChosenType && (
              <div className="new-task-field">
                <label className="new-task-label">Select Team</label>
                <select
                  className="new-task-input new-task-select"
                  value={form.team_id}
                  onChange={(e) => setForm((f) => ({ ...f, team_id: e.target.value, driver_id: '', pickup_option: '' }))}
                >
                  <option value="">Select a team</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

            {hasChosenType && form.team_id && (
              <div className="new-task-field">
                <label className="new-task-label">Assign Agent</label>
                <select
                  className="new-task-input new-task-select"
                  value={form.driver_id}
                  onChange={(e) => setForm((f) => ({ ...f, driver_id: e.target.value }))}
                >
                  <option value="">Select driver</option>
                  {drivers
                    .filter((d) => String(d.team_id) === String(form.team_id))
                    .map((d) => (
                      <option key={d.id} value={d.id}>{d.full_name || d.username}</option>
                    ))}
                </select>
              </div>
            )}

            <div className="new-task-actions">
              <button type="submit" className="new-task-btn new-task-btn-submit" disabled={submitting || !hasChosenType}>
                {submitting ? 'Creating…' : 'Submit'}
              </button>
              <button type="button" className="new-task-btn new-task-btn-cancel" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        </div>

        <div className="new-task-map-col">
          {form.trans_type === 'delivery' && (
            <>
              <div className="new-task-map-wrap new-task-map-customer">
                <p className="new-task-map-label">Customer location</p>
                <div className="new-task-map-inner">
                  <MapView
                    key="new-task-customer-map"
                    locations={form.delivery_address_center ? [{ lat: form.delivery_address_center[1], lng: form.delivery_address_center[0] }] : []}
                    merchants={[]}
                    mapProvider={mapProvider}
                    apiKey={googleApiKey}
                    mapboxToken={mapboxToken}
                    center={form.delivery_address_center ? [form.delivery_address_center[1], form.delivery_address_center[0]] : [12.8797, 121.774]}
                    zoom={form.delivery_address_center ? 15 : 4}
                    googleMapStyle={googleMapStyle}
                  />
                </div>
              </div>
              <div className="new-task-map-wrap new-task-map-merchant">
                <p className="new-task-map-label">Merchant / Restaurant location</p>
                <div className="new-task-map-inner">
                  <MapView
                    key="new-task-merchant-map"
                    locations={[]}
                    merchants={form.pickup_address_center ? [{ lat: form.pickup_address_center[1], lng: form.pickup_address_center[0] }] : []}
                    mapProvider={mapProvider}
                    apiKey={googleApiKey}
                    mapboxToken={mapboxToken}
                    center={form.pickup_address_center ? [form.pickup_address_center[1], form.pickup_address_center[0]] : [12.8797, 121.774]}
                    zoom={form.pickup_address_center ? 15 : 4}
                    googleMapStyle={googleMapStyle}
                  />
                </div>
              </div>
            </>
          )}
          {form.trans_type === 'pickup' && (
            <>
              <div className="new-task-map-wrap new-task-map-customer">
                <p className="new-task-map-label">Pickup location</p>
                <div className="new-task-map-inner">
                  <MapView
                    key="new-task-pickup-map"
                    locations={[]}
                    merchants={form.pickup_address_center ? [{ lat: form.pickup_address_center[1], lng: form.pickup_address_center[0] }] : []}
                    mapProvider={mapProvider}
                    apiKey={googleApiKey}
                    mapboxToken={mapboxToken}
                    center={form.pickup_address_center ? [form.pickup_address_center[1], form.pickup_address_center[0]] : [12.8797, 121.774]}
                    zoom={form.pickup_address_center ? 15 : 4}
                    googleMapStyle={googleMapStyle}
                  />
                </div>
              </div>
              <div className="new-task-map-wrap new-task-map-merchant">
                <p className="new-task-map-label">Drop location</p>
                <div className="new-task-map-inner">
                  <MapView
                    key="new-task-drop-map"
                    locations={form.delivery_address_center ? [{ lat: form.delivery_address_center[1], lng: form.delivery_address_center[0] }] : []}
                    merchants={[]}
                    mapProvider={mapProvider}
                    apiKey={googleApiKey}
                    mapboxToken={mapboxToken}
                    center={form.delivery_address_center ? [form.delivery_address_center[1], form.delivery_address_center[0]] : [12.8797, 121.774]}
                    zoom={form.delivery_address_center ? 15 : 4}
                    googleMapStyle={googleMapStyle}
                  />
                </div>
              </div>
            </>
          )}
          {!hasChosenType && (
            <div className="new-task-map-wrap">
              <MapView locations={[]} merchants={[]} mapProvider={mapProvider} apiKey={googleApiKey} mapboxToken={mapboxToken} googleMapStyle={googleMapStyle} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
