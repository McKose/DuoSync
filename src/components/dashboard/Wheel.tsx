import { Animated, StyleSheet, Text, View } from 'react-native';

// Plain Views + core Animated only (no SVG / Reanimated): nothing new to
// break on a device build. Each label and divider sits in a full-size layer
// rotated about the wheel centre, so no transform-origin support is needed.

const SEGMENT_COLORS = ['#C8475B', '#4F7A5B', '#2E3A59', '#C98A1E'];
const INK = '#1B1A1F';
const HUB = 34;
const DOT = 10;
const BORDER = 4;

interface Props {
  labels: string[];
  /** Clockwise degrees; the pointer is fixed at 12 o'clock. */
  rotation: Animated.Value;
  /** Rotation the wheel comes to rest at; labels are oriented for that pose. */
  restAngle: number;
  size: number;
}

export function Wheel({ labels, rotation, restAngle, size }: Props) {
  const half = size / 2;
  // Absolute children are laid out inside the border: their centre is c, not half.
  const c = half - BORDER;
  const seg = labels.length > 0 ? 360 / labels.length : 360;
  const rotate = rotation.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'] });
  const labelStart = HUB / 2 + 8;
  const labelEnd = c - DOT - 12;

  return (
    <View
      style={{ width: size, height: size + 10 }}
      accessibilityRole="image"
      accessibilityLabel={labels.length ? `Karar çarkı: ${labels.join(', ')}` : 'Karar çarkı boş'}
    >
      <Animated.View
        style={[styles.disc, { top: 10, width: size, height: size, borderRadius: half, transform: [{ rotate }] }]}
      >
        {labels.length > 1
          ? labels.map((_, i) => (
              <View key={`d${i}`} pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${i * seg}deg` }] }]}>
                <View style={[styles.divider, { left: c - 1, height: c }]} />
              </View>
            ))
          : null}
        {labels.map((label, i) => {
          const mid = (i + 0.5) * seg;
          // Ends up on the left half once at rest: turn it over so it never reads upside down.
          const flip = (((mid + restAngle) % 360) + 360) % 360 > 180;
          return (
            <View
              key={`l${i}`}
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${mid - 90}deg` }] }]}
            >
              <View
                style={{
                  position: 'absolute',
                  left: c + labelStart,
                  top: c - 11,
                  width: labelEnd - labelStart,
                  height: 22,
                  justifyContent: 'center',
                  transform: [{ rotate: flip ? '180deg' : '0deg' }],
                }}
              >
                <Text numberOfLines={1} style={[styles.label, { textAlign: flip ? 'left' : 'right' }]}>
                  {label}
                </Text>
              </View>
              <View
                style={[
                  styles.dot,
                  { left: 2 * c - DOT - 6, top: c - DOT / 2, backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length] },
                ]}
              />
            </View>
          );
        })}
        <View style={[styles.hub, { left: c - HUB / 2, top: c - HUB / 2 }]} />
      </Animated.View>
      <View pointerEvents="none" style={[styles.pointer, { left: half - 12 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  disc: {
    position: 'absolute',
    left: 0,
    backgroundColor: '#FFFFFF',
    borderWidth: BORDER,
    borderColor: INK,
    overflow: 'hidden',
  },
  divider: { position: 'absolute', top: 0, width: 2, backgroundColor: '#DED7CA' },
  label: { fontSize: 13, fontWeight: '600', color: INK },
  dot: { position: 'absolute', width: DOT, height: DOT, borderRadius: DOT / 2 },
  hub: {
    position: 'absolute',
    width: HUB,
    height: HUB,
    borderRadius: HUB / 2,
    backgroundColor: INK,
    borderWidth: 4,
    borderColor: '#FBF8F3',
  },
  pointer: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 12,
    borderRightWidth: 12,
    borderTopWidth: 22,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: INK,
    zIndex: 2,
  },
});
