import { useEffect, useRef } from 'react';

const DEFAULT_INTERVAL_MS = 30000; // 30 seconds

/**
 * Polls the given fetch function while the tab is visible so table data
 * auto-refreshes when the user is on the screen.
 * @param {() => void} fetchFn - Function to call to refresh data (e.g. fetchTasks)
 * @param {number} [intervalMs] - Polling interval in ms (default 30s)
 */
export function useTableAutoRefresh(fetchFn, intervalMs = DEFAULT_INTERVAL_MS) {
  const ref = useRef(fetchFn);
  ref.current = fetchFn;

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') ref.current?.();
    };
    const id = setInterval(tick, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') ref.current?.();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
