import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { toUserMessage } from '@/lib/errors';

export function LoadingView({ label }: { label?: string }) {
  return (
    <View className="flex-1 items-center justify-center bg-paper py-16" accessibilityLiveRegion="polite">
      <ActivityIndicator size="large" color="#C8475B" />
      {label ? <Text className="mt-3 text-sm text-ink-mute">{label}</Text> : null}
    </View>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <View className="mb-4 flex-row items-center rounded-xl2 bg-danger-soft p-3" accessibilityRole="alert">
      <Text className="flex-1 text-sm text-danger">{toUserMessage(error)}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} accessibilityRole="button" className="ml-3 rounded-lg bg-white/70 px-3 py-1.5">
          <Text className="text-sm font-semibold text-danger">Tekrar dene</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({ emoji, title, body }: { emoji: string; title: string; body?: string }) {
  return (
    <View className="items-center rounded-xl2 border border-dashed border-paper-sunk px-6 py-10">
      <Text className="text-4xl">{emoji}</Text>
      <Text className="mt-3 text-center text-base font-semibold text-ink">{title}</Text>
      {body ? <Text className="mt-1 text-center text-sm text-ink-mute">{body}</Text> : null}
    </View>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <View className={`mb-3 rounded-xl2 bg-paper-raised p-4 shadow-sm ${className}`}>{children}</View>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text className="mb-2 mt-5 text-xs font-bold uppercase tracking-wider text-ink-mute">{children}</Text>;
}

export function Chip({
  label,
  selected,
  onPress,
  tone = 'rose',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  tone?: 'rose' | 'court' | 'sage';
}) {
  const on = { rose: 'bg-rose border-rose', court: 'bg-court border-court', sage: 'bg-sage border-sage' }[tone];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      aria-selected={selected}
      className={`mb-2 mr-2 rounded-full border px-3.5 py-2 ${selected ? on : 'border-paper-sunk bg-paper-raised'}`}
    >
      <Text className={`text-sm font-medium ${selected ? 'text-white' : 'text-ink-soft'}`}>{label}</Text>
    </Pressable>
  );
}
