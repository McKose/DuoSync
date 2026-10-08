import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useQuery } from '@tanstack/react-query';
import { Text } from 'react-native';
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
    return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{emoji}</Text>;
  };

export function TabNavigator() {
  const { userId, coupleId } = usePairedContext();
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
        tabBarStyle: { backgroundColor: '#FFFFFF', borderTopColor: '#F1ECE3' },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
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
