import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text, View } from 'react-native';
import { AppButton } from '@/components/common/AppButton';
import { ErrorBanner, LoadingView } from '@/components/common/StateViews';
import { useBatterySync } from '@/hooks/useBatterySync';
import { useCoupleSession } from '@/hooks/useCoupleSession';
import { usePushRegistration } from '@/hooks/usePushRegistration';
import { signOut } from '@/api/auth';
import { LoginScreen } from '@/screens/auth/LoginScreen';
import { PairingScreen } from '@/screens/auth/PairingScreen';
import { NewCaseScreen } from '@/screens/court/NewCaseScreen';
import { VerdictScreen } from '@/screens/court/VerdictScreen';
import { PlanDetailScreen } from '@/screens/dashboard/PlanDetailScreen';
import { navigationRef } from './navigationRef';
import { TabNavigator } from './TabNavigator';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: '#FBF8F3', primary: '#C8475B', card: '#FBF8F3', text: '#1B1A1F' },
};

function SessionError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <View className="flex-1 justify-center bg-paper p-6">
      <Text className="mb-4 text-2xl font-bold text-ink">Bağlanamadık</Text>
      <ErrorBanner error={error} onRetry={onRetry} />
      <AppButton label="Çıkış yap" variant="ghost" onPress={() => void signOut()} />
    </View>
  );
}

export function AppNavigator() {
  const session = useCoupleSession();
  const paired = session.status === 'paired';

  // Passive battery sync + push registration only for paired users.
  useBatterySync(session.userId, paired);
  usePushRegistration(session.userId, paired);

  if (session.status === 'loading') return <LoadingView />;
  if (session.status === 'error') return <SessionError error={session.error} onRetry={session.retry} />;

  return (
    <NavigationContainer ref={navigationRef} theme={theme}>
      <Stack.Navigator
        screenOptions={{
          headerTintColor: '#1B1A1F',
          headerShadowVisible: false,
          headerStyle: { backgroundColor: '#FBF8F3' },
          headerBackTitle: 'Geri',
        }}
      >
        {session.status === 'signed_out' ? (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        ) : session.status === 'unpaired' ? (
          <Stack.Screen name="Pairing" component={PairingScreen} options={{ headerShown: false }} />
        ) : (
          <>
            <Stack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
            <Stack.Screen name="PlanDetail" component={PlanDetailScreen} options={{ title: 'Plan' }} />
            <Stack.Screen name="NewCase" component={NewCaseScreen} options={{ title: 'Yeni dava', presentation: 'modal' }} />
            <Stack.Screen name="Verdict" component={VerdictScreen} options={{ title: 'Dava dosyası' }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
