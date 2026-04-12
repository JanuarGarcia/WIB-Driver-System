const TOKEN_KEY = 'wib_dashboard_token';
const ADMIN_ID_KEY = 'wib_dashboard_admin_id';

/**
 * Bumped on every setToken/clearToken so api() can ignore 401s from requests that
 * started before the latest credential change (stale in-flight responses after login).
 */
let authEpoch = 0;

export function getAuthEpoch() {
  return authEpoch;
}

function bumpAuthEpoch() {
  authEpoch += 1;
}

/** Fired when the stored dashboard admin id changes (e.g. after login or /auth/me). Map filter cache key uses this. */
export const DASHBOARD_ADMIN_ID_EVENT = 'wib-dashboard-admin-id';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token, remember = false) {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  if (remember) localStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.setItem(TOKEN_KEY, token);
  bumpAuthEpoch();
}

export function getDashboardAdminId() {
  return localStorage.getItem(ADMIN_ID_KEY) || sessionStorage.getItem(ADMIN_ID_KEY) || '';
}

export function setDashboardAdminId(id, opts = {}) {
  const skipEvent = !!opts.skipEvent;
  const s = id != null ? String(id).trim() : '';
  const prev = getDashboardAdminId();
  localStorage.removeItem(ADMIN_ID_KEY);
  sessionStorage.removeItem(ADMIN_ID_KEY);
  if (s) {
    if (localStorage.getItem(TOKEN_KEY)) localStorage.setItem(ADMIN_ID_KEY, s);
    else sessionStorage.setItem(ADMIN_ID_KEY, s);
  }
  if (!skipEvent && prev !== s) {
    notifyDashboardAdminIdChanged();
  }
}

export function notifyDashboardAdminIdChanged() {
  try {
    window.dispatchEvent(new CustomEvent(DASHBOARD_ADMIN_ID_EVENT));
  } catch (_) {}
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADMIN_ID_KEY);
  sessionStorage.removeItem(ADMIN_ID_KEY);
  bumpAuthEpoch();
}

export function isAuthenticated() {
  return !!getToken();
}
