import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Card, SectionTitle } from '@/components/common/StateViews';
import type { VerdictFields } from '@/lib/appeals';
import { formatDateTime } from '@/lib/time';
import { FaultBar } from './FaultBar';

interface Props {
  title: string;
  verdict: VerdictFields;
  prosecutor: string;
  defendant: string;
  /** The verdict that counts now (latest judged round). Older ones start collapsed. */
  current: boolean;
}

export function VerdictBody({ title, verdict: v, prosecutor, defendant, current }: Props) {
  const [open, setOpen] = useState(current);

  return (
    <View className="mt-2">
      <View className="mb-2 mt-5 flex-row items-center justify-between">
        <Text className="text-xs font-bold uppercase tracking-wider text-ink-mute">{title}</Text>
        <View className={`rounded-full px-2.5 py-1 ${current ? 'bg-sage-soft' : 'bg-paper-sunk'}`}>
          <Text className={`text-xs font-semibold ${current ? 'text-sage' : 'text-ink-mute'}`}>
            {current ? 'Geçerli karar' : 'Önceki karar'}
          </Text>
        </View>
      </View>
      <Card>
        <FaultBar
          leftLabel={prosecutor}
          leftValue={v.fault_ratio_prosecutor}
          rightLabel={defendant}
          rightValue={v.fault_ratio_defendant}
        />
      </Card>

      {open ? (
        <>
          <SectionTitle>⚖️ Ağır Ceza Hâkimi</SectionTitle>
          <Card className="border-l-4 border-court">
            <Text className="text-base leading-6 text-ink">{v.verdict_judge}</Text>
          </Card>

          <SectionTitle>🎤 Zabıt Kâtibinin Şerhi</SectionTitle>
          <Card className="border-l-4 border-rose">
            <Text className="text-base italic leading-6 text-ink">{v.verdict_comedian}</Text>
          </Card>
        </>
      ) : null}

      <SectionTitle>Hüküm</SectionTitle>
      <Card className={current ? 'bg-amber-soft' : 'bg-paper-sunk'}>
        <Text className="text-base font-semibold leading-6 text-ink">🧾 {v.penalty}</Text>
        <Text className="mt-2 text-xs text-ink-mute">Karar tarihi {formatDateTime(v.judged_at)}</Text>
      </Card>

      {current ? null : (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" hitSlop={8} className="self-start py-1">
          <Text className="text-sm font-semibold text-court">{open ? 'Gerekçeyi gizle' : 'Gerekçeyi göster'}</Text>
        </Pressable>
      )}
    </View>
  );
}
