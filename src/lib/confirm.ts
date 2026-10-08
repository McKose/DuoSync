import { Alert, Platform } from 'react-native';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

type Presenter = (opts: ConfirmOptions) => void;
let presenter: Presenter | null = null;

/** Registered by <ConfirmHost/>, mounted once at the app root. */
export function registerConfirmPresenter(p: Presenter | null) {
  presenter = p;
}

/**
 * Cross-platform destructive-action confirmation.
 * - Native: the OS alert.
 * - Web: an in-app modal. react-native-web's Alert.alert is a no-op, and
 *   window.confirm is unavailable in sandboxed frames (it returns false
 *   immediately), which would silently block cancel/delete/reset.
 */
export function confirmAction(opts: ConfirmOptions) {
  if (Platform.OS !== 'web') {
    Alert.alert(opts.title, opts.message, [
      { text: opts.cancelLabel ?? 'Vazgeç', style: 'cancel' },
      { text: opts.confirmLabel, style: opts.destructive ? 'destructive' : 'default', onPress: opts.onConfirm },
    ]);
    return;
  }
  if (presenter) {
    presenter(opts);
    return;
  }
  // Last resort when no host is mounted.
  if (globalThis.confirm?.(`${opts.title}\n\n${opts.message}`)) opts.onConfirm();
}
