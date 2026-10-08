import '../global.css';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PERSIST_BUSTER, PERSIST_MAX_AGE, persister, queryClient } from '@/api/queryClient';
import { ConfirmHost } from '@/components/common/ConfirmHost';
import { AppNavigator } from '@/navigation/AppNavigator';
import { IS_DEMO, startDemoTicker } from '@/demo';

export default function App() {
  // Demo mode: drive the simulated server clock while foregrounded.
  useEffect(() => (IS_DEMO ? startDemoTicker() : undefined), []);

  return (
    <SafeAreaProvider>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, maxAge: PERSIST_MAX_AGE, buster: PERSIST_BUSTER }}
        onSuccess={() => {
          // Replay checklist changes queued while offline / before a restart.
          void queryClient.resumePausedMutations().then(() => queryClient.invalidateQueries());
        }}
      >
        <StatusBar style="dark" />
        <AppNavigator />
        <ConfirmHost />
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}
