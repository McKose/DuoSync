import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OfflineBanner } from './OfflineBanner';

interface Props {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  /** Wrap content in a ScrollView (default true). */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Omit top inset when a native header is already shown. */
  insetTop?: boolean;
  footer?: ReactNode;
}

export function Screen({
  title,
  subtitle,
  right,
  children,
  scroll = true,
  refreshing = false,
  onRefresh,
  insetTop = true,
  footer,
}: Props) {
  const insets = useSafeAreaInsets();
  const header =
    title || right ? (
      <View className="mb-4 flex-row items-end justify-between">
        <View className="flex-1 pr-3">
          {title ? <Text className="text-3xl font-bold text-ink">{title}</Text> : null}
          {subtitle ? <Text className="mt-1 text-sm text-ink-mute">{subtitle}</Text> : null}
        </View>
        {right}
      </View>
    ) : null;

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-paper"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ paddingTop: insetTop ? insets.top : 0 }}
    >
      <OfflineBanner />
      {scroll ? (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, paddingBottom: 40 + insets.bottom }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
          }
        >
          {header}
          {children}
        </ScrollView>
      ) : (
        <View className="flex-1 px-5 pt-5">
          {header}
          {children}
        </View>
      )}
      {footer ? <View style={{ paddingBottom: insets.bottom }}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}
