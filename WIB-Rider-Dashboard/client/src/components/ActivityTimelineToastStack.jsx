import { useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { api, statusLabel } from '../api';
import { RIDER_NOTIFICATIONS_POLL_EVENT } from '../hooks/useNotifications';
import {
  markNotificationToastSuppressedFromErrandFeedEvent,
  markNotificationToastSuppressedFromMtFeedEvent,
} from '../utils/notificationToastDedupe';
import { showRiderSystemToast } from '../utils/riderSystemToast';

const SOUND_MUTED_KEY = 'wib_dashboard_sound_muted';

function isSoundMuted() {
  try {
    return localStorage.getItem(SOUND_MUTED_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function playTimelineChime() {
  if (isSoundMuted()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.22);
    setTimeout(() => ctx.close().catch(() => {}), 400);
  } catch (_) {}
}

function feedEventSubtitle(ev) {
  const rem = (ev.remarks || ev.reason || '').trim();
  if (rem) return rem;
  const notes = ev.notes != null ? String(ev.notes).trim() : '';
  if (notes) return notes;
  const by = (ev.update_by_name || ev.update_by_type || '').trim();
  const st = (ev.status || '').trim();
  if (by && st) return `${by} — ${st}`;
  return st || 'Activity updated';
}

/**
 * Polls order-history feeds on the home dashboard and shows the same system toast as rider notifications.
 */
export default function ActivityTimelineToastStack({ dateStr }) {
  const location = useLocation();
  const cursorRef = useRef(null);
  const initDoneRef = useRef(false);
  const seenIdsRef = useRef(new Set());
  const errandCursorRef = useRef(null);
  const errandInitDoneRef = useRef(false);
  const errandSeenIdsRef = useRef(new Set());

  const pushToast = useCallback(
    (ev) => {
      const taskId = ev.resolved_task_id != null ? Number(ev.resolved_task_id) : NaN;
      const errandOid = ev.resolved_errand_order_id != null ? Number(ev.resolved_errand_order_id) : NaN;
      let openId = NaN;
      let kind = 'task';
      if (Number.isFinite(taskId) && taskId > 0) {
        openId = taskId;
        kind = 'task';
      } else if (Number.isFinite(errandOid) && errandOid > 0) {
        openId = -errandOid;
        kind = 'mangan';
      }
      if (!Number.isFinite(openId) || openId === 0) return;
      const hid = ev && ev.id != null ? Number(ev.id) : NaN;
      const toastId = Number.isFinite(hid) ? `timeline-${hid}` : `timeline-${Date.now()}`;

      const statusRaw = (ev.status || '').trim();
      const title = statusLabel(statusRaw) || 'Activity update';
      const byName = (ev.update_by_name || '').trim();
      const byType = (ev.update_by_type || '').trim();
      const byActor = byName || byType;
      const sub = feedEventSubtitle(ev).trim();
      const orderLine =
        kind === 'mangan' ? `Mangan #${Math.abs(openId)}` : `Order #${Math.abs(openId)}`;
      let tertiary = orderLine;
      if (sub && !sub.includes(orderLine) && sub.toLowerCase() !== statusRaw.toLowerCase()) {
        tertiary = `${orderLine} · ${sub}`;
      }

      showRiderSystemToast({
        toastId,
        title,
        byLabel: byActor,
        tertiary,
        orderKind: kind === 'mangan' ? 'mangan' : 'task',
      });
      playTimelineChime();
    },
    []
  );

  useEffect(() => {
    initDoneRef.current = false;
    cursorRef.current = null;
    seenIdsRef.current = new Set();
    errandInitDoneRef.current = false;
    errandCursorRef.current = null;
    errandSeenIdsRef.current = new Set();
  }, [dateStr]);

  useEffect(() => {
    if (location.pathname !== '/') return undefined;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return undefined;

    let cancelled = false;

    const tick = async () => {
      try {
        const params = new URLSearchParams();
        params.set('date', dateStr);
        const after = cursorRef.current != null ? cursorRef.current : 0;
        params.set('after_id', String(after));
        const data = await api(`order-history/feed?${params.toString()}`);
        if (cancelled || !data || typeof data !== 'object') return;
        const cursor = Number(data.cursor);
        const events = Array.isArray(data.events) ? data.events : [];

        if (!initDoneRef.current) {
          initDoneRef.current = true;
          cursorRef.current = Number.isFinite(cursor) ? cursor : 0;
          return;
        }

        let newTaskActivity = false;
        if (events.length) {
          for (const ev of events) {
            const hid = ev && ev.id != null ? Number(ev.id) : NaN;
            if (!Number.isFinite(hid) || seenIdsRef.current.has(hid)) continue;
            seenIdsRef.current.add(hid);
            if (document.visibilityState === 'visible') {
              pushToast(ev);
              markNotificationToastSuppressedFromMtFeedEvent(ev);
            }
            newTaskActivity = true;
          }
        }
        if (Number.isFinite(cursor) && cursor > (cursorRef.current ?? 0)) {
          cursorRef.current = cursor;
        }
        if (newTaskActivity) {
          try {
            window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 450 } }));
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore transient errors */
      }
    };

    const tickErrand = async () => {
      try {
        const params = new URLSearchParams();
        params.set('date', dateStr);
        const after = errandCursorRef.current != null ? errandCursorRef.current : 0;
        params.set('after_id', String(after));
        const data = await api(`order-history/errand-feed?${params.toString()}`);
        if (cancelled || !data || typeof data !== 'object') return;
        const cursor = Number(data.cursor);
        const events = Array.isArray(data.events) ? data.events : [];

        if (!errandInitDoneRef.current) {
          errandInitDoneRef.current = true;
          errandCursorRef.current = Number.isFinite(cursor) ? cursor : 0;
          return;
        }

        let newErrandActivity = false;
        if (events.length) {
          for (const ev of events) {
            const hid = ev && ev.id != null ? Number(ev.id) : NaN;
            if (!Number.isFinite(hid) || errandSeenIdsRef.current.has(hid)) continue;
            errandSeenIdsRef.current.add(hid);
            if (document.visibilityState === 'visible') {
              pushToast(ev);
              markNotificationToastSuppressedFromErrandFeedEvent(ev);
            }
            newErrandActivity = true;
          }
        }
        if (Number.isFinite(cursor) && cursor > (errandCursorRef.current ?? 0)) {
          errandCursorRef.current = cursor;
        }
        if (newErrandActivity) {
          try {
            window.dispatchEvent(new CustomEvent(RIDER_NOTIFICATIONS_POLL_EVENT, { detail: { delayMs: 450 } }));
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore transient errors */
      }
    };

    tick();
    tickErrand();
    const intervalMs = 12000;
    const id = setInterval(() => {
      tick();
      tickErrand();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [location.pathname, dateStr, pushToast]);

  return null;
}
