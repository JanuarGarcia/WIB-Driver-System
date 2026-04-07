/**
 * Enrich `mt_order_details.addon` JSON using catalog tables:
 * mt_subcategory_item, mt_subcategory_item_translation, mt_subcategory_item_relationships,
 * mt_subcategory, mt_subcategory_translation.
 */

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>[]|null}
 */
function tryParseAddonArray(raw) {
  if (raw == null) return null;
  let s = raw;
  if (Buffer.isBuffer(s)) s = s.toString('utf8');
  if (Array.isArray(s)) return s;
  if (typeof s !== 'object') {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    if (!t || (t[0] !== '[' && t[0] !== '{')) return null;
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) return p;
      if (p && typeof p === 'object') return [p];
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {number|null}
 */
function extractSubItemId(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const keys = ['sub_item_id', 'subItemId', 'subitem_id', 'item_sub_id', 'subcategory_item_id'];
  for (const k of keys) {
    if (entry[k] == null) continue;
    const n = parseInt(String(entry[k]), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {number[]} subcatIds
 * @returns {Promise<Map<number, string>>}
 */
async function fetchSubcategoryDisplayNames(pool, subcatIds) {
  const baseMap = new Map();
  const transMap = new Map();
  const uniq = [...new Set(subcatIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return new Map();
  const ph = uniq.map(() => '?').join(',');

  try {
    const [baseRows] = await pool.query(
      `SELECT subcat_id, subcategory_name FROM mt_subcategory WHERE subcat_id IN (${ph})`,
      uniq
    );
    for (const r of baseRows || []) {
      if (r.subcat_id == null) continue;
      const nm = r.subcategory_name != null ? String(r.subcategory_name).trim() : '';
      if (nm) baseMap.set(Number(r.subcat_id), nm);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  try {
    const [trRows] = await pool.query(
      `SELECT subcat_id, subcategory_name, language FROM mt_subcategory_translation WHERE subcat_id IN (${ph})
       ORDER BY subcat_id,
         CASE LOWER(TRIM(COALESCE(language,''))) WHEN 'default' THEN 0 WHEN 'en' THEN 1 ELSE 2 END,
         id ASC`,
      uniq
    );
    for (const r of trRows || []) {
      if (r.subcat_id == null) continue;
      const id = Number(r.subcat_id);
      const nm = r.subcategory_name != null ? String(r.subcategory_name).trim() : '';
      if (!nm) continue;
      if (!transMap.has(id)) transMap.set(id, nm);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  const out = new Map();
  for (const id of uniq) {
    out.set(id, transMap.get(id) || baseMap.get(id) || '');
  }
  return out;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Record<string, unknown>[]} detailRows
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function enrichOrderDetailsWithSubcategoryAddons(pool, detailRows) {
  if (!Array.isArray(detailRows) || detailRows.length === 0) return detailRows;

  const subItemIds = new Set();
  for (const row of detailRows) {
    const arr = tryParseAddonArray(row.addon ?? row.addons);
    if (!arr) continue;
    for (const e of arr) {
      const sid = extractSubItemId(/** @type {Record<string, unknown>} */ (e));
      if (sid) subItemIds.add(sid);
    }
  }
  const ids = [...subItemIds];
  if (ids.length === 0) return detailRows;

  const ph = ids.map(() => '?').join(',');

  /** @type {Map<number, Record<string, unknown>>} */
  const itemsById = new Map();
  try {
    const [itemRows] = await pool.query(`SELECT * FROM mt_subcategory_item WHERE sub_item_id IN (${ph})`, ids);
    for (const r of itemRows || []) {
      if (r.sub_item_id != null) itemsById.set(Number(r.sub_item_id), r);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  /** @type {Map<number, string>} */
  const itemTransName = new Map();
  try {
    const [trows] = await pool.query(
      `SELECT sub_item_id, sub_item_name, language FROM mt_subcategory_item_translation WHERE sub_item_id IN (${ph})
       ORDER BY sub_item_id,
         CASE LOWER(TRIM(COALESCE(language,''))) WHEN 'default' THEN 0 WHEN 'en' THEN 1 ELSE 2 END,
         id ASC`,
      ids
    );
    for (const r of trows || []) {
      if (r.sub_item_id == null) continue;
      const sid = Number(r.sub_item_id);
      const nm = r.sub_item_name != null ? String(r.sub_item_name).trim() : '';
      if (!nm) continue;
      if (!itemTransName.has(sid)) itemTransName.set(sid, nm);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  /** @type {Map<number, number>} */
  const subcatBySubItem = new Map();
  try {
    const [rels] = await pool.query(
      `SELECT sub_item_id, subcat_id FROM mt_subcategory_item_relationships WHERE sub_item_id IN (${ph}) ORDER BY id ASC`,
      ids
    );
    for (const r of rels || []) {
      if (r.sub_item_id == null || r.subcat_id == null) continue;
      const sid = Number(r.sub_item_id);
      const sc = Number(r.subcat_id);
      if (!Number.isFinite(sc) || sc <= 0) continue;
      if (!subcatBySubItem.has(sid)) subcatBySubItem.set(sid, sc);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  for (const sid of ids) {
    if (subcatBySubItem.has(sid)) continue;
    const item = itemsById.get(sid);
    const cat = item?.category;
    if (cat == null) continue;
    try {
      const parsed = typeof cat === 'string' ? JSON.parse(cat) : cat;
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      const n = parseInt(String(first), 10);
      if (Number.isFinite(n) && n > 0) subcatBySubItem.set(sid, n);
    } catch {
      /* ignore */
    }
  }

  const subcatIds = [...new Set([...subcatBySubItem.values()])];
  const subcatNames = await fetchSubcategoryDisplayNames(pool, subcatIds);

  return detailRows.map((row) => {
    const arr = tryParseAddonArray(row.addon ?? row.addons);
    if (!arr || arr.length === 0) return row;

    const enriched = arr.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const e = /** @type {Record<string, unknown>} */ ({ ...entry });
      const sid = extractSubItemId(e);
      if (!sid) return e;

      const item = itemsById.get(sid);
      const transNm = itemTransName.get(sid);
      const baseNm =
        item?.sub_item_name_trans != null && String(item.sub_item_name_trans).trim()
          ? String(item.sub_item_name_trans).trim()
          : item?.sub_item_name != null
            ? String(item.sub_item_name).trim()
            : '';
      const resolvedName = transNm || baseNm;
      const existingName = e.addon_name ?? e.name;
      if (resolvedName) {
        e.addon_name = resolvedName;
        e.name = resolvedName;
      } else if (existingName != null && String(existingName).trim() !== '') {
        e.addon_name = String(existingName).trim();
      }

      const scid = subcatBySubItem.get(sid);
      if (scid != null) {
        const scn = subcatNames.get(scid);
        if (scn) {
          e.addon_category = scn;
          e.addon_category_label = scn;
        }
      }

      if (item && item.price != null && String(item.price).trim() !== '') {
        const p = Number(item.price);
        if (Number.isFinite(p)) {
          if (e.price == null || e.price === '') e.price = p;
          if (e.addon_price == null || e.addon_price === '') e.addon_price = p;
        }
      }

      e.sub_item_id = sid;
      return e;
    });

    const out = { ...row, addons: enriched };
    try {
      out.addon = JSON.stringify(enriched);
    } catch {
      out.addon = row.addon;
    }
    return out;
  });
}

module.exports = {
  enrichOrderDetailsWithSubcategoryAddons,
  tryParseAddonArray,
  extractSubItemId,
};
