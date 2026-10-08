import '../global.css';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PERSIST_BUSTER, PERSIST_MAX_AGE, persister, queryClient } from '@/api/queryClient';
import { AppNavigator } from '@/navigation/AppNavigator';

export default function App() {
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
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}
