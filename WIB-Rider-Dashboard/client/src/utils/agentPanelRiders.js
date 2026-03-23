/**
 * Agent panel rider logic — shared with Dashboard map so rider pins match the "Active" tab
 * (active account + on duty + live app connection).
 */

/** Live app connection — not the same as "on duty". */
export function isLiveConnection(d) {
  const c = String(d?.online_status || d?.connection_status || '').toLowerCase().trim();
  if (!c) return false;
  if (c === 'lost_connection' || c.includes('lost')) return false;
  return c === 'online' || c === 'connected';
}

/** Only numeric `1` is on duty (avoids truthy bugs on string "0"). */
export function isOnDuty(d) {
  const v = d?.on_duty;
  if (v === true) return true;
  if (v === false || v == null) return false;
  const n = Number(v);
  return n === 1;
}

/** "Active" in Agent panel = active account + on duty + live connection. */
export function isAgentPanelOnline(d) {
  return isLiveConnection(d) && isOnDuty(d);
}

/**
 * Driver IDs shown on the Agent panel "Active" tab (before search), for map filtering.
 * @param {{ active?: unknown[], offline?: unknown[], total?: unknown[] }} details
 * @param {string|number|null|undefined} selectedTeamId
 * @returns {Set<string>|null} null = empty API response; caller should try /drivers fallback
 */
export function buildActivePanelDriverIdSet(details, selectedTeamId) {
  const active = Array.isArray(details?.active) ? details.active : [];
  const offline = Array.isArray(details?.offline) ? details.offline : [];
  const total = Array.isArray(details?.total) ? details.total : [];

  if (active.length === 0 && offline.length === 0 && total.length === 0) {
    return null;
  }

  const allDriversRaw = total;
  const allDrivers =
    selectedTeamId != null && selectedTeamId !== ''
      ? allDriversRaw.filter((d) => String(d.team_id ?? '') === String(selectedTeamId))
      : allDriversRaw;

  const activeAccountDrivers = allDrivers.filter((d) => {
    const status = String(d?.status ?? '').toLowerCase().trim();
    return status === '' || status === 'active';
  });

  const ids = new Set();
  for (const d of activeAccountDrivers) {
    if (!isAgentPanelOnline(d)) continue;
    const id = d.id ?? d.driver_id;
    if (id != null && id !== '') ids.add(String(id));
  }
  return ids;
}
