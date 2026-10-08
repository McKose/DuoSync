import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { fetchCoupleProfiles } from '@/api/couple';
import { qk } from '@/api/keys';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, Chip, EmptyState, ErrorBanner, LoadingView } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';
import { useAnswerQuestion, useAskQuestion, useDeleteQuestion, useQuestions } from '@/hooks/useBuffer';
import { formatRelative } from '@/lib/time';
import { usePairedContext } from '@/store/useCoupleStore';
import type { PendingQuestion } from '@/types/database.types';

function AnswerBox({ q, coupleId }: { q: PendingQuestion; coupleId: string }) {
  const answer = useAnswerQuestion(coupleId);
  const [text, setText] = useState('');
  return (
    <View className="mt-3">
      <ErrorBanner error={answer.error} />
      <TextField label="Cevabın" value={text} onChangeText={setText} multiline maxLength={2000} />
      <AppButton
        label="Cevapla"
        size="sm"
        disabled={!text.trim()}
        loading={answer.isPending}
        onPress={() => answer.mutate({ id: q.id, answer: text })}
      />
    </View>
  );
}

export function QuestionsVaultScreen() {
  const { userId, coupleId, partnerId } = usePairedContext();
  const questions = useQuestions(coupleId);
  const profiles = useQuery({ queryKey: qk.profiles(coupleId), queryFn: fetchCoupleProfiles });
  const ask = useAskQuestion(coupleId);
  const remove = useDeleteQuestion(coupleId);

  const [tab, setTab] = useState<'toMe' | 'mine'>('toMe');
  const [draft, setDraft] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const partnerName = profiles.data?.find((p) => p.id === partnerId)?.display_name ?? 'Partnerin';

  const { toMe, mine } = useMemo(() => {
    const all = questions.data ?? [];
    return { toMe: all.filter((q) => q.asker_id !== userId), mine: all.filter((q) => q.asker_id === userId) };
  }, [questions.data, userId]);
  const unansweredToMe = toMe.filter((q) => !q.is_answered).length;
  const list = tab === 'toMe' ? toMe : mine;

  return (
    <Screen
      title="Soru Kasası"
      subtitle="Ulaşamadığın anlarda sor; o müsait olunca cevaplasın."
      refreshing={questions.isRefetching}
      onRefresh={() => void questions.refetch()}
    >
      <Card>
        <ErrorBanner error={ask.error} />
        <TextField
          label={`${partnerName}'e soru`}
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={1000}
          counter
          placeholder="Örn. Pazar annemlere gidebilir miyiz?"
        />
        <AppButton
          label="Kasaya at"
          variant="court"
          disabled={!draft.trim()}
          loading={ask.isPending}
          onPress={() => ask.mutate(draft, { onSuccess: () => setDraft('') })}
        />
      </Card>

      <View className="mt-4 flex-row" accessibilityRole="tablist">
        <Chip tone="court" label={`Bana sorulanlar${unansweredToMe ? ` (${unansweredToMe})` : ''}`} selected={tab === 'toMe'} onPress={() => setTab('toMe')} />
        <Chip tone="court" label="Sorularım" selected={tab === 'mine'} onPress={() => setTab('mine')} />
      </View>

      <ErrorBanner error={questions.error} onRetry={() => void questions.refetch()} />
      <ErrorBanner error={remove.error} />

      {questions.isPending ? (
        <LoadingView />
      ) : list.length === 0 ? (
        <EmptyState emoji="🗝️" title={tab === 'toMe' ? 'Sana soru yok' : 'Henüz soru sormadın'} />
      ) : (
        list.map((q) => (
          <Card key={q.id} className={!q.is_answered && tab === 'toMe' ? 'border-2 border-court-soft' : ''}>
            <Text className="text-base font-semibold leading-6 text-ink">{q.question_text}</Text>
            <Text className="mt-1 text-xs text-ink-mute">{formatRelative(q.created_at)}</Text>

            {q.is_answered ? (
              <View className="mt-3 rounded-xl bg-sage-soft p-3">
                <Text className="text-sm leading-5 text-ink">{q.answer_text}</Text>
                <Text className="mt-1 text-xs text-ink-mute">Cevap · {formatRelative(q.answered_at)}</Text>
              </View>
            ) : tab === 'toMe' ? (
              openId === q.id ? (
                <AnswerBox q={q} coupleId={coupleId} />
              ) : (
                <Pressable onPress={() => setOpenId(q.id)} accessibilityRole="button" className="mt-3">
                  <Text className="text-sm font-semibold text-court">Cevapla →</Text>
                </Pressable>
              )
            ) : (
              <View className="mt-3 flex-row items-center justify-between">
                <Text className="text-xs text-ink-mute">Cevap bekleniyor</Text>
                <Pressable onPress={() => remove.mutate(q.id)} accessibilityRole="button" hitSlop={8}>
                  <Text className="text-xs font-semibold text-danger">Geri al</Text>
                </Pressable>
              </View>
            )}
          </Card>
        ))
      )}
    </Screen>
  );
}
