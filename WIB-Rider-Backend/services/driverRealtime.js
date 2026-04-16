const KEEPALIVE_MS = 25000;

/** @type {Map<number, Set<import('express').Response>>} */
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

function subscribeDriverSse(res, driverId, initPayload = null) {
  const did = parseDriverId(driverId);
  if (!did) return { ok: false, error: 'invalid_driver_id' };

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!subscribersByDriverId.has(did)) subscribersByDriverId.set(did, new Set());
  subscribersByDriverId.get(did).add(res);

  // Initial state (optional), then keepalive pings to keep proxies from closing idle streams.
  if (initPayload) sseWrite(res, 'init', initPayload);
  sseWrite(res, 'ping', { t: Date.now() });
  const pingId = setInterval(() => sseWrite(res, 'ping', { t: Date.now() }), KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(pingId);
    const set = subscribersByDriverId.get(did);
    if (set) {
      set.delete(res);
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
  for (const res of subs) {
    try {
      sseWrite(res, event, payload);
    } catch (_) {
      /* ignore broken streams */
    }
  }
}

module.exports = {
  subscribeDriverSse,
  emitToDriver,
};

