import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Ticking clock for countdowns. Re-syncs immediately on foreground because JS
 * timers are suspended in the background (a countdown must not resume from a
 * stale value). Pass enabled=false to stop ticking when nothing is counting.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    // Async first tick: re-enabling must not show a stale value for a whole
    // interval, but a synchronous setState in an effect cascades renders.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setNow(Date.now());
    });
    return () => {
      clearTimeout(first);
      clearInterval(id);
      sub.remove();
    };
  }, [intervalMs, enabled]);

  return now;
}
