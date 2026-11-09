import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { AppButton } from '@/components/common/AppButton';
import { Card, ErrorBanner, SectionTitle } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';
import { useReplyAppeal, useRetryAppealVerdict } from '@/hooks/useCourt';
import { APPEAL_TEXT_MAX, MAX_APPEAL_VERDICT_ATTEMPTS, verdictOf } from '@/lib/appeals';
import { formatCountdown } from '@/lib/time';
import type { CourtAppeal } from '@/types/database.types';
import { VerdictBody } from './VerdictBody';

interface Props {
  appeal: CourtAppeal;
  coupleId: string;
  userId: string;
  nameOf: (id: string) => string;
  prosecutor: string;
  defendant: string;
  current: boolean;
  now: number;
}

/** One istinaf round: reason, reply (or the reply form), then its verdict. */
export function AppealRound({ appeal: a, coupleId, userId, nameOf, prosecutor, defendant, current, now }: Props) {
  const reply = useReplyAppeal(coupleId);
  const retry = useRetryAppealVerdict(coupleId);
  const [draft, setDraft] = useState('');

  const appellant = nameOf(a.appellant_id);
  const respondent = nameOf(a.respondent_id);
  const remaining = new Date(a.reply_deadline).getTime() - now;
  const verdict = a.status === 'JUDGED' ? verdictOf(a) : null;
  const waitingForPanel = a.status === 'DELIBERATING' || (a.status === 'AWAITING_REPLY' && (a.respondent_reply !== null || remaining <= 0));

  return (
    <View className="mt-6 border-t border-paper-sunk pt-1">
      <SectionTitle>
        {a.round}. istinaf · {appellant} itiraz etti
      </SectionTitle>
      <Card className="border-l-4 border-amber">
        <Text className="text-base leading-6 text-ink">{a.appellant_reason}</Text>
      </Card>

      <SectionTitle>Cevap · {respondent}</SectionTitle>
      {a.respondent_reply !== null ? (
        <Card className={a.reply_timed_out ? 'bg-paper-sunk' : ''}>
          <Text className={`text-base leading-6 ${a.reply_timed_out ? 'italic text-ink-mute' : 'text-ink'}`}>{a.respondent_reply}</Text>
        </Card>
      ) : a.status === 'AWAITING_REPLY' && a.respondent_id === userId && remaining > 0 ? (
        <Card className="border-2 border-amber">
          <Text className="mb-3 text-sm font-semibold text-amber">İtiraza cevap için kalan süre: {formatCountdown(remaining)}</Text>
          <ErrorBanner error={reply.error} />
          <TextField
            label="Cevabın"
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={APPEAL_TEXT_MAX}
            counter
            placeholder="İtiraza cevap ver. Heyet iki tarafı da yeniden okuyacak."
          />
          <AppButton
            label="Cevabı gönder"
            variant="court"
            disabled={draft.trim().length === 0}
            loading={reply.isPending}
            onPress={() => reply.mutate({ appealId: a.id, reply: draft })}
          />
        </Card>
      ) : (
        <Card className="bg-paper-sunk">
          <Text className="text-sm text-ink-mute">
            {remaining <= 0
              ? 'Cevap süresi doldu. İstinaf heyeti kısa süre içinde cevapsız karar verecek.'
              : `${respondent} henüz cevap vermedi. Kalan süre: ${formatCountdown(remaining)}`}
          </Text>
        </Card>
      )}

      {verdict ? (
        <VerdictBody
          key={`${a.id}-${current}`}
          title={`${a.round}. istinaf kararı`}
          verdict={verdict}
          prosecutor={prosecutor}
          defendant={defendant}
          current={current}
        />
      ) : waitingForPanel ? (
        <Card className="mt-4 items-center bg-court-soft">
          {a.verdict_attempts >= MAX_APPEAL_VERDICT_ATTEMPTS && a.status === 'AWAITING_REPLY' ? (
            <Text className="text-center text-sm text-ink">
              İstinaf heyeti bu itirazı {MAX_APPEAL_VERDICT_ATTEMPTS} denemede karara bağlayamadı; önceki karar geçerli kalır.
            </Text>
          ) : a.last_error && a.status === 'AWAITING_REPLY' ? (
            <>
              <Text className="mb-3 text-center text-sm text-ink">
                İstinaf heyeti toplanamadı. Sistem birkaç dakika içinde otomatik tekrar deneyecek.
              </Text>
              <ErrorBanner error={retry.error} />
              <AppButton label="Şimdi tekrar dene" variant="court" size="sm" loading={retry.isPending} onPress={() => retry.mutate(a.id)} />
            </>
          ) : (
            <>
              <ActivityIndicator color="#2E3A59" />
              <Text className="mt-2 text-center text-sm font-semibold text-court">
                {a.status === 'DELIBERATING' ? 'İstinaf heyeti müzakerede… 🔨' : 'İstinaf heyeti toplanıyor…'}
              </Text>
            </>
          )}
        </Card>
      ) : null}
    </View>
  );
}
