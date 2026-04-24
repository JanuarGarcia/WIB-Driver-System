const KEEPALIVE_MS = 25000;

/** @typedef {{ res: import('express').Response, authToken: string|null }} DriverSseSubscriber */

/** @type {Map<number, Set<DriverSseSubscriber>>} */
const subscribersByDriverId = new Map();

function parseDriverId(raw) {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sseWrite(res, event, data) {
  if (!res || res.writableEnded) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
}

function normalizeAuthToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

function resolveSubscribeArgs(authTokenOrInitPayload, maybeInitPayload) {
  if (
    maybeInitPayload === undefined &&
    authTokenOrInitPayload &&
    typeof authTokenOrInitPayload === 'object' &&
    !Array.isArray(authTokenOrInitPayload)
  ) {
    return { authToken: null, initPayload: authTokenOrInitPayload };
  }
  return {
    authToken: normalizeAuthToken(authTokenOrInitPayload),
    initPayload: maybeInitPayload ?? null,
  };
}

function subscribeDriverSse(res, driverId, authTokenOrInitPayload = null, maybeInitPayload = null) {
  const did = parseDriverId(driverId);
  if (!did) return { ok: false, error: 'invalid_driver_id' };
  const { authToken, initPayload } = resolveSubscribeArgs(authTokenOrInitPayload, maybeInitPayload);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!subscribersByDriverId.has(did)) subscribersByDriverId.set(did, new Set());
  const subscriber = { res, authToken };
  subscribersByDriverId.get(did).add(subscriber);

  // Initial state (optional), then keepalive pings to keep proxies from closing idle streams.
  if (initPayload) sseWrite(res, 'init', initPayload);
  sseWrite(res, 'ping', { t: Date.now() });
  const pingId = setInterval(() => sseWrite(res, 'ping', { t: Date.now() }), KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(pingId);
    const set = subscribersByDriverId.get(did);
    if (set) {
      set.delete(subscriber);
      if (set.size === 0) subscribersByDriverId.delete(did);
    }
  };
  res.on('close', cleanup);
  res.on('finish', cleanup);
  return { ok: true };
}

function emitToDriver(driverId, event, payload) {
  const did = parseDriverId(driverId);
  if (!did) return;
  const subs = subscribersByDriverId.get(did);
  if (!subs || subs.size === 0) return;
  for (const subscriber of subs) {
    try {
      sseWrite(subscriber.res, event, payload);
    } catch (_) {
      /* ignore broken streams */
    }
  }
}

function disconnectDriverSubscribers(driverId, opts = {}) {
  const did = parseDriverId(driverId);
  if (!did) return 0;
  const subs = subscribersByDriverId.get(did);
  if (!subs || subs.size === 0) return 0;

  const exceptAuthToken = normalizeAuthToken(opts.exceptAuthToken);
  const payload = opts.reason ? { reason: String(opts.reason) } : {};
  let disconnected = 0;

  for (const subscriber of [...subs]) {
    if (exceptAuthToken && subscriber.authToken === exceptAuthToken) continue;
    try {
      sseWrite(subscriber.res, 'session_invalidated', payload);
    } catch (_) {}
    try {
      subscriber.res.end();
    } catch (_) {}
    subs.delete(subscriber);
    disconnected += 1;
  }

  if (subs.size === 0) subscribersByDriverId.delete(did);
  return disconnected;
}

module.exports = {
  disconnectDriverSubscribers,
  subscribeDriverSse,
  emitToDriver,
};
