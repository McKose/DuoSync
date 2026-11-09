// Decision wheel ("Ne yesek?") — limits shared with the server
// (supabase/migrations/20261031000000_decision_wheel.sql) and the pure
// geometry both phones use to land on the same spot.
//
// Angles are degrees, clockwise from 12 o'clock, where the pointer sits.
// Segment i of n spans [i·360/n, (i+1)·360/n) on the unrotated wheel.

import type { WheelSpin } from '../types/database.types';

export const WHEEL_LABEL_MAX = 30;
export const WHEEL_MAX_OPTIONS = 12;
export const WHEEL_HISTORY = 20;
export const WHEEL_COOLDOWN_MS = 10_000;
/** Spin animation length; must stay below the cooldown so both phones finish first. */
export const WHEEL_SPIN_MS = 4_000;

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** option_labels (JSONB) as the segment list; non-strings are dropped defensively. */
export function spinLabels(spin: Pick<WheelSpin, 'option_labels'>): string[] {
  return Array.isArray(spin.option_labels)
    ? spin.option_labels.filter((l): l is string => typeof l === 'string')
    : [];
}

/** FNV-1a → [0, 1). Same input, same output on every device. */
function seedFraction(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 2 ** 32;
}

/**
 * Wheel rotation that puts segment `index` under the pointer. The offset
 * inside the segment comes from the spin id, so both phones stop on exactly
 * the same spot instead of always dead-centre.
 */
export function restingAngle(index: number, count: number, seed: string): number {
  const seg = 360 / count;
  const offset = (seedFraction(seed) - 0.5) * seg * 0.6;
  return mod(360 - (index + 0.5) * seg + offset, 360);
}

/** Absolute target from the current rotation: `turns` full turns, then on to `resting`. */
export function spinTarget(current: number, resting: number, turns = 5): number {
  return current + turns * 360 + mod(resting - mod(current, 360), 360);
}

/** Segment under the pointer at rotation `deg` (inverse of restingAngle). */
export function segmentAt(deg: number, count: number): number {
  return Math.floor(mod(-deg, 360) / (360 / count)) % count;
}
