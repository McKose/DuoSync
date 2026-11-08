import NetInfo from '@react-native-community/netinfo';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import { demo, IS_DEMO } from '@/demo';
import { isNetworkError } from '@/lib/errors';
import { secureStorage } from '@/lib/secureStorage';
import type { ChecklistItem, Plan } from '@/types/database.types';
import { mk } from './keys';
import { upsertChecklistItem } from './plans';

// --- Online detection: pause queries/mutations while offline ---------------
if (IS_DEMO) {
  // Demo: connectivity is whatever the demo panel's "offline" switch says, so
  // paused/queued mutations can be tested on a phone that is actually online.
  onlineManager.setEventListener((setOnline) => {
    const sync = () => void demo.panel.getSettings().then((s) => setOnline(!s.offline));
    sync();
    return demo.subscribe('settings', sync);
  });
} else {
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      // isInternetReachable is null while unknown; treat unknown as online.
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    }),
  );
}

// --- Focus: refetch stale queries when the app returns to foreground -------
if (Platform.OS !== 'web') {
  focusManager.setEventListener((handleFocus) => {
    const sub = AppState.addEventListener('change', (s) => handleFocus(s === 'active'));
    return () => sub.remove();
  });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60 * 1000, // must be ≥ persister maxAge
      retry: (count, err) => isNetworkError(err) && count < 3,
      retryDelay: (n) => Math.min(1000 * 2 ** n, 15_000),
    },
    mutations: {
      // networkMode 'online' (default): offline mutations are *paused*, kept
      // in the cache, persisted, and resumed when connectivity returns.
      retry: (count, err) => isNetworkError(err) && count < 3,
    },
  },
});

// Checklist mutations must be resumable after an app restart, when the
// component that created them no longer exists — so the mutationFn is
// registered as a default keyed by mutationKey.
export interface ChecklistMutationVars {
  planId: string;
  item: ChecklistItem;
}
queryClient.setMutationDefaults(mk.checklistUpsert, {
  mutationFn: ({ planId, item }: ChecklistMutationVars): Promise<Plan> => upsertChecklistItem(planId, item),
});

// The cache holds pleas, verdicts, delivered messages and answers: encrypted
// at rest like the session (B4). An unreadable cache is dropped and refetched.
export const persister = createAsyncStoragePersister({
  storage: secureStorage,
  key: 'duosync-query-cache',
  throttleTime: 1000,
});

export const PERSIST_MAX_AGE = 24 * 60 * 60 * 1000;
// Separate buster per mode: switching demo ↔ real on one device discards the
// other mode's cached rows instead of rendering them.
export const PERSIST_BUSTER = IS_DEMO ? 'demo-v1' : 'v1';

/**
 * The couple ended (I left or my partner did): its rows are already deleted
 * server-side, so drop every cached copy and queued edit on this device too.
 * The couple query itself stays; it is what just reported the change.
 */
export function dropCoupleData(): void {
  queryClient.getMutationCache().clear();
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'couple' });
}

/** Wipe all cached couple data — call on sign-out (shared-device privacy). */
export async function clearQueryCache(): Promise<void> {
  queryClient.clear();
  await persister.removeClient();
}
