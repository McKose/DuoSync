import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { CATEGORY_META } from '@/api/court';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Chip, ErrorBanner } from '@/components/common/StateViews';
import { TextField } from '@/components/common/TextField';
import { useFileCase } from '@/hooks/useCourt';
import type { RootStackParamList } from '@/navigation/types';
import { usePairedContext } from '@/store/useCoupleStore';
import { CASE_CATEGORIES, type CaseCategory } from '@/types/database.types';

export function NewCaseScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { coupleId } = usePairedContext();
  const fileCase = useFileCase(coupleId);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<CaseCategory>('CHORES');
  const [plea, setPlea] = useState('');
  const [touched, setTouched] = useState(false);

  const titleErr = touched && title.trim().length < 3 ? 'Başlık en az 3 karakter olmalı.' : null;
  const pleaErr = touched && plea.trim().length < 10 ? 'İddianı en az 10 karakterle anlat.' : null;

  const submit = () => {
    setTouched(true);
    if (title.trim().length < 3 || plea.trim().length < 10) return;
    fileCase.mutate(
      { title, category, plea },
      { onSuccess: (row) => nav.replace('Verdict', { caseId: row.id }) },
    );
  };

  return (
    <Screen insetTop={false}>
      <Text className="mb-4 text-sm text-ink-mute">
        Partnerin bildirim alacak ve savunması için 24 saati olacak. Savunma gelmeden ya da süre dolmadan heyet karar vermez.
      </Text>
      <ErrorBanner error={fileCase.error} />
      <TextField
        label="Dava başlığı"
        value={title}
        onChangeText={setTitle}
        maxLength={120}
        counter
        error={titleErr}
        placeholder="Örn. Bulaşık makinesi boşaltılmadı"
      />
      <Text className="mb-1.5 text-sm font-semibold text-ink-soft">Kategori</Text>
      <View className="mb-3 flex-row flex-wrap" accessibilityRole="radiogroup">
        {CASE_CATEGORIES.map((c) => (
          <Chip
            key={c}
            tone="court"
            label={`${CATEGORY_META[c].emoji} ${CATEGORY_META[c].label}`}
            selected={category === c}
            onPress={() => setCategory(c)}
          />
        ))}
      </View>
      <TextField
        label="İddian"
        value={plea}
        onChangeText={setPlea}
        multiline
        maxLength={4000}
        counter
        error={pleaErr}
        placeholder="Ne oldu? Neden haklısın? Delillerini sun."
      />
      <AppButton label="Davayı aç" variant="court" onPress={submit} loading={fileCase.isPending} />
    </Screen>
  );
}
