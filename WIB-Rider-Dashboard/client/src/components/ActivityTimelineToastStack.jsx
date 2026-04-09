import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { api, statusLabel, statusDisplayClass } from '../api';
import { RIDER_NOTIFICATIONS_POLL_EVENT } from '../hooks/useNotifications';
import {
  markNotificationToastSuppressedFromErrandFeedEvent,
  markNotificationToastSuppressedFromMtFeedEvent,
} from '../utils/notificationToastDedupe';

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

let toastKeySeq = 0;

/**
 * Polls order-history feed on the home dashboard and shows teal toasts when the activity timeline changes.
 */
export default function ActivityTimelineToastStack({ dateStr, onOpenTaskTimeline }) {
  const location = useLocation();
  const [toasts, setToasts] = useState([]);
  const cursorRef = useRef(null);
  const initDoneRef = useRef(false);
  const seenIdsRef = useRef(new Set());
  const removeTimersRef = useRef(new Map());

  const removeToast = useCallback((key) => {
    const t = removeTimersRef.current.get(key);
    if (t) clearTimeout(t);
    removeTimersRef.current.delete(key);
    setToasts((prev) => prev.filter((x) => x.key !== key));
  }, []);

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
      const key = `tl-${++toastKeySeq}`;
      const statusRaw = (ev.status || '').trim();
      const line2 = feedEventSubtitle(ev);
      setToasts((prev) => {
        const next = [...prev, { key, taskId: openId, kind, line2, statusRaw, id: ev.id }];
        return next.slice(-5);
      });
      playTimelineChime();
      const tid = setTimeout(() => removeToast(key), 9000);
      removeTimersRef.current.set(key, tid);
    },
    [removeToast]
  );

  const errandCursorRef = useRef(null);
  const errandInitDoneRef = useRef(false);
  const errandSeenIdsRef = useRef(new Set());

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

  useEffect(() => {
    return () => {
      removeTimersRef.current.forEach((t) => clearTimeout(t));
      removeTimersRef.current.clear();
    };
  }, []);

  if (location.pathname !== '/' || toasts.length === 0) return null;

  return createPortal(
    <div className="dashboard-timeline-toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => {
        const sc = statusDisplayClass(t.statusRaw);
        return (
          <button
            key={t.key}
            type="button"
            className="dashboard-timeline-toast"
            onClick={() => {
              onOpenTaskTimeline?.(t.taskId);
              removeToast(t.key);
            }}
          >
            <span className="dashboard-timeline-toast-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                <path d="M12 16v-1M12 8v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <span className="dashboard-timeline-toast-body">
              <span className="dashboard-timeline-toast-line1">
                <span className={`dashboard-timeline-toast-status tag ${sc}`}>{statusLabel(t.statusRaw)}</span>
                <span className="dashboard-timeline-toast-taskid">
                  {t.kind === 'mangan' ? `Mangan #${Math.abs(t.taskId)}` : `Task ID:${t.taskId}`}
                </span>
              </span>
              <span className="dashboard-timeline-toast-line2">{t.line2}</span>
            </span>
            <span className="dashboard-timeline-toast-hint">Open timeline</span>
          </button>
        );
      })}
    </div>,
    document.body
  );
}
