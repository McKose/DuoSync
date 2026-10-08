import { Text, TextInput, View, type TextInputProps } from 'react-native';

interface Props extends Omit<TextInputProps, 'onChange'> {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  error?: string | null;
  /** Show "n/max" counter (requires maxLength). */
  counter?: boolean;
}

export function TextField({ label, value, onChangeText, error, counter, maxLength, multiline, ...rest }: Props) {
  return (
    <View className="mb-4">
      {label ? <Text className="mb-1.5 text-sm font-semibold text-ink-soft">{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        multiline={multiline}
        placeholderTextColor="#8C8994"
        accessibilityLabel={label}
        className={`rounded-xl2 border bg-paper-raised px-4 text-base text-ink ${
          multiline ? 'min-h-[110px] py-3' : 'h-[50px]'
        } ${error ? 'border-danger' : 'border-paper-sunk'}`}
        style={multiline ? { textAlignVertical: 'top' } : undefined}
        {...rest}
      />
      <View className="mt-1 flex-row justify-between">
        <Text className="flex-1 text-xs text-danger">{error ?? ''}</Text>
        {counter && maxLength ? (
          <Text className="text-xs text-ink-mute">
            {value.length}/{maxLength}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
