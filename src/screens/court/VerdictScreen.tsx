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
import { AppealRound } from '@/components/court/AppealRound';
import { categoryMeta, PhaseBadge } from '@/components/court/CaseCard';
import { VerdictBody } from '@/components/court/VerdictBody';
import { useAppeals, useCase, useFileAppeal, useRetryVerdict, useSubmitDefense } from '@/hooks/useCourt';
import { useNow } from '@/hooks/useNow';
import { APPEAL_REASON_MIN, APPEAL_TEXT_MAX, appealView, MAX_APPEALS, verdictOf } from '@/lib/appeals';
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
  const appeals = useAppeals(coupleId);
  const defense = useSubmitDefense(coupleId, caseId);
  const retry = useRetryVerdict(caseId);
  const fileAppeal = useFileAppeal(coupleId, caseId);
  const [plea, setPlea] = useState('');
  const [appealing, setAppealing] = useState(false);
  const [reason, setReason] = useState('');
  // Judged cases still count down while an appeal could follow.
  const roundsUsed = (appeals.data ?? []).filter((a) => a.case_id === caseId).length;
  const now = useNow(1000, kase.data?.status !== 'JUDGED' || roundsUsed < MAX_APPEALS);

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
  const view = appealView(c, appeals.data ?? [], now);
  const firstInstance = verdictOf(c);

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

      {firstInstance ? (
        <VerdictBody
          key={`first-${view.currentRound === 0}`}
          title="İlk derece kararı"
          verdict={firstInstance}
          prosecutor={prosecutor}
          defendant={defendant}
          current={view.currentRound === 0}
        />
      ) : null}

      <ErrorBanner error={appeals.error} onRetry={() => void appeals.refetch()} />
      {view.rounds.map((a) => (
        <AppealRound
          key={a.id}
          appeal={a}
          coupleId={coupleId}
          userId={userId}
          nameOf={nameOf}
          prosecutor={prosecutor}
          defendant={defendant}
          current={view.currentRound === a.round}
          now={now}
        />
      ))}

      {view.canAppeal && view.windowEndsAt !== null ? (
        <Card className="mt-6 border-2 border-court">
          <Text className="text-base font-semibold text-ink">Karara itiraz et</Text>
          <Text className="mt-1 text-xs text-ink-mute">
            Kalan itiraz hakkı: {view.remaining}/{MAX_APPEALS} · Süre: {formatCountdown(view.windowEndsAt - now)}
          </Text>
          {appealing ? (
            <View className="mt-3">
              <ErrorBanner error={fileAppeal.error} />
              <TextField
                label="İtiraz gerekçen"
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={APPEAL_TEXT_MAX}
                counter
                placeholder="Neden yeniden bakılmalı? Karşı taraf 12 saat içinde cevap verebilir."
              />
              <AppButton
                label="İtirazı gönder"
                variant="court"
                disabled={reason.trim().length < APPEAL_REASON_MIN}
                loading={fileAppeal.isPending}
                onPress={() =>
                  fileAppeal.mutate(reason, {
                    onSuccess: () => {
                      setReason('');
                      setAppealing(false);
                    },
                  })
                }
              />
            </View>
          ) : (
            <AppButton label="İtiraz et" variant="secondary" size="sm" className="mt-3" onPress={() => setAppealing(true)} />
          )}
        </Card>
      ) : c.status === 'JUDGED' && view.current && !view.open ? (
        <Text className="mt-5 text-center text-xs text-ink-mute">
          {view.remaining === 0 ? 'İki itiraz hakkı da kullanıldı; karar kesinleşti.' : 'İtiraz süresi doldu; karar kesinleşti.'}
        </Text>
      ) : null}
    </Screen>
  );
}
