/**
 * Whether a tasks-list row can paint TaskDetailsModal before GET tasks/:id or errand-orders/:id returns.
 */
export function listTaskSnapshotMatchesId(snap, id) {
  if (snap == null || typeof snap !== 'object' || id == null) return false;
  if (String(snap.task_id) === String(id)) return true;
  const idNum = Number(id);
  if (!Number.isFinite(idNum) || idNum >= 0) return false;
  if (String(snap.task_source || '').toLowerCase() !== 'errand') return false;
  const so = snap.st_order_id != null ? Number(snap.st_order_id) : NaN;
  const oid = snap.order_id != null ? Number(snap.order_id) : NaN;
  const abs = Math.abs(idNum);
  if (Number.isFinite(so) && so > 0 && abs === so) return true;
  if (Number.isFinite(oid) && oid > 0 && abs === oid) return true;
  return false;
}
