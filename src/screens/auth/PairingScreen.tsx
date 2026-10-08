import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Share, Text, View } from 'react-native';
import { signOut } from '@/api/auth';
import { createPairingCode, pairWithCode } from '@/api/couple';
import { qk } from '@/api/keys';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, ErrorBanner, SectionTitle } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';
import { DEMO_PARTNER_NAME, IS_DEMO } from '@/demo';
import { useNow } from '@/hooks/useNow';
import { formatCountdown } from '@/lib/time';
import { useCoupleStore } from '@/store/useCoupleStore';

const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

export function PairingScreen() {
  const queryClient = useQueryClient();
  const userId = useCoupleStore((s) => s.userId)!;
  const couple = useCoupleStore((s) => s.couple);
  const [joinCode, setJoinCode] = useState('');

  const pendingCode =
    couple && !couple.is_active && couple.user_a_id === userId ? couple.pairing_code : null;
  const expiresAt = couple?.pairing_code_expires_at ? new Date(couple.pairing_code_expires_at).getTime() : 0;
  const now = useNow(1000, Boolean(pendingCode));
  const expired = Boolean(pendingCode) && expiresAt <= now;

  const create = useMutation({
    mutationFn: createPairingCode,
    onSuccess: (row) => queryClient.setQueryData(qk.couple(userId), row),
  });

  const join = useMutation({
    mutationFn: (code: string) => pairWithCode(code),
    // Store → navigator switches to the paired stack.
    onSuccess: (row) => queryClient.setQueryData(qk.couple(userId), row),
  });

  const normalized = joinCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const codeValid = CODE_RE.test(normalized);

  return (
    <Screen title="Partnerini bağla" subtitle="DuoSync yalnızca iki kişi içindir. Biriniz kod oluşturur, diğeri girer.">
      {IS_DEMO ? (
        <Card className="bg-paper-sunk">
          <Text className="text-xs leading-5 text-ink-soft">
            Demo: kod oluşturursan {DEMO_PARTNER_NAME} ~5 sn içinde katılır. Ya da 6 karakterlik herhangi bir kodu gir (ör. K7M2QX).
          </Text>
        </Card>
      ) : null}

      <SectionTitle>1 · Kod oluştur</SectionTitle>
      <Card>
        <ErrorBanner error={create.error} />
        {pendingCode && !expired ? (
          <View className="items-center">
            <Text
              className="text-5xl font-bold tracking-[8px] text-ink"
              accessibilityLabel={`Eşleşme kodu ${pendingCode.split('').join(' ')}`}
              selectable
            >
              {pendingCode}
            </Text>
            <Text className="mt-2 text-xs text-ink-mute">
              {formatCountdown(expiresAt - now)} içinde geçerliliğini yitirir · Partnerin girince otomatik bağlanırsınız
            </Text>
            <View className="mt-4 w-full flex-row">
              <AppButton
                label="Paylaş"
                className="mr-2 flex-1"
                onPress={() => void Share.share({ message: `DuoSync eşleşme kodum: ${pendingCode}` })}
              />
              <AppButton
                label="Yeni kod"
                variant="secondary"
                className="flex-1"
                loading={create.isPending}
                onPress={() => create.mutate()}
              />
            </View>
          </View>
        ) : (
          <AppButton
            label={expired ? 'Kodun süresi doldu — yenisini oluştur' : 'Eşleşme kodu oluştur'}
            onPress={() => create.mutate()}
            loading={create.isPending}
          />
        )}
      </Card>

      <SectionTitle>2 · Ya da partnerinin koduna katıl</SectionTitle>
      <Card>
        <ErrorBanner error={join.error} />
        <TextField
          label="6 haneli kod"
          value={normalized}
          onChangeText={setJoinCode}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={6}
          placeholder="ÖRN. K7M2QX"
        />
        <AppButton
          label="Eşleş"
          variant="court"
          disabled={!codeValid}
          loading={join.isPending}
          onPress={() => join.mutate(normalized)}
        />
        {pendingCode ? (
          <Text className="mt-3 text-xs text-ink-mute">
            Partnerinin koduna katılırsan senin oluşturduğun kod iptal edilir.
          </Text>
        ) : null}
      </Card>

      <AppButton label="Çıkış yap" variant="ghost" className="mt-6" onPress={() => void signOut()} />
    </Screen>
  );
}
