const pad = (n: number) => String(n).padStart(2, '0');

/** "1:05:09" / "04:59" countdown; clamps at 0. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'hiç';
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  if (diff < 45) return 'az önce';
  if (diff < 3600) return `${Math.round(diff / 60)} dk önce`;
  if (diff < 86_400) return `${Math.round(diff / 3600)} sa önce`;
  return `${Math.round(diff / 86_400)} gün önce`;
}

const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

/** "Cum 9 Eki · 20:00" — locale-independent (no reliance on Intl data). */
export function formatPlanDate(iso: string | null): string {
  if (!iso) return 'Tarih yok';
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Quick plan-date presets (local time). */
export function planDatePresets(now = new Date()): Array<{ label: string; value: string | null }> {
  const at = (base: Date, addDays: number, h: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + addDays);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  const tonight = at(now, 0, 20);
  const daysToSat = (6 - now.getDay() + 7) % 7 || 7;
  const presets: Array<{ label: string; value: string | null }> = [];
  if (tonight.getTime() > now.getTime()) presets.push({ label: 'Bu akşam', value: tonight.toISOString() });
  presets.push({ label: 'Yarın akşam', value: at(now, 1, 20).toISOString() });
  presets.push({ label: 'Cumartesi', value: at(now, daysToSat, 20).toISOString() });
  presets.push({ label: 'Tarihsiz', value: null });
  return presets;
}
