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
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setNow(Date.now());
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [intervalMs, enabled]);

  return now;
}
