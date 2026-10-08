import { Text, View } from 'react-native';
import { AppButton } from '@/components/common/AppButton';
import { formatCountdown } from '@/lib/time';
import type { DelayedMessage } from '@/types/database.types';

interface Props {
  message: DelayedMessage;
  now: number;
  cancelling: boolean;
  onCancel: () => void;
}

/** Local countdown; the server clock (release_at) is authoritative. */
export function PendingMessageCard({ message, now, cancelling, onCancel }: Props) {
  const releaseAt = new Date(message.release_at).getTime();
  const created = new Date(message.created_at).getTime();
  const remaining = releaseAt - now;
  const progress = Math.min(1, Math.max(0, (now - created) / (releaseAt - created)));
  const releasing = remaining <= 0;

  return (
    <View className="mb-3 rounded-xl2 bg-paper-raised p-4">
      <Text className="text-base leading-6 text-ink" numberOfLines={4}>
        {message.content}
      </Text>
      <View className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper-sunk">
        <View className="h-full bg-rose" style={{ width: `${Math.round(progress * 100)}%` }} />
      </View>
      <View className="mt-3 flex-row items-center justify-between">
        <Text
          className="text-sm font-semibold text-rose"
          accessibilityLiveRegion="polite"
          accessibilityLabel={releasing ? 'Gönderiliyor' : `Gönderilmesine ${formatCountdown(remaining)} kaldı`}
        >
          {releasing ? 'Gönderiliyor…' : `⏳ ${formatCountdown(remaining)}`}
        </Text>
        {!releasing ? (
          <AppButton label="Vazgeç, gönderme" variant="secondary" size="sm" loading={cancelling} onPress={onCancel} />
        ) : null}
      </View>
    </View>
  );
}
