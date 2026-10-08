import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { DELAY_OPTIONS, type DelayMinutes } from '@/api/buffer';
import { fetchCoupleProfiles } from '@/api/couple';
import { qk } from '@/api/keys';
import { PendingMessageCard } from '@/components/buffer/PendingMessageCard';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, Chip, EmptyState, ErrorBanner, LoadingView, SectionTitle } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';
import { useCancelMessage, useMessages, useScheduleMessage } from '@/hooks/useBuffer';
import { useNow } from '@/hooks/useNow';
import { confirmAction } from '@/lib/confirm';
import { formatDateTime } from '@/lib/time';
import { usePairedContext } from '@/store/useCoupleStore';

export function CoolingOffScreen() {
  const { userId, coupleId, partnerId } = usePairedContext();
  const messages = useMessages(coupleId);
  const profiles = useQuery({ queryKey: qk.profiles(coupleId), queryFn: fetchCoupleProfiles });
  const schedule = useScheduleMessage(coupleId);
  const cancel = useCancelMessage(coupleId);

  const [content, setContent] = useState('');
  const [delay, setDelay] = useState<DelayMinutes>(30);

  const partnerName = profiles.data?.find((p) => p.id === partnerId)?.display_name ?? 'Partnerin';

  const { pending, inbox, history } = useMemo(() => {
    const all = messages.data ?? [];
    return {
      pending: all.filter((m) => m.sender_id === userId && m.status === 'PENDING'),
      inbox: all.filter((m) => m.recipient_id === userId && m.status === 'SENT'),
      history: all.filter((m) => m.sender_id === userId && m.status !== 'PENDING'),
    };
  }, [messages.data, userId]);

  const now = useNow(1000, pending.length > 0);

  const submit = () => {
    if (!content.trim()) return;
    schedule.mutate({ content, delay }, { onSuccess: () => setContent('') });
  };

  const confirmCancel = (id: string) =>
    confirmAction({
      title: 'Mesajı geri çek',
      message: `${partnerName} bu mesajın varlığından hiç haberdar olmayacak.`,
      confirmLabel: 'Geri çek',
      cancelLabel: 'Kalsın',
      destructive: true,
      onConfirm: () => cancel.mutate(id),
    });

  return (
    <Screen
      title="Soğuma Odası"
      subtitle="Öfkeyle yazdığın mesaj bekler; sen fikrini değiştirebilirsin."
      refreshing={messages.isRefetching}
      onRefresh={() => void messages.refetch()}
    >
      <Card>
        <ErrorBanner error={schedule.error} />
        <TextField
          label={`${partnerName}'e mesaj`}
          value={content}
          onChangeText={setContent}
          multiline
          maxLength={2000}
          counter
          placeholder="İçini dök. Gönderilmeden önce soğuması için zaman tanı."
        />
        <Text className="mb-1.5 text-sm font-semibold text-ink-soft">Bekleme süresi</Text>
        <View className="mb-3 flex-row flex-wrap" accessibilityRole="radiogroup">
          {DELAY_OPTIONS.map((d) => (
            <Chip key={d} label={`${d} dk`} selected={delay === d} onPress={() => setDelay(d)} />
          ))}
        </View>
        <AppButton label="Soğumaya bırak" onPress={submit} disabled={!content.trim()} loading={schedule.isPending} />
      </Card>

      <ErrorBanner error={messages.error} onRetry={() => void messages.refetch()} />
      <ErrorBanner error={cancel.error} />

      {messages.isPending ? (
        <LoadingView />
      ) : (
        <>
          <SectionTitle>Soğuyanlar</SectionTitle>
          {pending.length === 0 ? (
            <EmptyState emoji="🧊" title="Bekleyen mesaj yok" />
          ) : (
            pending.map((m) => (
              <PendingMessageCard
                key={m.id}
                message={m}
                now={now}
                cancelling={cancel.isPending && cancel.variables === m.id}
                onCancel={() => confirmCancel(m.id)}
              />
            ))
          )}

          <SectionTitle>{partnerName}'den gelenler</SectionTitle>
          {inbox.length === 0 ? (
            <EmptyState emoji="💌" title="Henüz mesaj yok" body="Soğuma süresini tamamlayan mesajlar burada görünür." />
          ) : (
            inbox.map((m) => (
              <Card key={m.id}>
                <Text className="text-base leading-6 text-ink">{m.content}</Text>
                <Text className="mt-2 text-xs text-ink-mute">
                  {m.delay_minutes} dk soğuduktan sonra · {formatDateTime(m.sent_at)}
                </Text>
              </Card>
            ))
          )}

          {history.length > 0 ? (
            <>
              <SectionTitle>Geçmişim</SectionTitle>
              {history.map((m) => (
                <Card key={m.id} className={m.status === 'CANCELLED' ? 'bg-paper-sunk' : ''}>
                  <Text
                    className={`text-sm leading-5 ${m.status === 'CANCELLED' ? 'text-ink-mute line-through' : 'text-ink'}`}
                    numberOfLines={3}
                  >
                    {m.content}
                  </Text>
                  <Text className="mt-2 text-xs text-ink-mute">
                    {m.status === 'CANCELLED'
                      ? `Geri çekildi · yalnızca sen görüyorsun · ${formatDateTime(m.cancelled_at)}`
                      : `Gönderildi · ${formatDateTime(m.sent_at)}`}
                  </Text>
                </Card>
              ))}
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}
