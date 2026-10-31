import { unwrap } from '@/lib/errors';
import type { WheelOption, WheelSpin } from '@/types/database.types';
import { supabase } from './supabase';
import { demo, IS_DEMO } from '@/demo';

export async function listWheelOptions(coupleId: string): Promise<WheelOption[]> {
  if (IS_DEMO) return demo.listWheelOptions(coupleId);
  return unwrap(
    await supabase
      .from('wheel_options')
      .select('*')
      .eq('couple_id', coupleId)
      // Same order spin_wheel() snapshots, so the idle wheel matches the next spin.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  );
}

/** Newest first. */
export async function listWheelSpins(coupleId: string, limit = 10): Promise<WheelSpin[]> {
  if (IS_DEMO) return demo.listWheelSpins(coupleId, limit);
  return unwrap(
    await supabase
      .from('wheel_spins')
      .select('*')
      .eq('couple_id', coupleId)
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

export async function addWheelOption(label: string): Promise<WheelOption> {
  if (IS_DEMO) return demo.addWheelOption(label);
  return unwrap(await supabase.rpc('add_wheel_option', { p_label: label.trim() }));
}

export async function removeWheelOption(optionId: string): Promise<void> {
  if (IS_DEMO) return demo.removeWheelOption(optionId);
  unwrap(await supabase.rpc('remove_wheel_option', { p_option_id: optionId }));
}

/** The server draws and stores the result; the client only animates to it. */
export async function spinWheel(): Promise<WheelSpin> {
  if (IS_DEMO) return demo.spinWheel();
  return unwrap(await supabase.rpc('spin_wheel'));
}
