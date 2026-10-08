import { Pressable, Text, View } from 'react-native';
import type { ChecklistItem } from '@/types/database.types';

interface Props {
  item: ChecklistItem;
  onToggle: () => void;
  onRemove: () => void;
}

export function ChecklistItemRow({ item, onToggle, onRemove }: Props) {
  return (
    <View className="flex-row items-center border-b border-paper-sunk py-3">
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done }}
        accessibilityLabel={item.text}
        hitSlop={8}
        className="flex-1 flex-row items-center"
      >
        <View
          className={`mr-3 h-6 w-6 items-center justify-center rounded-md border-2 ${
            item.done ? 'border-sage bg-sage' : 'border-ink-mute bg-transparent'
          }`}
        >
          {item.done ? <Text className="text-xs font-bold text-white">✓</Text> : null}
        </View>
        <Text className={`flex-1 text-base ${item.done ? 'text-ink-mute line-through' : 'text-ink'}`}>{item.text}</Text>
      </Pressable>
      <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={`${item.text} maddesini sil`} hitSlop={10} className="pl-3">
        <Text className="text-lg text-ink-mute">×</Text>
      </Pressable>
    </View>
  );
}
