import { useState, useEffect, useRef, useCallback, useMemo, createElement } from 'react';
import { toast } from 'react-toastify';
import { isAuthenticated } from '../auth';
import { fetchRiderNotifications, markRiderNotificationsViewed } from '../services/notificationApi';

/** `public/fb-alert.mp3` — Vite serves `public/` at `import.meta.env.BASE_URL`. */
const alertSoundUrl = `${import.meta.env.BASE_URL}fb-alert.mp3`;

/** localStorage: "1" = sound on, "2" = off (default on). */
export const DRV_SOUND_KEY = 'drv_sound_on';

const VISIBLE_POLL_MS = 10_000;
const HIDDEN_POLL_MS = 45_000;

/** Dispatch after actions that create server-side notifications (e.g. new task) so the UI does not wait for the next interval. */
export const RIDER_NOTIFICATIONS_POLL_EVENT = 'wib-dashboard-rider-notifications-poll';

/** Session dedupe across remounts (e.g. React StrictMode) and parallel polls. */
const processedIdsGlobal = new Set();
let pollInFlight = false;

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
 * Polls rider notifications, shows toast + one sound per batch, marks viewed on server.
 */
export function useNotifications() {
  const [items, setItems] = useState([]);
  const [pollError, setPollError] = useState(null);
  const audioRef = useRef(null);
  const mountedRef = useRef(true);
  const pollErrorLoggedRef = useRef(false);

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
    a.volume = 0.35;
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
    if (!isSoundOn() || !audioRef.current) return;
    const el = audioRef.current;
    try {
      el.volume = 0.001;
      el.play()
        .then(() => {
          el.pause();
          el.currentTime = 0;
          el.volume = 0.35;
        })
        .catch(() => {
          el.volume = 0.35;
        });
    } catch {
      try {
        el.volume = 0.35;
      } catch {
        /* ignore */
      }
    }
  }, []);

  const pollTick = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated()) {
      processedIdsGlobal.clear();
      setItems([]);
      setPollError(null);
      pollErrorLoggedRef.current = false;
      return;
    }

    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const data = await fetchRiderNotifications();
      setPollError(null);
      pollErrorLoggedRef.current = false;
      const list = Array.isArray(data.notifications) ? data.notifications : [];
      const fresh = list.filter((n) => n && n.id != null && !processedIdsGlobal.has(String(n.id)));
      if (fresh.length === 0) return;

      for (const n of fresh) {
        const title = (n.title || 'Notification').toString();
        const message = (n.message || '').toString().trim();
        const body = createElement(
          'div',
          { className: 'rider-notif-toast-stacked' },
          createElement('div', { className: 'rider-notif-toast-line1' }, title),
          message
            ? createElement('div', { className: 'rider-notif-toast-line2' }, message)
            : null
        );
        toast.info(body, {
          toastId: `rider-notif-${n.id}`,
          autoClose: 12500,
          className: 'rider-notif-toast',
          bodyClassName: 'rider-notif-toast-body',
          progressClassName: 'rider-notif-toast-progress',
        });
      }

      if (isSoundOn() && audioRef.current) {
        const el = audioRef.current;
        try {
          el.currentTime = 0;
          await el.play();
        } catch {
          /* autoplay / decode */
        }
      }

      await markRiderNotificationsViewed(fresh.map((n) => String(n.id)));
      for (const n of fresh) {
        processedIdsGlobal.add(String(n.id));
      }

      setItems((prev) => {
        const map = new Map(prev.map((p) => [String(p.id), { ...p }]));
        for (const n of fresh) {
          map.set(String(n.id), { ...n, localRead: false });
        }
        return Array.from(map.values()).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
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
  }, []);

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
    const unread = items.filter((i) => !i.localRead);
    if (unread.length === 0) {
      setItems((prev) => prev.map((p) => ({ ...p, localRead: true })));
      return;
    }
    const ids = unread.map((i) => String(i.id));
    try {
      await markRiderNotificationsViewed(ids);
      setItems((prev) => prev.map((p) => (ids.includes(String(p.id)) ? { ...p, localRead: true } : p)));
    } catch {
      /* ignore */
    }
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
