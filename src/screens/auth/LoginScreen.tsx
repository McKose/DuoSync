import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { signIn, signUp } from '@/api/auth';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { ErrorBanner } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function LoginScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);

  const emailErr = touched && !EMAIL_RE.test(email.trim()) ? 'Geçerli bir e-posta gir.' : null;
  const passErr = touched && password.length < 8 ? 'Şifre en az 8 karakter olmalı.' : null;
  const nameErr = touched && mode === 'signup' && name.trim().length === 0 ? 'Partnerinin göreceği adı gir.' : null;

  const auth = useMutation({
    mutationFn: async () => {
      if (mode === 'signin') {
        await signIn(email, password);
        return true;
      }
      return signUp(email, password, name);
    },
    onSuccess: (hasSession) => {
      // Navigation reacts to the auth listener; only handle "confirm email".
      if (!hasSession) setConfirmSent(true);
    },
  });

  const submit = () => {
    setTouched(true);
    const valid = EMAIL_RE.test(email.trim()) && password.length >= 8 && (mode === 'signin' || name.trim());
    if (valid) auth.mutate();
  };

  return (
    <Screen>
      <View className="mb-10 mt-12">
        <Text className="text-5xl">💞</Text>
        <Text className="mt-4 text-4xl font-bold text-ink">DuoSync</Text>
        <Text className="mt-2 text-base text-ink-mute">İkiniz için tek bir merkez. Kimse araya giremez.</Text>
      </View>

      {confirmSent ? (
        <View className="mb-4 rounded-xl2 bg-sage-soft p-4">
          <Text className="text-sm text-ink">
            Onay e-postası gönderildi. Bağlantıya tıkladıktan sonra buradan giriş yapabilirsin.
          </Text>
        </View>
      ) : null}

      <ErrorBanner error={auth.error} />

      {mode === 'signup' ? (
        <TextField label="Adın" value={name} onChangeText={setName} maxLength={40} error={nameErr} autoCapitalize="words" />
      ) : null}
      <TextField
        label="E-posta"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        error={emailErr}
      />
      <TextField
        label="Şifre"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
        textContentType={mode === 'signin' ? 'password' : 'newPassword'}
        error={passErr}
      />

      <AppButton label={mode === 'signin' ? 'Giriş yap' : 'Hesap oluştur'} onPress={submit} loading={auth.isPending} />

      <Pressable
        className="mt-5 items-center py-2"
        accessibilityRole="button"
        onPress={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin');
          setTouched(false);
          auth.reset();
        }}
      >
        <Text className="text-sm font-semibold text-rose">
          {mode === 'signin' ? 'Hesabın yok mu? Kayıt ol' : 'Zaten hesabın var mı? Giriş yap'}
        </Text>
      </Pressable>
    </Screen>
  );
}
