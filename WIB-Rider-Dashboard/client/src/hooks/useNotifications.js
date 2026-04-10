import { useState, useEffect, useRef, useCallback, useMemo, createElement } from 'react';
import { toast } from 'react-toastify';
import { isAuthenticated } from '../auth';
import { fetchRiderNotifications, markRiderNotificationsViewed } from '../services/notificationApi';
import {
  parseActorFromNotificationMessage,
  formatNotificationMessageForDisplay,
  buildNotificationDedupeKey,
  notificationIdsSharingDedupeKeysWith,
} from '../utils/riderNotificationNavigate';
import { shouldSuppressRiderNotificationToast } from '../utils/notificationToastDedupe';

/** `public/fb-alert.mp3` — Vite serves `public/` at `import.meta.env.BASE_URL`. */
const alertSoundUrl = `${import.meta.env.BASE_URL}fb-alert.mp3`;

/** localStorage: "1" = sound on, "2" = off (default on). */
export const DRV_SOUND_KEY = 'drv_sound_on';

const VISIBLE_POLL_MS = 10_000;
/** Same as visible: hidden tabs are still throttled by the browser, but we do not slow further on purpose. */
const HIDDEN_POLL_MS = VISIBLE_POLL_MS;

/** Dispatch after actions that create server-side notifications (e.g. new task) so the UI does not wait for the next interval. */
export const RIDER_NOTIFICATIONS_POLL_EVENT = 'wib-dashboard-rider-notifications-poll';

/** Session dedupe across remounts (e.g. React StrictMode) and parallel polls. */
const processedIdsGlobal = new Set();
let pollInFlight = false;

const NOTIF_SESSION_BASELINE_MS_KEY = 'wib_dashboard_notif_baseline_ms';
const CRITICAL_TOAST_TYPES = new Set(['ready_pickup']);
const FIRST_POLL_CRITICAL_WINDOW_MS = 120000;

function hasActorName(notification) {
  const msg = notification?.message != null ? String(notification.message) : '';
  return Boolean(parseActorFromNotificationMessage(msg));
}

function notificationEventMs(n) {
  const iso = n?.activityAt || n?.createdAt;
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function dedupeNotificationsPreferActor(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const kept = new Map();
  for (const n of list) {
    if (!n || n.id == null) continue;
    const key = buildNotificationDedupeKey(n);
    const prev = kept.get(key);
    if (!prev) {
      kept.set(key, n);
      continue;
    }
    const pickCurrent =
      (hasActorName(n) && !hasActorName(prev)) || notificationEventMs(n) > notificationEventMs(prev);
    if (pickCurrent) kept.set(key, n);
  }
  return Array.from(kept.values());
}

/** Short beep when <audio> play() is blocked (common in background tabs). */
function playWebAudioChime() {
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
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.24);
    setTimeout(() => ctx.close().catch(() => {}), 450);
  } catch (_) {
    /* ignore */
  }
}

/**
 * One OS notification per item so every alert gets a visible popup when the tab is in the background.
 */
function showDesktopNotificationsForEach(fresh) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!Array.isArray(fresh) || fresh.length === 0) return;
  for (let i = 0; i < fresh.length; i++) {
    const n = fresh[i];
    try {
      const title = (n.title || 'WIB Riders').toString().trim() || 'WIB Riders';
      const body = (n.message || '').toString().trim() || 'New notification';
      new Notification(title, {
        body,
        silent: false,
        tag: `wib-rider-${String(n.id)}`,
      });
    } catch (_) {
      /* ignore */
    }
  }
}

function showDesktopNotificationSummary(fresh) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!Array.isArray(fresh) || fresh.length === 0) return;
  const n = fresh[0];
  const count = fresh.length;
  const title = count === 1 ? (n.title || 'WIB Riders').toString().trim() || 'WIB Riders' : 'WIB Riders';
  const body =
    count === 1
      ? ((n.message || '').toString().trim() || 'New notification')
      : `${count} new notifications. Open the dashboard to view.`;
  try {
    new Notification(title, {
      body,
      silent: false,
      tag: count === 1 ? `wib-rider-${String(n.id)}` : 'wib-rider-summary',
    });
  } catch (_) {
    /* ignore */
  }
}

function requestDesktopNotifyPermissionOnce() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  try {
    void Notification.requestPermission();
  } catch (_) {
    /* ignore */
  }
}

export function isSoundOn() {
  try {
    const v = localStorage.getItem(DRV_SOUND_KEY);
    if (v === '2') return false;
    if (v === '1') return true;
    return true;
  } catch {
    return true;
  }
}

export function setSoundPreference(on) {
  try {
    localStorage.setItem(DRV_SOUND_KEY, on ? '1' : '2');
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('drv-sound-pref-changed', { detail: { on } }));
  } catch {
    /* ignore */
  }
}

/**
 * Polls rider notifications: toast + optional OS notification per item, staggered sound per item, then mark viewed.
 */
export function useNotifications() {
  const [items, setItems] = useState([]);
  const [pollError, setPollError] = useState(null);
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const pollErrorLoggedRef = useRef(false);
  const firstPollDoneRef = useRef(false);
  const baselineMsRef = useRef(null);

  const emitToastSoundAndDesktop = useCallback((fresh) => {
    if (!Array.isArray(fresh) || fresh.length === 0) return;
    const toastFresh = fresh.filter((n) => !shouldSuppressRiderNotificationToast(n));

    if (toastFresh.length === 1) {
      const n = toastFresh[0];
      const title = (n.title || 'Notification').toString();
      const message = (n.message || '').toString().trim();
      const actor = message ? parseActorFromNotificationMessage(message) : '';
      const messageMain = message ? formatNotificationMessageForDisplay(message) : '';
      const body = createElement(
        'div',
        { className: 'rider-notif-toast-stacked' },
        createElement('div', { className: 'rider-notif-toast-line1' }, title),
        actor ? createElement('div', { className: 'rider-notif-toast-line-by' }, `By ${actor}`) : null,
        messageMain ? createElement('div', { className: 'rider-notif-toast-line2' }, messageMain) : null
      );
      toast.info(body, {
        toastId: `rider-notif-${n.id}`,
        autoClose: 12500,
        className: 'rider-notif-toast',
        bodyClassName: 'rider-notif-toast-body',
        progressClassName: 'rider-notif-toast-progress',
        pauseOnHover: true,
      });
    } else if (toastFresh.length > 1) {
      const count = toastFresh.length;
      const first = toastFresh[0];
      const t1 = (first?.title || 'Notification').toString();
      const m1 = (first?.message || '').toString().trim();
      const actor1 = m1 ? parseActorFromNotificationMessage(m1) : '';
      const msg1 = m1 ? formatNotificationMessageForDisplay(m1) : '';
      const body = createElement(
        'div',
        { className: 'rider-notif-toast-stacked' },
        createElement('div', { className: 'rider-notif-toast-line1' }, `${count} new notifications`),
        actor1 ? createElement('div', { className: 'rider-notif-toast-line-by' }, `Latest: By ${actor1}`) : null,
        createElement('div', { className: 'rider-notif-toast-line2' }, `${t1}${msg1 ? ` — ${msg1}` : ''}`)
      );
      toast.info(body, {
        toastId: `rider-notif-batch-${String(toastFresh[0]?.id ?? 'x')}`,
        autoClose: 12500,
        className: 'rider-notif-toast',
        bodyClassName: 'rider-notif-toast-body',
        progressClassName: 'rider-notif-toast-progress',
        pauseOnHover: true,
      });
    }

    if (toastFresh.length > 0) {
      const hasCritical = toastFresh.some((n) =>
        CRITICAL_TOAST_TYPES.has(String(n?.type || '').trim().toLowerCase())
      );
      if (hasCritical) showDesktopNotificationsForEach(toastFresh);
      else showDesktopNotificationSummary(toastFresh);
    }

    if (toastFresh.length > 0 && isSoundOn()) {
      const tabHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const playOne = async () => {
        if (!tabHidden && audioRef.current) {
          const el = audioRef.current;
          try {
            el.volume = 0.72;
            el.currentTime = 0;
            await el.play();
            return;
          } catch {
            /* fall through to chime */
          }
        }
        playWebAudioChime();
      };
      void playOne();
    }
  }, []);

  /** Bell badge: items not yet acknowledged (panel opened) or cleared. */
  const unreadCount = useMemo(() => items.filter((i) => i && !i.localRead).length, [items]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const a = new Audio(alertSoundUrl);
    a.preload = 'auto';
    a.volume = 0.62;
    audioRef.current = a;
    return () => {
      audioRef.current = null;
    };
  }, []);

  /** Call when the user opens the notification panel — counts as “seen” for the badge. */
  const acknowledgePanelOpen = useCallback(() => {
    setItems((prev) => prev.map((p) => ({ ...p, localRead: true })));
  }, []);

  /** Browsers often block autoplay; a click on the bell counts as a gesture so later poll sounds can play. */
  const primeNotificationSound = useCallback(() => {
    requestDesktopNotifyPermissionOnce();
    if (!isSoundOn() || !audioRef.current) return;
    const el = audioRef.current;
    try {
      el.volume = 0.001;
      el.play()
        .then(() => {
          el.pause();
          el.currentTime = 0;
          el.volume = 0.62;
        })
        .catch(() => {
          el.volume = 0.62;
        });
    } catch {
      try {
        el.volume = 0.62;
      } catch {
        /* ignore */
      }
    }
  }, []);

  /** Unlock audio + offer desktop notifications (OS alert/sound when tab is in background). */
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const unlock = () => {
      primeNotificationSound();
      requestDesktopNotifyPermissionOnce();
    };
    document.addEventListener('pointerdown', unlock, { capture: true, passive: true, once: true });
    document.addEventListener('touchstart', unlock, { capture: true, passive: true, once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock, { capture: true });
      document.removeEventListener('touchstart', unlock, { capture: true });
    };
  }, [primeNotificationSound]);

  const pollTick = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated()) {
      processedIdsGlobal.clear();
      setItems([]);
      setPollError(null);
      pollErrorLoggedRef.current = false;
      firstPollDoneRef.current = false;
      baselineMsRef.current = null;
      try {
        sessionStorage.removeItem(NOTIF_SESSION_BASELINE_MS_KEY);
      } catch (_) {
        /* ignore */
      }
      return;
    }

    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const data = await fetchRiderNotifications();
      setPollError(null);
      pollErrorLoggedRef.current = false;
      const list = Array.isArray(data.notifications) ? data.notifications : [];
      const rawNew = list.filter((n) => n && n.id != null && !processedIdsGlobal.has(String(n.id)));
      const freshAll = dedupeNotificationsPreferActor(rawNew);

      // Option 1: baseline on first load so reopening the site doesn't flood toasts/OS notifications.
      if (!firstPollDoneRef.current) {
        firstPollDoneRef.current = true;
        let baseline = Date.now();
        try {
          const fromStore = parseInt(sessionStorage.getItem(NOTIF_SESSION_BASELINE_MS_KEY) || '0', 10);
          if (Number.isFinite(fromStore) && fromStore > 0) baseline = fromStore;
          else sessionStorage.setItem(NOTIF_SESSION_BASELINE_MS_KEY, String(baseline));
        } catch (_) {
          /* ignore */
        }
        baselineMsRef.current = baseline;
        const firstPollCritical = dedupeNotificationsPreferActor(
          list.filter((n) => {
            const t = String(n?.type || '').trim().toLowerCase();
            if (!CRITICAL_TOAST_TYPES.has(t)) return false;
            const eventMs = notificationEventMs(n);
            return eventMs > 0 && Date.now() - eventMs <= FIRST_POLL_CRITICAL_WINDOW_MS;
          })
        );
        if (firstPollCritical.length > 0) {
          emitToastSoundAndDesktop(firstPollCritical);
          try {
            await markRiderNotificationsViewed(firstPollCritical.map((n) => String(n.id)));
          } catch (_) {
            /* ignore */
          }
          for (const n of firstPollCritical) processedIdsGlobal.add(String(n.id));
        }
        // Mark existing backlog as "seen for this session" (but DO NOT mark viewed in DB).
        for (const n of list) {
          if (n && n.id != null) processedIdsGlobal.add(String(n.id));
        }
        return;
      }

      if (freshAll.length === 0) return;

      // Only popup items created after baseline.
      const baselineMs =
        baselineMsRef.current != null
          ? Number(baselineMsRef.current)
          : (() => {
              try {
                const fromStore = parseInt(sessionStorage.getItem(NOTIF_SESSION_BASELINE_MS_KEY) || '0', 10);
                return Number.isFinite(fromStore) && fromStore > 0 ? fromStore : Date.now();
              } catch (_) {
                return Date.now();
              }
            })();

      const fresh = freshAll.filter((n) => {
        const d = n?.createdAt ? new Date(n.createdAt) : null;
        const ms = d && !Number.isNaN(d.getTime()) ? d.getTime() : Date.now();
        return ms >= baselineMs;
      });
      if (fresh.length === 0) {
        for (const n of rawNew) processedIdsGlobal.add(String(n.id));
        return;
      }

      emitToastSoundAndDesktop(fresh);

      const markViewedIds = notificationIdsSharingDedupeKeysWith(fresh, rawNew);
      await markRiderNotificationsViewed(markViewedIds);
      for (const n of rawNew) processedIdsGlobal.add(String(n.id));

      setItems((prev) => {
        const byId = new Map(prev.map((p) => [String(p.id), { ...p }]));
        for (const n of fresh) byId.set(String(n.id), { ...n, localRead: false });
        const merged = Array.from(byId.values()).sort((a, b) => notificationEventMs(b) - notificationEventMs(a));
        return dedupeNotificationsPreferActor(merged);
      });
    } catch (err) {
      const msg =
        err && typeof err === 'object' && typeof err.message === 'string'
          ? err.message
          : 'Could not load notifications.';
      setPollError(msg);
      if (!pollErrorLoggedRef.current) {
        pollErrorLoggedRef.current = true;
        console.warn('[rider-notifications]', msg);
      }
    } finally {
      pollInFlight = false;
    }
  }, [emitToastSoundAndDesktop]);

  useEffect(() => {
    if (!isAuthenticated()) return undefined;

    const pollMs = () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;

    let intervalId = setInterval(() => {
      pollTick();
    }, pollMs());

    const onVis = () => {
      clearInterval(intervalId);
      intervalId = setInterval(() => {
        pollTick();
      }, pollMs());
      if (document.visibilityState === 'visible') pollTick();
    };

    document.addEventListener('visibilitychange', onVis);
    pollTick();

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [pollTick]);

  useEffect(() => {
    let delayTimer;
    const onPoll = (e) => {
      if (delayTimer) clearTimeout(delayTimer);
      const delayMs =
        e && e.detail && typeof e.detail.delayMs === 'number' && Number.isFinite(e.detail.delayMs)
          ? Math.max(0, e.detail.delayMs)
          : 400;
      delayTimer = window.setTimeout(() => {
        delayTimer = null;
        pollTick();
      }, delayMs);
    };
    window.addEventListener(RIDER_NOTIFICATIONS_POLL_EVENT, onPoll);
    return () => {
      if (delayTimer) clearTimeout(delayTimer);
      window.removeEventListener(RIDER_NOTIFICATIONS_POLL_EVENT, onPoll);
    };
  }, [pollTick]);

  const markAllRead = useCallback(async () => {
    const ids = items.map((i) => String(i.id)).filter(Boolean);
    if (ids.length) {
      try {
        await markRiderNotificationsViewed(ids);
        ids.forEach((id) => processedIdsGlobal.add(id));
      } catch {
        /* still clear session list */
      }
    }
    setItems([]);
  }, [items]);

  return {
    items,
    unreadCount,
    pollError,
    acknowledgePanelOpen,
    markAllRead,
    pollNow: pollTick,
    primeNotificationSound,
  };
}
