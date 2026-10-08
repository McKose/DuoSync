import { ActivityIndicator, Pressable, Text } from 'react-native';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'court';

const VARIANT: Record<Variant, { box: string; text: string; spinner: string }> = {
  primary: { box: 'bg-rose', text: 'text-white', spinner: '#fff' },
  court: { box: 'bg-court', text: 'text-white', spinner: '#fff' },
  secondary: { box: 'bg-paper-sunk', text: 'text-ink', spinner: '#1B1A1F' },
  ghost: { box: 'bg-transparent', text: 'text-ink-soft', spinner: '#4A4852' },
  danger: { box: 'bg-danger-soft', text: 'text-danger', spinner: '#B3261E' },
};

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'sm';
  className?: string;
  accessibilityHint?: string;
}

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  size = 'md',
  className = '',
  accessibilityHint,
}: Props) {
  const v = VARIANT[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      accessibilityHint={accessibilityHint}
      className={`flex-row items-center justify-center rounded-xl2 ${
        size === 'sm' ? 'min-h-[36px] px-3' : 'min-h-[50px] px-5'
      } ${v.box} ${inactive ? 'opacity-50' : 'active:opacity-80'} ${className}`}
    >
      {loading ? (
        <ActivityIndicator color={v.spinner} />
      ) : (
        <Text className={`${size === 'sm' ? 'text-sm' : 'text-base'} font-semibold ${v.text}`}>{label}</Text>
      )}
    </Pressable>
  );
}
