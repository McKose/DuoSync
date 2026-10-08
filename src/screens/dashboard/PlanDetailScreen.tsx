import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutationState } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { mk } from '@/api/keys';
import { parseChecklist, visibleItems } from '@/api/plans';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, EmptyState, ErrorBanner, LoadingView, SectionTitle } from '@/components/common/StateViews';
import { ChecklistItemRow } from '@/components/dashboard/ChecklistItemRow';
import { useChecklistUpsert, useDeletePlan, usePlan } from '@/hooks/usePlans';
import { confirmAction } from '@/lib/confirm';
import { formatPlanDate } from '@/lib/time';
import type { RootStackParamList } from '@/navigation/types';
import { usePairedContext } from '@/store/useCoupleStore';

type Props = NativeStackScreenProps<RootStackParamList, 'PlanDetail'>;

export function PlanDetailScreen({ route, navigation }: Props) {
  const { planId } = route.params;
  const { coupleId } = usePairedContext();
  const plan = usePlan(coupleId, planId);
  const checklist = useChecklistUpsert(coupleId, planId);
  const del = useDeletePlan(coupleId);
  const [draft, setDraft] = useState('');

  // Changes waiting for connectivity (paused) for this plan.
  const queued = useMutationState({
    filters: { mutationKey: mk.checklistUpsert, status: 'pending' },
    select: (m) => (m.state.isPaused ? (m.state.variables as { planId: string } | undefined)?.planId : undefined),
  }).filter((id) => id === planId).length;

  if (plan.isPending) return <LoadingView />;
  if (!plan.data) {
    return (
      <Screen insetTop={false}>
        <ErrorBanner error={plan.error} onRetry={() => void plan.refetch()} />
      </Screen>
    );
  }

  const items = visibleItems(parseChecklist(plan.data.checklist));
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  const addItem = () => {
    const text = draft.trim();
    if (!text) return;
    checklist.add(text);
    setDraft('');
  };

  const confirmDelete = () =>
    confirmAction({
      title: 'Planı sil',
      message: 'Bu plan ikiniz için de silinecek.',
      confirmLabel: 'Sil',
      destructive: true,
      onConfirm: () => del.mutate(planId, { onSuccess: () => navigation.goBack() }),
    });

  return (
    <Screen insetTop={false} refreshing={plan.isRefetching} onRefresh={() => void plan.refetch()}>
      <Text className="text-2xl font-bold text-ink">{plan.data.title}</Text>
      <Text className="mt-1 text-sm text-ink-mute">
        🗓️ {formatPlanDate(plan.data.plan_date)}
        {plan.data.location ? `  ·  📍 ${plan.data.location}` : ''}
      </Text>

      {queued > 0 ? (
        <View className="mt-3 rounded-xl2 bg-amber-soft px-3 py-2">
          <Text className="text-xs text-ink">{queued} değişiklik bağlantı bekliyor; gelince otomatik gönderilecek.</Text>
        </View>
      ) : null}

      <SectionTitle>Yapılacaklar</SectionTitle>
      <Card>
        <ErrorBanner error={checklist.error} />
        <View className="flex-row items-center">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={addItem}
            returnKeyType="done"
            maxLength={200}
            placeholder="Madde ekle (örn. Masa ayırt)"
            placeholderTextColor="#8C8994"
            accessibilityLabel="Yeni madde"
            className="mr-2 h-[44px] flex-1 rounded-xl2 bg-paper-sunk px-3 text-base text-ink"
          />
          <AppButton label="Ekle" size="sm" onPress={addItem} disabled={!draft.trim()} />
        </View>

        {items.length === 0 ? (
          <View className="mt-4">
            <EmptyState emoji="📝" title="Liste boş" body="Eklediğin her madde partnerinde anında görünür." />
          </View>
        ) : (
          <View className="mt-2">
            {open.map((i) => (
              <ChecklistItemRow key={i.id} item={i} onToggle={() => checklist.toggle(i)} onRemove={() => checklist.remove(i)} />
            ))}
            {done.map((i) => (
              <ChecklistItemRow key={i.id} item={i} onToggle={() => checklist.toggle(i)} onRemove={() => checklist.remove(i)} />
            ))}
          </View>
        )}
      </Card>

      <ErrorBanner error={del.error} />
      <AppButton label="Planı sil" variant="danger" className="mt-6" loading={del.isPending} onPress={confirmDelete} />
    </Screen>
  );
}
