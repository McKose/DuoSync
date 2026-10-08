import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { casePhase } from '@/api/court';
import { fetchCoupleProfiles } from '@/api/couple';
import { qk } from '@/api/keys';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, ErrorBanner, LoadingView, SectionTitle } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';
import { categoryMeta, PhaseBadge } from '@/components/court/CaseCard';
import { FaultBar } from '@/components/court/FaultBar';
import { useCase, useRetryVerdict, useSubmitDefense } from '@/hooks/useCourt';
import { useNow } from '@/hooks/useNow';
import { formatCountdown, formatDateTime } from '@/lib/time';
import type { RootStackParamList } from '@/navigation/types';
import { usePairedContext } from '@/store/useCoupleStore';

type Props = NativeStackScreenProps<RootStackParamList, 'Verdict'>;

/** Mirrors the cap in claim_case_for_verdict() / list_claimable_cases(). */
const MAX_VERDICT_ATTEMPTS = 5;

export function VerdictScreen({ route }: Props) {
  const { caseId } = route.params;
  const { userId, coupleId } = usePairedContext();
  const kase = useCase(coupleId, caseId);
  const profiles = useQuery({ queryKey: qk.profiles(coupleId), queryFn: fetchCoupleProfiles });
  const defense = useSubmitDefense(coupleId, caseId);
  const retry = useRetryVerdict(caseId);
  const [plea, setPlea] = useState('');
  const now = useNow(1000, kase.data?.status !== 'JUDGED');

  if (kase.isPending) return <LoadingView label="Dosya getiriliyor…" />;
  if (!kase.data) {
    return (
      <Screen insetTop={false}>
        <ErrorBanner error={kase.error} onRetry={() => void kase.refetch()} />
      </Screen>
    );
  }

  const c = kase.data;
  const phase = casePhase(c, now);
  const nameOf = (id: string) => profiles.data?.find((p) => p.id === id)?.display_name ?? '…';
  const prosecutor = nameOf(c.prosecutor_id);
  const defendant = nameOf(c.defendant_id);
  const iAmDefendant = c.defendant_id === userId;
  const remaining = new Date(c.defense_deadline).getTime() - now;
  const meta = categoryMeta(c.category);

  return (
    <Screen insetTop={false} refreshing={kase.isRefetching} onRefresh={() => void kase.refetch()}>
      <PhaseBadge phase={phase} />
      <Text className="mt-3 text-2xl font-bold text-ink">{c.title}</Text>
      <Text className="mt-1 text-xs text-ink-mute">
        {meta.emoji} {meta.label} · Dosya açılışı {formatDateTime(c.created_at)}
      </Text>

      <SectionTitle>Davacı · {prosecutor}</SectionTitle>
      <Card>
        <Text className="text-base leading-6 text-ink">{c.prosecutor_plea}</Text>
      </Card>

      <SectionTitle>Davalı · {defendant}</SectionTitle>
      {c.defendant_plea ? (
        <Card className={c.defense_timed_out ? 'bg-paper-sunk' : ''}>
          <Text className={`text-base leading-6 ${c.defense_timed_out ? 'italic text-ink-mute' : 'text-ink'}`}>
            {c.defendant_plea}
          </Text>
        </Card>
      ) : phase === 'AWAITING_DEFENSE' && iAmDefendant ? (
        <Card className="border-2 border-amber">
          <Text className="mb-3 text-sm font-semibold text-amber">
            Savunma için kalan süre: {formatCountdown(remaining)}
          </Text>
          <ErrorBanner error={defense.error} />
          <TextField
            label="Savunman"
            value={plea}
            onChangeText={setPlea}
            multiline
            maxLength={4000}
            counter
            placeholder="Kendini savun. Heyet iki tarafı da okuyacak."
          />
          <AppButton
            label="Savunmayı sun"
            variant="court"
            disabled={plea.trim().length === 0}
            loading={defense.isPending}
            onPress={() => defense.mutate(plea)}
          />
        </Card>
      ) : (
        <Card className="bg-paper-sunk">
          <Text className="text-sm text-ink-mute">
            {phase === 'DEFENSE_OVERDUE'
              ? 'Savunma süresi doldu. Heyet kısa süre içinde savunmasız karar verecek.'
              : `${defendant} henüz savunma yapmadı. Kalan süre: ${formatCountdown(remaining)}`}
          </Text>
        </Card>
      )}

      {phase === 'AWAITING_VERDICT' || phase === 'DELIBERATING' || phase === 'DEFENSE_OVERDUE' ? (
        <Card className="mt-4 items-center bg-court-soft">
          {c.verdict_attempts >= MAX_VERDICT_ATTEMPTS && phase === 'AWAITING_VERDICT' ? (
            // Server-side cap reached: claim_case_for_verdict will refuse this
            // case forever, so don't promise retries that can't happen.
            <Text className="text-center text-sm text-ink">
              Heyet bu davayı {MAX_VERDICT_ATTEMPTS} denemede karara bağlayamadı. Dilerseniz aynı konuyla yeni bir dava açabilirsiniz.
            </Text>
          ) : c.last_error && phase === 'AWAITING_VERDICT' ? (
            <>
              <Text className="mb-3 text-center text-sm text-ink">
                Heyet toplanamadı. Sistem birkaç dakika içinde otomatik tekrar deneyecek.
              </Text>
              <ErrorBanner error={retry.error} />
              <AppButton label="Şimdi tekrar dene" variant="court" size="sm" loading={retry.isPending} onPress={() => retry.mutate()} />
            </>
          ) : (
            <>
              <ActivityIndicator color="#2E3A59" />
              <Text className="mt-2 text-center text-sm font-semibold text-court">
                {phase === 'DELIBERATING' ? 'Heyet müzakerede… 🔨' : 'Heyet toplanıyor…'}
              </Text>
            </>
          )}
        </Card>
      ) : null}

      {phase === 'JUDGED' && c.fault_ratio_prosecutor !== null && c.fault_ratio_defendant !== null ? (
        <View className="mt-2">
          <SectionTitle>Kusur dağılımı</SectionTitle>
          <Card>
            <FaultBar
              leftLabel={prosecutor}
              leftValue={c.fault_ratio_prosecutor}
              rightLabel={defendant}
              rightValue={c.fault_ratio_defendant}
            />
          </Card>

          <SectionTitle>⚖️ Ağır Ceza Hâkimi</SectionTitle>
          <Card className="border-l-4 border-court">
            <Text className="text-base leading-6 text-ink">{c.verdict_judge}</Text>
          </Card>

          <SectionTitle>🎤 Zabıt Kâtibinin Şerhi</SectionTitle>
          <Card className="border-l-4 border-rose">
            <Text className="text-base italic leading-6 text-ink">{c.verdict_comedian}</Text>
          </Card>

          <SectionTitle>Hüküm</SectionTitle>
          <Card className="bg-amber-soft">
            <Text className="text-base font-semibold leading-6 text-ink">🧾 {c.penalty}</Text>
            <Text className="mt-2 text-xs text-ink-mute">Karar tarihi {formatDateTime(c.judged_at)}</Text>
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}
