import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform } from 'react-native';
import { qk } from '@/api/keys';
import { addWheelOption, listWheelOptions, listWheelSpins, removeWheelOption, spinWheel } from '@/api/wheel';
import { errorCode } from '@/lib/errors';
import { restingAngle, spinLabels, spinTarget, WHEEL_SPIN_MS } from '@/lib/wheel';
import type { WheelOption, WheelSpin } from '@/types/database.types';
import { useRealtimeSubscription } from './useRealtimeSubscription';

const SPIN_HISTORY_SHOWN = 10;

export function useWheelOptions(coupleId: string) {
  useRealtimeSubscription({
    name: 'wheel-options',
    table: 'wheel_options',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.wheelOptions(coupleId)],
  });
  return useQuery({ queryKey: qk.wheelOptions(coupleId), queryFn: () => listWheelOptions(coupleId) });
}

export function useWheelSpins(coupleId: string) {
  useRealtimeSubscription({
    name: 'wheel-spins',
    table: 'wheel_spins',
    filter: `couple_id=eq.${coupleId}`,
    invalidate: [qk.wheelSpins(coupleId)],
  });
  return useQuery({
    queryKey: qk.wheelSpins(coupleId),
    queryFn: () => listWheelSpins(coupleId, SPIN_HISTORY_SHOWN),
  });
}

export function useAddWheelOption(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => addWheelOption(label),
    onSuccess: (option) =>
      queryClient.setQueryData<WheelOption[]>(qk.wheelOptions(coupleId), (prev) =>
        prev?.some((o) => o.id === option.id) ? prev : [...(prev ?? []), option],
      ),
  });
}

export function useRemoveWheelOption(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (optionId: string) => removeWheelOption(optionId),
    onSuccess: (_v, optionId) =>
      queryClient.setQueryData<WheelOption[]>(qk.wheelOptions(coupleId), (prev) => prev?.filter((o) => o.id !== optionId)),
    onError: (err) => {
      // Partner removed it first: the list is stale, not the user's fault.
      if (errorCode(err) === 'OPTION_NOT_FOUND') void queryClient.invalidateQueries({ queryKey: qk.wheelOptions(coupleId) });
    },
  });
}

export function useSpinWheel(coupleId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: spinWheel,
    // Prepending the stored row is what starts the animation (useWheelAnimation),
    // exactly as a partner's spin arriving over Realtime does.
    onSuccess: (spin) =>
      queryClient.setQueryData<WheelSpin[]>(qk.wheelSpins(coupleId), (prev) =>
        [spin, ...(prev ?? []).filter((s) => s.id !== spin.id)].slice(0, SPIN_HISTORY_SHOWN),
      ),
  });
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduce(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const restOf = (spin: WheelSpin) => restingAngle(spin.result_index, spinLabels(spin).length, spin.id);

/**
 * Drives the wheel from the newest stored spin. The spin already on the
 * server when the screen opens is shown at rest; every newer one (mine via
 * the mutation, my partner's via Realtime) is animated. Landing position is
 * a pure function of the stored row, so both phones stop on the same spot.
 *
 * While idle the wheel shows that spin's snapshot only if it still matches
 * the current options; otherwise it shows the options at rotation 0, where
 * the pointer sits on a divider and points at nothing.
 */
export function useWheelAnimation(latest: WheelSpin | null, loaded: boolean, optionLabels: string[]) {
  const [rotation] = useState(() => new Animated.Value(0));
  const angle = useRef(0);
  // Ref, not state: an effect in the same commit must already see it, or its
  // setValue() would stop the animation that was just started.
  const animating = useRef(false);
  const seen = useRef<string | null | undefined>(undefined);
  const reduceMotion = useReduceMotion();
  const [shown, setShown] = useState<WheelSpin | null>(null);
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    if (seen.current === undefined) {
      seen.current = latest?.id ?? null;
      setShown(latest);
      return;
    }
    if (!latest || latest.id === seen.current) return;
    seen.current = latest.id;

    const target = spinTarget(angle.current, restOf(latest));
    angle.current = target;
    animating.current = true;
    setShown(latest);
    setSpinning(true);
    Animated.timing(rotation, {
      toValue: target,
      duration: reduceMotion ? 0 : WHEEL_SPIN_MS,
      easing: Easing.out(Easing.cubic),
      // react-native-web has no native driver; it would warn and fall back anyway.
      useNativeDriver: Platform.OS !== 'web',
    }).start(() => {
      animating.current = false;
      setSpinning(false);
    });
  }, [latest, loaded, reduceMotion, rotation]);

  const shownLabels = shown ? spinLabels(shown) : null;
  const showSnapshot = shownLabels !== null && (spinning || sameList(shownLabels, optionLabels));

  useEffect(() => {
    if (animating.current) return;
    // Same angle mod 360 as where the animation ended, so no visible jump.
    const next = showSnapshot && shown ? restOf(shown) : 0;
    angle.current = next;
    rotation.setValue(next);
  }, [showSnapshot, shown, spinning, rotation]);

  useEffect(() => () => rotation.stopAnimation(), [rotation]);

  return {
    rotation,
    labels: showSnapshot ? shownLabels : optionLabels,
    restAngle: showSnapshot && shown ? restOf(shown) : 0,
    shown,
    spinning,
  };
}
