import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { fetchCoupleProfiles } from '@/api/couple';
import { qk } from '@/api/keys';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, Chip, EmptyState, ErrorBanner, LoadingView, SectionTitle } from '@/components/common/StateViews';
import { Wheel } from '@/components/dashboard/Wheel';
import { useNow } from '@/hooks/useNow';
import {
  useAddWheelOption,
  useRemoveWheelOption,
  useSpinWheel,
  useWheelAnimation,
  useWheelOptions,
  useWheelSpins,
} from '@/hooks/useWheel';
import { formatRelative } from '@/lib/time';
import { WHEEL_LABEL_MAX, WHEEL_MAX_OPTIONS } from '@/lib/wheel';
import { usePairedContext } from '@/store/useCoupleStore';

const SUGGESTIONS = ['Sushi', 'Köfte', 'Pizza', 'Mantı', 'Lahmacun', 'Döner', 'Burger', 'Ev yemeği', 'Balık', 'Çin yemeği'];

/**
 * "Ne yesek?" — the server draws the result (spin_wheel); this screen only
 * animates to it, so both partners always land on the same answer.
 */
export function DecisionWheelScreen() {
  const { userId, coupleId, partnerId } = usePairedContext();
  const { width } = useWindowDimensions();
  const now = useNow(30_000);

  const options = useWheelOptions(coupleId);
  const spins = useWheelSpins(coupleId);
  const profiles = useQuery({ queryKey: qk.profiles(coupleId), queryFn: fetchCoupleProfiles });
  const add = useAddWheelOption(coupleId);
  const remove = useRemoveWheelOption(coupleId);
  const spin = useSpinWheel(coupleId);
  const [draft, setDraft] = useState('');

  const optionLabels = (options.data ?? []).map((o) => o.label);
  const wheel = useWheelAnimation(spins.data?.[0] ?? null, spins.isSuccess && options.isSuccess, optionLabels);

  const partnerName = profiles.data?.find((p) => p.id === partnerId)?.display_name ?? 'Partnerin';
  const who = (id: string | null) => (id === userId ? 'Sen' : id === partnerId ? partnerName : 'Eski partner');
  /** Verb agrees with the person: "Sen çevirdin" / "Deniz çevirdi". */
  const spunBy = (id: string | null) => (id === userId ? 'Sen çevirdin' : `${who(id)} çevirdi`);

  if (options.isPending || spins.isPending) return <LoadingView />;
  if (options.error || spins.error) {
    return (
      <Screen insetTop={false}>
        <ErrorBanner
          error={options.error ?? spins.error}
          onRetry={() => {
            void options.refetch();
            void spins.refetch();
          }}
        />
      </Screen>
    );
  }

  const full = optionLabels.length >= WHEEL_MAX_OPTIONS;
  const lower = new Set(optionLabels.map((l) => l.toLocaleLowerCase('tr')));
  const suggestions = SUGGESTIONS.filter((s) => !lower.has(s.toLocaleLowerCase('tr')));
  const submit = (label: string) => {
    const text = label.trim();
    if (!text) return;
    add.mutate(text, { onSuccess: () => setDraft('') });
  };

  const result = wheel.shown;
  const history = (spins.data ?? []).filter((s) => s.id !== result?.id);

  return (
    <Screen
      insetTop={false}
      refreshing={options.isRefetching || spins.isRefetching}
      onRefresh={() => {
        void options.refetch();
        void spins.refetch();
      }}
    >
      <Text className="text-sm text-ink-mute">
        Sonucu sunucu seçer ve saklar; ikinizin ekranında da çark aynı yerde durur.
      </Text>

      <View className="my-4 items-center">
        <Wheel labels={wheel.labels} rotation={wheel.rotation} restAngle={wheel.restAngle} size={Math.min(width - 48, 300)} />
      </View>

      <View accessibilityLiveRegion="polite" className="mb-3 min-h-[56px] items-center justify-center">
        {wheel.spinning && result ? (
          <Text className="text-base font-semibold text-ink-soft">{spunBy(result.spun_by)}… 🎡</Text>
        ) : result ? (
          <>
            <Text className="text-2xl font-bold text-ink">🎉 Karar: {result.result_label}</Text>
            <Text className="mt-1 text-xs text-ink-mute">
              {spunBy(result.spun_by)} · {formatRelative(result.created_at, now)}
            </Text>
          </>
        ) : (
          <Text className="text-sm text-ink-mute">Henüz çevrilmedi.</Text>
        )}
      </View>

      <ErrorBanner error={spin.error} />
      <AppButton
        label="Çevir 🎡"
        onPress={() => spin.mutate()}
        loading={spin.isPending}
        disabled={wheel.spinning || optionLabels.length < 2}
        accessibilityHint="Sonucu sunucu rastgele seçer"
      />
      {optionLabels.length < 2 ? (
        <Text className="mt-2 text-center text-xs text-ink-mute">Çevirmek için en az 2 seçenek ekleyin.</Text>
      ) : null}

      <SectionTitle>
        Seçenekler · {optionLabels.length}/{WHEEL_MAX_OPTIONS}
      </SectionTitle>
      <Card>
        <ErrorBanner error={add.error ?? remove.error} />
        {full ? null : (
          <>
            <View className="flex-row items-center">
              <TextInput
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={() => submit(draft)}
                returnKeyType="done"
                maxLength={WHEEL_LABEL_MAX}
                placeholder="Seçenek ekle (örn. Pide)"
                placeholderTextColor="#8C8994"
                accessibilityLabel="Yeni seçenek"
                className="mr-2 h-[44px] flex-1 rounded-xl2 bg-paper-sunk px-3 text-base text-ink"
              />
              <AppButton label="Ekle" size="sm" onPress={() => submit(draft)} disabled={!draft.trim()} loading={add.isPending} />
            </View>
            {suggestions.length > 0 ? (
              <View className="mt-3 flex-row flex-wrap">
                {suggestions.slice(0, 6).map((s) => (
                  <Chip key={s} label={`+ ${s}`} selected={false} onPress={() => submit(s)} />
                ))}
              </View>
            ) : null}
          </>
        )}

        {(options.data ?? []).length === 0 ? (
          <View className="mt-2">
            <EmptyState emoji="🎡" title="Çark boş" body="Eklediğiniz seçenekler ikinizde de anında görünür." />
          </View>
        ) : (
          (options.data ?? []).map((o) => (
            <View key={o.id} className="flex-row items-center border-b border-paper-sunk py-3">
              <Text className="flex-1 text-base text-ink">{o.label}</Text>
              <Pressable
                onPress={() => remove.mutate(o.id)}
                disabled={wheel.spinning}
                accessibilityRole="button"
                accessibilityLabel={`${o.label} seçeneğini sil`}
                hitSlop={10}
                className="pl-3"
              >
                <Text className="text-lg text-ink-mute">×</Text>
              </Pressable>
            </View>
          ))
        )}
      </Card>

      {history.length > 0 ? (
        <>
          <SectionTitle>Önceki kararlar</SectionTitle>
          <Card>
            {history.map((s) => (
              <View key={s.id} className="flex-row items-center justify-between border-b border-paper-sunk py-2.5">
                <Text className="flex-1 text-base text-ink">{s.result_label}</Text>
                <Text className="text-xs text-ink-mute">
                  {who(s.spun_by)} · {formatRelative(s.created_at, now)}
                </Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
