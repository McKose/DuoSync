import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import type { Database } from '@/types/database.types';

import { IS_DEMO } from '@/demo/config';
import { secureStorage } from '@/lib/secureStorage';

// In demo mode (no env, or EXPO_PUBLIC_DEMO_MODE=1) every api/ function is
// routed to the on-device demo backend, so this client is never used. It is
// still constructed — pointed at an unroutable host — so imports stay valid.
const SUPABASE_URL = IS_DEMO ? 'https://demo.invalid' : process.env.EXPO_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = IS_DEMO ? 'demo-mode-no-key' : process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Session encrypted in AsyncStorage with a key held in SecureStore (B4):
    // the session itself exceeds SecureStore's 2 KB per-item limit on iOS.
    storage: secureStorage,
    autoRefreshToken: !IS_DEMO,
    // Demo: never touch the real auth storage key.
    persistSession: !IS_DEMO,
    detectSessionInUrl: false,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});

// Refresh tokens only while foregrounded; RN timers are unreliable in the
// background and a stale refresh loop wastes battery.
if (Platform.OS !== 'web' && !IS_DEMO) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
