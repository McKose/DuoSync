import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { signOut } from '@/api/auth';
import { coupleSides, fetchCoupleProfiles, updatePresence } from '@/api/couple';
import { qk } from '@/api/keys';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, Chip, EmptyState, ErrorBanner, LoadingView, SectionTitle } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';
import { PartnerStatusCard, STATUS_META } from '@/components/dashboard/PartnerStatusCard';
import { PlanCard } from '@/components/dashboard/PlanCard';
import { useNow } from '@/hooks/useNow';
import { useCreatePlan, usePlans } from '@/hooks/usePlans';
import { planDatePresets } from '@/lib/time';
import type { RootStackParamList } from '@/navigation/types';
import { usePairedContext } from '@/store/useCoupleStore';
import type { PartnerStatus } from '@/types/database.types';

const MANUAL_STATUSES: PartnerStatus[] = ['NORMAL', 'BUSY', 'FRAGILE'];

export function DashboardScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const queryClient = useQueryClient();
  const { userId, couple, coupleId, partnerId } = usePairedContext();
  const now = useNow(30_000);

  const profiles = useQuery({ queryKey: qk.profiles(coupleId), queryFn: fetchCoupleProfiles });
  const plans = usePlans(coupleId);
  const createPlan = useCreatePlan(coupleId, userId);

  const sides = coupleSides(couple, userId);
  const partnerName = profiles.data?.find((p) => p.id === partnerId)?.display_name ?? 'Partnerin';
  const myName = profiles.data?.find((p) => p.id === userId)?.display_name ?? '';

  const setStatus = useMutation({
    mutationFn: (status: PartnerStatus) => updatePresence({ status }),
    onSuccess: (row) => queryClient.setQueryData(qk.couple(userId), row),
  });

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  // Presets are relative to "now": recompute every time the form opens, or a
  // screen mounted at 19:00 would still offer "Bu akşam 20:00" at 21:00.
  const [presets, setPresets] = useState(() => planDatePresets());
  const [dateIdx, setDateIdx] = useState(0);
  const toggleForm = () => {
    if (!showForm) {
      setPresets(planDatePresets());
      setDateIdx(0);
    }
    setShowForm(!showForm);
  };

  const submitPlan = () => {
    if (!title.trim()) return;
    createPlan.mutate(
      { title, location: location || null, planDate: presets[dateIdx]?.value ?? null },
      {
        onSuccess: (plan) => {
          setTitle('');
          setLocation('');
          setShowForm(false);
          nav.navigate('PlanDetail', { planId: plan.id });
        },
      },
    );
  };

  const upcoming = (plans.data ?? []).filter(
    (p) => !p.plan_date || new Date(p.plan_date).getTime() > now - 6 * 3600 * 1000,
  );

  return (
    <Screen
      title="Canlı Masa"
      subtitle={myName ? `Merhaba ${myName}` : undefined}
      refreshing={plans.isRefetching}
      onRefresh={() => {
        void plans.refetch();
        void queryClient.invalidateQueries({ queryKey: qk.couple(userId) });
      }}
      right={
        <Pressable onPress={() => void signOut()} accessibilityRole="button" hitSlop={10}>
          <Text className="text-sm font-semibold text-ink-mute">Çıkış</Text>
        </Pressable>
      }
    >
      <PartnerStatusCard
        name={partnerName}
        battery={sides.partner.battery}
        status={sides.partner.status}
        seenAt={sides.partner.seenAt}
        now={now}
      />

      <Card>
        <Text className="mb-2 text-sm font-semibold text-ink-soft">Benim modum</Text>
        <ErrorBanner error={setStatus.error} />
        <View className="flex-row flex-wrap" accessibilityRole="radiogroup">
          {MANUAL_STATUSES.map((s) => (
            <Chip
              key={s}
              tone="sage"
              label={`${STATUS_META[s].emoji} ${STATUS_META[s].label}`}
              selected={sides.me.status === s}
              onPress={() => setStatus.mutate(s)}
            />
          ))}
        </View>
        {sides.me.status === 'LOW_BATTERY' ? (
          <Text className="text-xs text-ink-mute">
            {'Pilin %15\'in altında olduğu için otomatik "Şarjı azalıyor" görünüyorsun.'}
          </Text>
        ) : null}
      </Card>

      <View className="mt-5 flex-row items-center justify-between">
        <Text className="text-xs font-bold uppercase tracking-wider text-ink-mute">Planlar</Text>
        <Pressable onPress={toggleForm} accessibilityRole="button" hitSlop={8}>
          <Text className="text-sm font-semibold text-rose">{showForm ? 'Vazgeç' : '+ Yeni plan'}</Text>
        </Pressable>
      </View>

      {showForm ? (
        <Card className="mt-2">
          <ErrorBanner error={createPlan.error} />
          <TextField label="Ne yapıyoruz?" value={title} onChangeText={setTitle} maxLength={120} placeholder="Örn. Cuma akşamı yemek" />
          <TextField label="Nerede? (opsiyonel)" value={location} onChangeText={setLocation} maxLength={200} />
          <Text className="mb-1.5 text-sm font-semibold text-ink-soft">Ne zaman?</Text>
          <View className="mb-3 flex-row flex-wrap">
            {presets.map((p, i) => (
              <Chip key={p.label} label={p.label} selected={dateIdx === i} onPress={() => setDateIdx(i)} />
            ))}
          </View>
          <AppButton label="Planı oluştur" onPress={submitPlan} disabled={!title.trim()} loading={createPlan.isPending} />
        </Card>
      ) : null}

      <View className="mt-2">
        <ErrorBanner error={plans.error} onRetry={() => void plans.refetch()} />
        {plans.isPending ? (
          <LoadingView />
        ) : upcoming.length === 0 ? (
          <EmptyState emoji="🍝" title="Masa boş" body="Bu akşam için bir plan ekleyin; listeyi ikiniz de anlık görürsünüz." />
        ) : (
          upcoming.map((p) => (
            <PlanCard key={p.id} plan={p} onPress={() => nav.navigate('PlanDetail', { planId: p.id })} />
          ))
        )}
      </View>
      {(plans.data?.length ?? 0) > upcoming.length ? (
        <>
          <SectionTitle>Geçmiş</SectionTitle>
          {(plans.data ?? [])
            .filter((p) => !upcoming.includes(p))
            .map((p) => (
              <PlanCard key={p.id} plan={p} onPress={() => nav.navigate('PlanDetail', { planId: p.id })} />
            ))}
        </>
      ) : null}
    </Screen>
  );
}
