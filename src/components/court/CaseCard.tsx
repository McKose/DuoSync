import { Pressable, Text, View } from 'react-native';
import { CATEGORY_META, casePhase, type CasePhase } from '@/api/court';
import { formatCountdown, formatRelative } from '@/lib/time';
import { CASE_CATEGORIES, type CaseCategory, type CourtCase } from '@/types/database.types';

const PHASE: Record<CasePhase, { label: string; cls: string }> = {
  AWAITING_DEFENSE: { label: 'Savunma bekleniyor', cls: 'bg-amber-soft text-amber' },
  DEFENSE_OVERDUE: { label: 'Süre doldu', cls: 'bg-amber-soft text-amber' },
  AWAITING_VERDICT: { label: 'Karar bekleniyor', cls: 'bg-court-soft text-court' },
  DELIBERATING: { label: 'Heyet müzakerede', cls: 'bg-court-soft text-court' },
  JUDGED: { label: 'Karara bağlandı', cls: 'bg-sage-soft text-sage' },
  APPEALED: { label: 'İstinafta', cls: 'bg-paper-sunk text-ink-soft' },
};

export function PhaseBadge({ phase }: { phase: CasePhase }) {
  const p = PHASE[phase];
  const [bg, fg] = p.cls.split(' ');
  return (
    <View className={`self-start rounded-full px-2.5 py-1 ${bg}`}>
      <Text className={`text-xs font-semibold ${fg}`}>{p.label}</Text>
    </View>
  );
}

export function categoryMeta(category: string) {
  return (CASE_CATEGORIES as readonly string[]).includes(category)
    ? CATEGORY_META[category as CaseCategory]
    : CATEGORY_META.OTHER;
}

interface Props {
  item: CourtCase;
  userId: string;
  now: number;
  onPress: () => void;
}

export function CaseCard({ item, userId, now, onPress }: Props) {
  const phase = casePhase(item, now);
  const meta = categoryMeta(item.category);
  const iAmDefendant = item.defendant_id === userId;
  const needsMyDefense = phase === 'AWAITING_DEFENSE' && iAmDefendant;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={`mb-3 rounded-xl2 bg-paper-raised p-4 active:opacity-80 ${needsMyDefense ? 'border-2 border-amber' : ''}`}
    >
      <View className="flex-row items-start justify-between">
        <Text className="mr-3 flex-1 text-base font-semibold text-ink" numberOfLines={2}>
          {meta.emoji} {item.title}
        </Text>
        <PhaseBadge phase={phase} />
      </View>
      <Text className="mt-2 text-xs text-ink-mute">
        {iAmDefendant ? 'Davalı sensin' : 'Davacı sensin'} · {meta.label} · {formatRelative(item.created_at, now)}
      </Text>
      {needsMyDefense ? (
        <Text className="mt-2 text-sm font-semibold text-amber">
          Savunman için kalan süre: {formatCountdown(new Date(item.defense_deadline).getTime() - now)}
        </Text>
      ) : null}
      {phase === 'JUDGED' && item.fault_ratio_prosecutor !== null ? (
        <Text className="mt-2 text-sm text-ink-soft">
          Kusur · Davacı %{item.fault_ratio_prosecutor} — Davalı %{item.fault_ratio_defendant}
        </Text>
      ) : null}
    </Pressable>
  );
}
