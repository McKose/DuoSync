import { Pressable, Text, View } from 'react-native';
import { parseChecklist, visibleItems } from '@/api/plans';
import { formatPlanDate } from '@/lib/time';
import type { Plan } from '@/types/database.types';

export function PlanCard({ plan, onPress }: { plan: Plan; onPress: () => void }) {
  const items = visibleItems(parseChecklist(plan.checklist));
  const done = items.filter((i) => i.done).length;
  const progress = items.length ? done / items.length : 0;

  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="mb-3 rounded-xl2 bg-paper-raised p-4 active:opacity-80">
      <Text className="text-base font-semibold text-ink" numberOfLines={1}>
        {plan.title}
      </Text>
      <Text className="mt-1 text-xs text-ink-mute" numberOfLines={1}>
        🗓️ {formatPlanDate(plan.plan_date)}
        {plan.location ? ` · 📍 ${plan.location}` : ''}
      </Text>
      {items.length > 0 ? (
        <View className="mt-3">
          <View className="h-1.5 overflow-hidden rounded-full bg-paper-sunk">
            <View className="h-full bg-sage" style={{ width: `${Math.round(progress * 100)}%` }} />
          </View>
          <Text className="mt-1 text-xs text-ink-mute">
            {done}/{items.length} tamamlandı
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
