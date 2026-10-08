import { Text, View } from 'react-native';

interface Props {
  leftLabel: string;
  leftValue: number;
  rightLabel: string;
  rightValue: number;
}

/** Two-sided fault split; values are already validated to sum to 100. */
export function FaultBar({ leftLabel, leftValue, rightLabel, rightValue }: Props) {
  return (
    <View
      accessible
      accessibilityLabel={`Kusur oranı: ${leftLabel} yüzde ${leftValue}, ${rightLabel} yüzde ${rightValue}`}
    >
      <View className="mb-1.5 flex-row justify-between">
        <Text className="text-sm font-semibold text-ink">
          {leftLabel} <Text className="text-rose">%{leftValue}</Text>
        </Text>
        <Text className="text-sm font-semibold text-ink">
          <Text className="text-court">%{rightValue}</Text> {rightLabel}
        </Text>
      </View>
      <View className="h-4 flex-row overflow-hidden rounded-full bg-paper-sunk">
        <View className="bg-rose" style={{ flex: Math.max(leftValue, 0.0001) }} />
        <View className="w-[2px] bg-white" />
        <View className="bg-court" style={{ flex: Math.max(rightValue, 0.0001) }} />
      </View>
    </View>
  );
}
