import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';

const subscribe = (cb: () => void) => onlineManager.subscribe(cb);
const getOnline = () => onlineManager.isOnline();

/**
 * Shown while offline; queued changes sync on reconnect. Reads React Query's
 * onlineManager (fed by NetInfo, or by the demo panel in demo mode) so the
 * banner always agrees with whether mutations are actually paused.
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(subscribe, getOnline);
  if (online) return null;
  return (
    <View className="bg-amber-soft px-4 py-2" accessibilityRole="alert">
      <Text className="text-center text-xs font-semibold text-ink">
        Çevrimdışısın — değişiklikler bağlantı gelince senkronlanacak.
      </Text>
    </View>
  );
}
