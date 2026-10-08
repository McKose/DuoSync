import { Text, View } from 'react-native';
import { formatRelative } from '@/lib/time';
import type { PartnerStatus } from '@/types/database.types';

export const STATUS_META: Record<PartnerStatus, { label: string; emoji: string; tone: string }> = {
  NORMAL: { label: 'Müsait', emoji: '🙂', tone: 'bg-sage-soft' },
  BUSY: { label: 'Meşgul', emoji: '⏳', tone: 'bg-amber-soft' },
  LOW_BATTERY: { label: 'Şarjı azalıyor', emoji: '🪫', tone: 'bg-danger-soft' },
  FRAGILE: { label: 'Hassas — nazik ol', emoji: '🫧', tone: 'bg-rose-soft' },
};

function batteryEmoji(level: number | null) {
  if (level === null) return '🔋';
  return level <= 15 ? '🪫' : '🔋';
}

interface Props {
  name: string;
  battery: number | null;
  status: PartnerStatus;
  seenAt: string | null;
  now: number;
}

/**
 * Passive snapshot — values are only as fresh as the partner's last app
 * foreground, so "last seen" is always shown next to the battery reading.
 */
export function PartnerStatusCard({ name, battery, status, seenAt, now }: Props) {
  const meta = STATUS_META[status];
  const stale = !seenAt || now - new Date(seenAt).getTime() > 6 * 3600 * 1000;
  return (
    <View
      className={`mb-3 rounded-xl2 p-4 ${meta.tone}`}
      accessible
      accessibilityLabel={`${name}: ${meta.label}, pil ${battery ?? 'bilinmiyor'}, son görülme ${formatRelative(seenAt, now)}`}
    >
      <Text className="text-xs font-bold uppercase tracking-wider text-ink-mute">Partnerin</Text>
      <View className="mt-1 flex-row items-center justify-between">
        <Text className="text-2xl font-bold text-ink">
          {meta.emoji} {name}
        </Text>
        <Text className={`text-lg font-semibold ${stale ? 'text-ink-mute' : 'text-ink'}`}>
          {batteryEmoji(battery)} {battery === null ? '—' : `%${battery}`}
        </Text>
      </View>
      <Text className="mt-1 text-sm text-ink-soft">
        {meta.label} · {stale ? 'uzun süredir uygulamayı açmadı' : `son görülme ${formatRelative(seenAt, now)}`}
      </Text>
    </View>
  );
}
