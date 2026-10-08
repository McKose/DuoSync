import { Alert, Platform } from 'react-native';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

/**
 * Cross-platform confirmation. react-native-web's Alert.alert is a no-op,
 * so on web we fall back to window.confirm.
 */
export function confirmAction({ title, message, confirmLabel, cancelLabel = 'Vazgeç', destructive, onConfirm }: ConfirmOptions) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
  ]);
}
