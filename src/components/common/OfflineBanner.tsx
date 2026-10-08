import { useNetInfo } from '@react-native-community/netinfo';
import { Text, View } from 'react-native';

/** Shown while the device is offline; queued changes sync on reconnect. */
export function OfflineBanner() {
  const net = useNetInfo();
  const offline = net.isConnected === false || net.isInternetReachable === false;
  if (!offline) return null;
  return (
    <View className="bg-amber-soft px-4 py-2" accessibilityRole="alert">
      <Text className="text-center text-xs font-semibold text-ink">
        Çevrimdışısın — değişiklikler bağlantı gelince senkronlanacak.
      </Text>
    </View>
  );
}
