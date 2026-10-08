import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useQuery } from '@tanstack/react-query';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { casePhase, listCases } from '@/api/court';
import { qk } from '@/api/keys';
import { useRealtimeSubscription } from '@/hooks/useRealtimeSubscription';
import { CoolingOffScreen } from '@/screens/buffer/CoolingOffScreen';
import { QuestionsVaultScreen } from '@/screens/buffer/QuestionsVaultScreen';
import { CourtHomeScreen } from '@/screens/court/CourtHomeScreen';
import { DashboardScreen } from '@/screens/dashboard/DashboardScreen';
import { usePairedContext } from '@/store/useCoupleStore';
import type { TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();

const icon = (emoji: string) =>
  function TabIcon({ focused }: { focused: boolean }) {
    // Fixed 22pt box: an unconstrained emoji line box is taller than the icon
    // slot and squeezes the (overflow:hidden) label below it.
    return (
      <Text style={{ fontSize: 18, lineHeight: 22, height: 22, textAlign: 'center', opacity: focused ? 1 : 0.5 }}>
        {emoji}
      </Text>
    );
  };

export function TabNavigator() {
  const { userId, coupleId } = usePairedContext();
  const insets = useSafeAreaInsets();
  // Badge: cases awaiting *my* defense. Shares the cache with CourtHome and
  // stays live app-wide, so a new case lights up the tab from any screen.
  useRealtimeSubscription({
    name: 'court-badge',
    table: 'court_cases',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.cases(coupleId)],
  });
  const cases = useQuery({ queryKey: qk.cases(coupleId), queryFn: () => listCases(coupleId) });
  const needsDefense = (cases.data ?? []).filter(
    (c) => c.defendant_id === userId && casePhase(c) === 'AWAITING_DEFENSE',
  ).length;

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#C8475B',
        tabBarInactiveTintColor: '#8C8994',
        // The library's icon wrapper is a fixed 28pt and items pad 5+5pt, so
        // the label gets (bar height − 38). The default 49pt bar left 10pt for
        // an 11pt label (clipped, overflow:hidden). 58pt leaves 20pt. The
        // bottom inset is re-applied because overriding height drops it.
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopColor: '#F1ECE3',
          height: 58 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarLabelStyle: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
      }}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} options={{ title: 'Masa', tabBarIcon: icon('🍽️') }} />
      <Tab.Screen
        name="CourtHome"
        component={CourtHomeScreen}
        options={{
          title: 'Mahkeme',
          tabBarIcon: icon('⚖️'),
          tabBarBadge: needsDefense > 0 ? needsDefense : undefined,
        }}
      />
      <Tab.Screen name="CoolingOff" component={CoolingOffScreen} options={{ title: 'Soğuma', tabBarIcon: icon('🧊') }} />
      <Tab.Screen name="QuestionsVault" component={QuestionsVaultScreen} options={{ title: 'Kasa', tabBarIcon: icon('🗝️') }} />
    </Tab.Navigator>
  );
}
