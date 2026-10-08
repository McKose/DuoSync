import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { savePushToken } from '@/api/couple';
import { navigationRef } from '@/navigation/navigationRef';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function resolveProjectId(): string | undefined {
  const fromEnv = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return fromEnv || extra?.eas?.projectId || Constants.easConfig?.projectId;
}

async function registerForPush(userId: string): Promise<void> {
  if (!Device.isDevice) return; // simulators cannot receive remote push

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'DuoSync',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#C8475B',
    });
  }

  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted && current.canAskAgain) {
    granted = (await Notifications.requestPermissionsAsync()).granted;
  }
  if (!granted) return;

  const projectId = resolveProjectId();
  if (!projectId) {
    if (__DEV__) console.warn('[push] EXPO_PUBLIC_EAS_PROJECT_ID missing; push disabled');
    return;
  }
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await savePushToken(userId, token);
}

// A tap can arrive before the NavigationContainer is ready (cold start, or
// the paired stack mounting in the same commit). Park it and replay onReady.
let pendingRoute: Record<string, unknown> | null = null;
// The OS keeps returning the last response until the app is killed; remember
// which one we've handled so re-login / re-mount doesn't navigate again.
let lastHandledId: string | null = null;

/** Call from NavigationContainer onReady. */
export function flushPendingNotificationRoute() {
  if (!pendingRoute) return;
  const data = pendingRoute;
  pendingRoute = null;
  routeFromNotification(data);
}

function handleResponse(resp: Notifications.NotificationResponse) {
  const id = resp.notification.request.identifier;
  if (id === lastHandledId) return;
  lastHandledId = id;
  routeFromNotification(resp.notification.request.content.data as Record<string, unknown>);
}

function routeFromNotification(data: Record<string, unknown> | undefined) {
  if (!data) return;
  if (!navigationRef.isReady()) {
    pendingRoute = data;
    return;
  }
  const caseId = typeof data.case_id === 'string' ? data.case_id : null;
  switch (data.type) {
    case 'CASE_FILED':
    case 'VERDICT_READY':
      if (caseId) navigationRef.navigate('Verdict', { caseId });
      break;
    case 'MESSAGE_RELEASED':
      navigationRef.navigate('Tabs', { screen: 'CoolingOff' });
      break;
    case 'QUESTION_ASKED':
    case 'QUESTION_ANSWERED':
      navigationRef.navigate('Tabs', { screen: 'QuestionsVault' });
      break;
    default:
      break;
  }
}

/** Registers the device token once paired and routes notification taps. */
export function usePushRegistration(userId: string | null, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !userId) return;
    registerForPush(userId).catch((e) => {
      if (__DEV__) console.warn('[push] registration failed', e);
    });

    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);
    // Cold start from a notification tap.
    const last = Notifications.getLastNotificationResponse();
    if (last) handleResponse(last);

    return () => sub.remove();
  }, [enabled, userId]);
}
