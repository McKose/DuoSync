import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { registerConfirmPresenter, type ConfirmOptions } from '@/lib/confirm';
import { AppButton } from './AppButton';

/** In-app confirmation dialog used on web (see lib/confirm.ts). */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmOptions | null>(null);

  useEffect(() => {
    registerConfirmPresenter(setReq);
    return () => registerConfirmPresenter(null);
  }, []);

  const close = () => setReq(null);

  return (
    <Modal visible={req !== null} transparent animationType="fade" onRequestClose={close}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 px-6" onPress={close} accessibilityLabel="Kapat">
        <Pressable
          className="w-full max-w-[360px] rounded-xl2 bg-paper-raised p-5"
          accessibilityRole="alert"
          aria-modal
          onPress={() => undefined}
        >
          <Text className="text-lg font-bold text-ink">{req?.title}</Text>
          <Text className="mt-2 text-sm leading-5 text-ink-soft">{req?.message}</Text>
          <View className="mt-5 flex-row gap-2">
            <AppButton label={req?.cancelLabel ?? 'Vazgeç'} variant="secondary" className="flex-1" onPress={close} />
            <AppButton
              label={req?.confirmLabel ?? 'Tamam'}
              variant={req?.destructive ? 'danger' : 'primary'}
              className="flex-1"
              onPress={() => {
                const r = req;
                close();
                r?.onConfirm();
              }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
