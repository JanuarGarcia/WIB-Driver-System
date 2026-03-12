import { useState, useEffect } from 'react';
import { api } from '../api';

/**
 * Region → Province → City → Postcode cascade for structured address (Option C).
 * Fetches from GET /api/location/regions, /location/provinces?region_id=, etc.
 * Optional initialValues { region_id, province_id, city_id, postcode } to pre-select (e.g. from Mapbox context).
 */
export default function LocationCascade({
  regionId,
  provinceId,
  cityId,
  postcode,
  onRegionChange,
  onProvinceChange,
  onCityChange,
  onPostcodeChange,
  initialValues,
  className = '',
  showPostcode = true,
}) {
  const [regions, setRegions] = useState([]);
  const [provinces, setProvinces] = useState([]);
  const [cities, setCities] = useState([]);
  const [postcodes, setPostcodes] = useState([]);
  const [loadingRegions, setLoadingRegions] = useState(true);

  const rId = regionId ?? initialValues?.region_id ?? '';
  const pId = provinceId ?? initialValues?.province_id ?? '';
  const cId = cityId ?? initialValues?.city_id ?? '';
  const pc = postcode ?? initialValues?.postcode ?? '';

  useEffect(() => {
    api('location/regions')
      .then(setRegions)
      .catch(() => setRegions([]))
      .finally(() => setLoadingRegions(false));
  }, []);

  useEffect(() => {
    if (!rId) {
      setProvinces([]);
      return;
    }
    api(`location/provinces?region_id=${encodeURIComponent(rId)}`)
      .then(setProvinces)
      .catch(() => setProvinces([]));
  }, [rId]);

  useEffect(() => {
    if (!pId) {
      setCities([]);
      return;
    }
    api(`location/cities?province_id=${encodeURIComponent(pId)}`)
      .then(setCities)
      .catch(() => setCities([]));
  }, [pId]);

  useEffect(() => {
    if (!showPostcode || !cId) {
      setPostcodes([]);
      return;
    }
    api(`location/postcodes?city_id=${encodeURIComponent(cId)}`)
      .then((list) => setPostcodes(Array.isArray(list) ? list : []))
      .catch(() => setPostcodes([]));
  }, [cId, showPostcode]);

  return (
    <div className={`location-cascade ${className}`.trim()}>
      <div className="location-cascade-row">
        <label className="location-cascade-label">Region</label>
        <select
          className="new-task-input new-task-select location-cascade-select"
          value={rId}
          onChange={(e) => {
            const v = e.target.value;
            onRegionChange?.(v);
            onProvinceChange?.('');
            onCityChange?.('');
            onPostcodeChange?.('');
          }}
          aria-label="Region"
        >
          <option value="">Select region</option>
          {loadingRegions ? (
            <option disabled>Loading…</option>
          ) : (
            regions.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))
          )}
        </select>
      </div>
      <div className="location-cascade-row">
        <label className="location-cascade-label">Province</label>
        <select
          className="new-task-input new-task-select location-cascade-select"
          value={pId}
          onChange={(e) => {
            const v = e.target.value;
            onProvinceChange?.(v);
            onCityChange?.('');
            onPostcodeChange?.('');
          }}
          disabled={!rId}
          aria-label="Province"
        >
          <option value="">Select province</option>
          {provinces.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="location-cascade-row">
        <label className="location-cascade-label">City</label>
        <select
          className="new-task-input new-task-select location-cascade-select"
          value={cId}
          onChange={(e) => {
            onCityChange?.(e.target.value);
            onPostcodeChange?.('');
          }}
          disabled={!pId}
          aria-label="City"
        >
          <option value="">Select city</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>
      {showPostcode && (
        <div className="location-cascade-row">
          <label className="location-cascade-label">Postcode</label>
          {postcodes.length > 0 ? (
            <select
              className="new-task-input new-task-select location-cascade-select"
              value={pc}
              onChange={(e) => onPostcodeChange?.(e.target.value)}
              disabled={!cId}
              aria-label="Postcode"
            >
              <option value="">Select postcode</option>
              {postcodes.map((item) => {
                const val = item.id ?? item.postcode ?? item.name;
                const label = item.name ?? item.postcode ?? val;
                return <option key={val} value={val}>{label}</option>;
              })}
            </select>
          ) : (
            <input
              type="text"
              className="new-task-input location-cascade-input"
              value={pc}
              onChange={(e) => onPostcodeChange?.(e.target.value)}
              placeholder="Postcode (optional)"
              aria-label="Postcode"
            />
          )}
        </div>
      )}
    </div>
  );
}
