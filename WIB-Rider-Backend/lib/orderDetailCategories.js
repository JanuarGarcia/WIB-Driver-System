/**
 * Resolve menu category / subcategory labels for mt_order_details lines (admin + driver).
 * Uses mt_category_translation (by cat_id), mt_category, mt_item_relationship_category, etc.
 */

/**
 * Merge category rows into best map (lowest cat_sequence wins per item_id).
 */
function mergeOrderItemCategoryMap(best, rows, itemIdKey, nameKey, seqKey) {
  for (const row of rows || []) {
    const iid = row[itemIdKey];
    const name = row[nameKey];
    if (iid == null || !name || !String(name).trim()) continue;
    const seqRaw = row[seqKey];
    const seqN = seqRaw != null && String(seqRaw).trim() !== '' && Number.isFinite(Number(seqRaw)) ? Number(seqRaw) : 999999;
    const k = String(iid);
    const n = String(name).trim();
    const prev = best.get(k);
    if (!prev || seqN < prev.seq) best.set(k, { name: n, seq: seqN });
  }
}

/**
 * Display label per cat_id: prefer mt_category_translation (default → en → …), else mt_category.
 */
async function resolveCategoryLabelsByCatIds(pool, catIds) {
  const out = new Map();
  const uniq = [...new Set((catIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return out;
  const ph = uniq.map(() => '?').join(',');

  const transFirst = new Map();
  try {
    const [trows] = await pool.query(
      `SELECT cat_id, category_name, language FROM mt_category_translation WHERE cat_id IN (${ph})
       ORDER BY cat_id ASC,
         CASE LOWER(TRIM(COALESCE(language,''))) WHEN 'default' THEN 0 WHEN 'en' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
         id ASC`,
      uniq
    );
    for (const r of trows || []) {
      const id = Number(r.cat_id);
      const nm = r.category_name != null ? String(r.category_name).trim() : '';
      if (!nm || transFirst.has(id)) continue;
      transFirst.set(id, nm);
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  const base = new Map();
  try {
    const [rows] = await pool.query(
      `SELECT cat_id,
        NULLIF(TRIM(COALESCE(NULLIF(TRIM(category_name_trans),''), NULLIF(TRIM(category_name),''))), '') AS nm
       FROM mt_category WHERE cat_id IN (${ph})`,
      uniq
    );
    for (const r of rows || []) {
      const id = Number(r.cat_id);
      if (r.nm) base.set(id, String(r.nm).trim());
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }

  for (const id of uniq) {
    out.set(id, transFirst.get(id) || base.get(id) || '');
  }
  return out;
}

async function fillCategoryGapsFromIrcTranslations(pool, bestCat, ph, itemIds, midOk, mid) {
  let sql = `SELECT irc.item_id AS tid, irc.cat_id, COALESCE(c.sequence, 999999) AS cat_sequence
     FROM mt_item_relationship_category irc
     LEFT JOIN mt_category c ON c.cat_id = irc.cat_id
     WHERE irc.item_id IN (${ph})`;
  let relRows = [];
  if (midOk) {
    try {
      const [rows] = await pool.query(
        `${sql} AND irc.merchant_id = ? ORDER BY irc.item_id ASC, cat_sequence ASC, irc.id ASC`,
        [...itemIds, mid]
      );
      relRows = rows || [];
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
  }
  if (!relRows.length) {
    const [rowsAll] = await pool.query(`${sql} ORDER BY irc.item_id ASC, cat_sequence ASC, irc.id ASC`, itemIds);
    relRows = rowsAll || [];
  }
  const catIds = [...new Set((relRows || []).map((r) => r.cat_id).filter((x) => x != null && String(x).trim() !== ''))];
  const labels = await resolveCategoryLabelsByCatIds(pool, catIds);
  for (const r of relRows || []) {
    const nm = labels.get(Number(r.cat_id));
    if (!nm) continue;
    const k = String(r.tid);
    const prev = bestCat.get(k);
    if (!prev || !String(prev.name || '').trim()) {
      mergeOrderItemCategoryMap(bestCat, [{ tid: r.tid, resolved_category: nm, cat_sequence: r.cat_sequence }], 'tid', 'resolved_category', 'cat_sequence');
    }
  }
}

function fillCategoryGapsFromOrderLineCatIds(detailRows, labelsByCatId, bestCat) {
  for (const r of detailRows || []) {
    const iid = r.item_id ?? r.menu_item_id ?? r.itemId;
    const cid = r.cat_id ?? r.category_id;
    if (iid == null || cid == null || String(iid).trim() === '' || String(iid).trim() === '0') continue;
    const nm = labelsByCatId.get(Number(cid));
    if (!nm) continue;
    const k = String(iid);
    const prev = bestCat.get(k);
    if (!prev || !String(prev.name || '').trim()) {
      mergeOrderItemCategoryMap(bestCat, [{ tid: iid, resolved_category: nm, cat_sequence: 999997 }], 'tid', 'resolved_category', 'cat_sequence');
    }
  }
}

/**
 * Resolve category / subcategory / display names for mt_order_details lines:
 * mt_category_translation, mt_item_relationship_category, mt_item_relationship_subcategory,
 * mt_item_relationship_subcategory_item (parent inheritance), mt_item_translation.
 */
async function attachOrderDetailCategories(pool, detailRows, merchantId) {
  if (!Array.isArray(detailRows) || detailRows.length === 0) return detailRows;
  const itemIds = [];
  const seen = new Set();
  for (const r of detailRows) {
    const id = r.item_id ?? r.menu_item_id ?? r.itemId;
    if (id == null || String(id).trim() === '') continue;
    if (String(id).trim() === '0') continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    itemIds.push(id);
  }
  if (itemIds.length === 0) return detailRows;

  const ph = itemIds.map(() => '?').join(',');
  const mid = merchantId != null && merchantId !== '' ? Number(merchantId) : null;
  const midOk = mid != null && Number.isFinite(mid);

  const bestCat = new Map();

  const tryBlock = async (fn) => {
    try {
      await fn();
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
  };

  await tryBlock(async () => {
    const sql = `SELECT ct.item_id AS tid,
        COALESCE(NULLIF(TRIM(c.category_name_trans), ''), NULLIF(TRIM(c.category_name), '')) AS resolved_category,
        COALESCE(c.sequence, 999999) AS cat_sequence
       FROM mt_category_translation ct
       LEFT JOIN mt_category c ON c.cat_id = ct.cat_id
       WHERE ct.item_id IN (${ph})`;
    if (midOk) {
      const [rows] = await pool.query(`${sql} AND ct.merchant_id = ? ORDER BY ct.item_id ASC, cat_sequence ASC, ct.id ASC`, [...itemIds, mid]);
      mergeOrderItemCategoryMap(bestCat, rows, 'tid', 'resolved_category', 'cat_sequence');
    }
    const [rowsAll] = await pool.query(`${sql} ORDER BY ct.item_id ASC, cat_sequence ASC, ct.id ASC`, itemIds);
    mergeOrderItemCategoryMap(bestCat, rowsAll, 'tid', 'resolved_category', 'cat_sequence');
  });

  await tryBlock(async () => {
    const sql = `SELECT irc.item_id AS tid,
        COALESCE(NULLIF(TRIM(c.category_name_trans), ''), NULLIF(TRIM(c.category_name), '')) AS resolved_category,
        COALESCE(c.sequence, 999999) AS cat_sequence
       FROM mt_item_relationship_category irc
       LEFT JOIN mt_category c ON c.cat_id = irc.cat_id
       WHERE irc.item_id IN (${ph})`;
    if (midOk) {
      try {
        const [rows] = await pool.query(`${sql} AND irc.merchant_id = ? ORDER BY irc.item_id ASC, cat_sequence ASC, irc.id ASC`, [...itemIds, mid]);
        mergeOrderItemCategoryMap(bestCat, rows, 'tid', 'resolved_category', 'cat_sequence');
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
      }
    }
    const [rowsAll] = await pool.query(`${sql} ORDER BY irc.item_id ASC, cat_sequence ASC, irc.id ASC`, itemIds);
    mergeOrderItemCategoryMap(bestCat, rowsAll, 'tid', 'resolved_category', 'cat_sequence');
  });

  const parentBySub = new Map();
  await tryBlock(async () => {
    let sql = `SELECT sub_item_id AS sid, item_id AS pid FROM mt_item_relationship_subcategory_item WHERE sub_item_id IN (${ph})`;
    const params = [...itemIds];
    if (midOk) {
      sql += ' AND merchant_id = ?';
      params.push(mid);
    }
    const [rows] = await pool.query(`${sql} ORDER BY id ASC`, params);
    for (const r of rows || []) {
      if (r.sid == null || r.pid == null) continue;
      const ks = String(r.sid);
      if (!parentBySub.has(ks)) parentBySub.set(ks, String(r.pid));
    }
  });

  for (let pass = 0; pass < Math.min(itemIds.length, 8); pass += 1) {
    let changed = false;
    for (const id of itemIds) {
      const ks = String(id);
      if (bestCat.has(ks)) continue;
      const pid = parentBySub.get(ks);
      if (!pid) continue;
      const p = bestCat.get(pid);
      if (p) {
        bestCat.set(ks, { name: p.name, seq: p.seq + 1000 + pass });
        changed = true;
      }
    }
    if (!changed) break;
  }

  await tryBlock(async () => {
    await fillCategoryGapsFromIrcTranslations(pool, bestCat, ph, itemIds, midOk, mid);
  });

  await tryBlock(async () => {
    const lineCatIds = [];
    for (const r of detailRows) {
      const cid = r.cat_id ?? r.category_id;
      if (cid != null && String(cid).trim() !== '') lineCatIds.push(Number(cid));
    }
    const uniqLine = [...new Set(lineCatIds.filter((n) => Number.isFinite(n) && n > 0))];
    if (!uniqLine.length) return;
    const labels = await resolveCategoryLabelsByCatIds(pool, uniqLine);
    fillCategoryGapsFromOrderLineCatIds(detailRows, labels, bestCat);
  });

  const bestSub = new Map();
  const mergeSub = (rows, nameCol, seqCol) => {
    for (const row of rows || []) {
      const iid = row.tid;
      const name = row[nameCol];
      if (iid == null || !name || !String(name).trim()) continue;
      const seqN = row[seqCol] != null && Number.isFinite(Number(row[seqCol])) ? Number(row[seqCol]) : 999999;
      const k = String(iid);
      const n = String(name).trim();
      const prev = bestSub.get(k);
      if (!prev || seqN < prev.seq) bestSub.set(k, { name: n, seq: seqN });
    }
  };

  await tryBlock(async () => {
    const sql = `SELECT irs.item_id AS tid,
        COALESCE(NULLIF(TRIM(s.subcategory_name), ''), NULLIF(TRIM(s.sub_cat_name), ''), NULLIF(TRIM(s.name), '')) AS sub_name,
        COALESCE(irs.id, 0) AS sub_row_id
       FROM mt_item_relationship_subcategory irs
       LEFT JOIN mt_subcategory s ON s.subcat_id = irs.subcat_id
       WHERE irs.item_id IN (${ph})`;
    const params = midOk ? [...itemIds, mid] : [...itemIds];
    const [rows] = await pool.query(
      midOk ? `${sql} AND irs.merchant_id = ? ORDER BY irs.item_id ASC, irs.id ASC` : `${sql} ORDER BY irs.item_id ASC, irs.id ASC`,
      params
    );
    mergeSub(rows, 'sub_name', 'sub_row_id');
  });

  for (let pass = 0; pass < Math.min(itemIds.length, 8); pass += 1) {
    let changed = false;
    for (const id of itemIds) {
      const ks = String(id);
      if (bestSub.has(ks)) continue;
      const pid = parentBySub.get(ks);
      if (!pid) continue;
      const p = bestSub.get(pid);
      if (p) {
        bestSub.set(ks, { name: p.name, seq: p.seq + 1000 });
        changed = true;
      }
    }
    if (!changed) break;
  }

  const nameTrans = new Map();
  await tryBlock(async () => {
    const [trows] = await pool.query(
      `SELECT item_id AS tid, item_name AS tname, language AS lang
       FROM mt_item_translation
       WHERE item_id IN (${ph})
       ORDER BY item_id ASC,
         CASE WHEN LOWER(TRIM(COALESCE(language,''))) = 'en' THEN 0 ELSE 1 END,
         id ASC`,
      itemIds
    );
    for (const r of trows || []) {
      const k = String(r.tid);
      if (!r.tname || !String(r.tname).trim()) continue;
      if (!nameTrans.has(k)) nameTrans.set(k, String(r.tname).trim());
    }
  });

  return detailRows.map((r) => {
    const idVal = r.item_id ?? r.menu_item_id ?? r.itemId;
    if (idVal == null || String(idVal).trim() === '' || String(idVal).trim() === '0') return { ...r };
    const k = String(idVal);
    const existingCat = r.category_name != null && String(r.category_name).trim() !== '' ? String(r.category_name).trim() : '';
    const cat = existingCat || bestCat.get(k)?.name || r.category_name;
    const sub = bestSub.get(k)?.name;
    const tname = nameTrans.get(k);
    const out = { ...r, category_name: cat || r.category_name };
    if (sub && String(sub).trim()) out.subcategory_name = String(sub).trim();
    if (tname) out.item_name_display = tname;
    return out;
  });
}

module.exports = {
  attachOrderDetailCategories,
  mergeOrderItemCategoryMap,
  resolveCategoryLabelsByCatIds,
};
