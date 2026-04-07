/**
 * Insert a row into ErrandWib `st_ordernew_history` across schema variants.
 * Many DBs use `created_at` / `date_modified` instead of `date_created` / `date_added`;
 * falling through to `(order_id, status)` only leaves NULL timestamps (dashboard shows "—").
 *
 * @param {import('mysql2/promise').Pool} errandPool
 * @param {{
 *   orderId: number,
 *   status: string,
 *   remarks?: string,
 *   latitude?: number|null,
 *   longitude?: number|null,
 * }} opts
 * @returns {Promise<boolean>} true if a row was inserted
 */
async function insertStOrdernewHistoryRow(errandPool, opts) {
  const orderId = opts.orderId;
  const st = opts.status;
  const rem = opts.remarks != null && String(opts.remarks).trim() ? String(opts.remarks).trim() : '';
  const latRaw = opts.latitude != null && String(opts.latitude).trim() !== '' ? parseFloat(String(opts.latitude)) : NaN;
  const lngRaw = opts.longitude != null && String(opts.longitude).trim() !== '' ? parseFloat(String(opts.longitude)) : NaN;
  const hasGeo = Number.isFinite(latRaw) && Number.isFinite(lngRaw);

  /** @type {[string, unknown[]][]} */
  const attempts = [];

  const pushRemGeo = (cols, placeholders, extraParams = []) => {
    const params = [orderId, st, rem, ...extraParams];
    attempts.push([`INSERT INTO st_ordernew_history (${cols}) VALUES (${placeholders})`, params]);
  };
  const pushNoRemGeo = (cols, placeholders, extraParams = []) => {
    const params = [orderId, st, ...extraParams];
    attempts.push([`INSERT INTO st_ordernew_history (${cols}) VALUES (${placeholders})`, params]);
  };

  if (rem && hasGeo) {
    pushRemGeo(
      'order_id, status, remarks, date_created, latitude, longitude',
      '?, ?, ?, NOW(), ?, ?',
      [latRaw, lngRaw]
    );
    pushRemGeo(
      'order_id, status, remarks, date_added, latitude, longitude',
      '?, ?, ?, NOW(), ?, ?',
      [latRaw, lngRaw]
    );
    pushRemGeo(
      'order_id, status, remarks, created_at, latitude, longitude',
      '?, ?, ?, NOW(), ?, ?',
      [latRaw, lngRaw]
    );
    pushRemGeo(
      'order_id, status, remarks, date_modified, latitude, longitude',
      '?, ?, ?, NOW(), ?, ?',
      [latRaw, lngRaw]
    );
  }
  if (rem) {
    pushRemGeo('order_id, status, remarks, date_created', '?, ?, ?, NOW()');
    pushRemGeo('order_id, status, remarks, date_added', '?, ?, ?, NOW()');
    pushRemGeo('order_id, status, remarks, created_at', '?, ?, ?, NOW()');
    pushRemGeo('order_id, status, remarks, date_modified', '?, ?, ?, NOW()');
    pushRemGeo('order_id, status, remarks, updated_at', '?, ?, ?, NOW()');
  }
  if (hasGeo) {
    pushNoRemGeo('order_id, status, date_created, latitude, longitude', '?, ?, NOW(), ?, ?', [latRaw, lngRaw]);
    pushNoRemGeo('order_id, status, date_added, latitude, longitude', '?, ?, NOW(), ?, ?', [latRaw, lngRaw]);
    pushNoRemGeo('order_id, status, created_at, latitude, longitude', '?, ?, NOW(), ?, ?', [latRaw, lngRaw]);
  }

  pushNoRemGeo('order_id, status, date_created', '?, ?, NOW()');
  pushNoRemGeo('order_id, status, date_added', '?, ?, NOW()');
  pushNoRemGeo('order_id, status, created_at', '?, ?, NOW()');
  pushNoRemGeo('order_id, status, date_modified', '?, ?, NOW()');
  pushNoRemGeo('order_id, status, updated_at', '?, ?, NOW()');
  attempts.push(['INSERT INTO st_ordernew_history (order_id, status) VALUES (?, ?)', [orderId, st]]);

  for (const [sql, params] of attempts) {
    try {
      await errandPool.query(sql, params);
      return true;
    } catch (_) {
      /* try next shape */
    }
  }
  return false;
}

module.exports = { insertStOrdernewHistoryRow };
