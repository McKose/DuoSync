import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMemo } from 'react';
import { casePhase } from '@/api/court';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { EmptyState, ErrorBanner, LoadingView, SectionTitle } from '@/components/common/StateViews';
import { CaseCard } from '@/components/court/CaseCard';
import { useCases } from '@/hooks/useCourt';
import { useNow } from '@/hooks/useNow';
import type { RootStackParamList } from '@/navigation/types';
import { usePairedContext } from '@/store/useCoupleStore';

export function CourtHomeScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { userId, coupleId } = usePairedContext();
  const cases = useCases(coupleId);
  const now = useNow(1000);

  const { open, closed } = useMemo(() => {
    const list = cases.data ?? [];
    return {
      open: list.filter((c) => casePhase(c, now) !== 'JUDGED'),
      closed: list.filter((c) => casePhase(c, now) === 'JUDGED'),
    };
  }, [cases.data, now]);

  return (
    <Screen
      title="Mahkeme"
      subtitle="İki taraf da dinlenmeden karar çıkmaz."
      refreshing={cases.isRefetching}
      onRefresh={() => void cases.refetch()}
    >
      <AppButton label="⚖️  Dava aç" variant="court" onPress={() => nav.navigate('NewCase')} />
      <ErrorBanner error={cases.error} onRetry={() => void cases.refetch()} />

      {cases.isPending ? (
        <LoadingView />
      ) : (cases.data?.length ?? 0) === 0 ? (
        <>
          <SectionTitle>Dosyalar</SectionTitle>
          <EmptyState emoji="🕊️" title="Henüz dava yok" body="Huzurlu bir ilişki ya da bastırılmış hisler. Hangisi?" />
        </>
      ) : (
        <>
          {open.length > 0 ? <SectionTitle>Açık dosyalar</SectionTitle> : null}
          {open.map((c) => (
            <CaseCard key={c.id} item={c} userId={userId} now={now} onPress={() => nav.navigate('Verdict', { caseId: c.id })} />
          ))}
          {closed.length > 0 ? <SectionTitle>Karara bağlananlar</SectionTitle> : null}
          {closed.map((c) => (
            <CaseCard key={c.id} item={c} userId={userId} now={now} onPress={() => nav.navigate('Verdict', { caseId: c.id })} />
          ))}
        </>
      )}
    </Screen>
  );
}
