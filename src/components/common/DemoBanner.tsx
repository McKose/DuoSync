import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Pressable, Text } from 'react-native';
import { IS_DEMO } from '@/demo/config';
import type { RootStackParamList } from '@/navigation/types';

/** Persistent strip in demo mode: makes the fake backend impossible to miss. */
export function DemoBanner() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  if (!IS_DEMO) return null;
  return (
    <Pressable
      onPress={() => nav.navigate('DemoPanel')}
      accessibilityRole="button"
      accessibilityLabel="Demo modu. Kontrol panelini aç."
      className="flex-row items-center justify-center bg-ink px-4 py-1.5 active:opacity-80"
    >
      <Text className="text-xs font-semibold text-paper">
        🧪 DEMO · veritabanı yok · <Text className="underline">Kontrol paneli ›</Text>
      </Text>
    </Pressable>
  );
}
