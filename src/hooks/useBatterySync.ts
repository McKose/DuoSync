import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Battery from 'expo-battery';
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { updatePresence } from '@/api/couple';
import { qk } from '@/api/keys';

/** Skip a sync if the last one was this recent AND battery moved < MIN_DELTA. */
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const MIN_DELTA = 5;

async function readBatteryPercent(): Promise<number | null> {
  try {
    const raw = await Battery.getBatteryLevelAsync();
    // -1 on simulators / unsupported devices.
    return raw >= 0 && raw <= 1 ? Math.round(raw * 100) : null;
  } catch {
    return null;
  }
}

/**
 * Passive battery sync.
 *
 * - NO background task, NO battery-level listener, NO polling.
 * - Reads the level once on mount (app launched → foreground) and once per
 *   background/inactive → active transition, then fires a silent RPC.
 * - Throttled so rapid app switching doesn't spam the partner's Realtime feed.
 * - Failures are swallowed: presence is best-effort and must never surface UI.
 */
export function useBatterySync(userId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const lastSent = useRef<{ at: number; level: number | null } | null>(null);

  const { mutate } = useMutation({
    mutationFn: (battery: number | null) => updatePresence({ battery }),
    retry: false,
    onSuccess: (couple) => {
      if (userId) queryClient.setQueryData(qk.couple(userId), couple);
    },
  });

  const sync = useCallback(async () => {
    const level = await readBatteryPercent();
    const prev = lastSent.current;
    const now = Date.now();
    if (
      prev &&
      now - prev.at < MIN_INTERVAL_MS &&
      (level === null || prev.level === null || Math.abs(level - prev.level) < MIN_DELTA)
    ) {
      return;
    }
    lastSent.current = { at: now, level };
    mutate(level, {
      onError: (err) => {
        lastSent.current = prev; // allow the next foreground to retry
        if (__DEV__) console.warn('[battery-sync] failed silently:', err);
      },
    });
  }, [mutate]);

  useEffect(() => {
    if (!enabled || !userId) return;
    void sync();
    const sub = AppState.addEventListener('change', (next) => {
      if (/inactive|background/.test(appState.current) && next === 'active') void sync();
      appState.current = next;
    });
    return () => sub.remove();
  }, [enabled, userId, sync]);
}
