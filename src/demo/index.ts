import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import { AppState } from 'react-native';
import { createDemoBackend } from './engine';

export { IS_DEMO } from './config';
export { DEMO_PARTNER_NAME } from './engine';
export type { DemoSettings, DemoTable } from './engine';

/** The app-wide demo backend instance (only ever used when IS_DEMO). */
export const demo = createDemoBackend({
  storage: AsyncStorage,
  uuid: () => Crypto.randomUUID(),
});

/**
 * The store only reads `session.user.id`; build the minimal Session shape the
 * real auth flow would hand it, so nothing downstream needs a demo branch.
 */
export function toDemoSession(s: { userId: string; email: string } | null): Session | null {
  if (!s) return null;
  return {
    access_token: 'demo',
    refresh_token: 'demo',
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: s.userId, email: s.email, app_metadata: {}, user_metadata: {}, aud: 'demo', created_at: '' },
  } as Session;
}

let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * Drives the simulated server clock (message release, 24h sweep, partner
 * reactions) once per second while the app is in the foreground. Demo only —
 * the real app has no client-side polling.
 */
export function startDemoTicker(): () => void {
  const start = () => {
    if (!ticker) ticker = setInterval(() => void demo.tick(), 1000);
  };
  const stop = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };
  start();
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') {
      void demo.tick(); // catch up on everything that fell due in the background
      start();
    } else {
      stop();
    }
  });
  return () => {
    sub.remove();
    stop();
  };
}
