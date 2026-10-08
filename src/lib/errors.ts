// Maps backend error codes (raised as P0001 messages by RPCs) and transport
// failures to user-facing Turkish copy.

const CODE_MESSAGES: Record<string, string> = {
  NOT_AUTHENTICATED: 'Oturumun sona ermiş. Lütfen tekrar giriş yap.',
  ALREADY_PAIRED: 'Zaten bir partnerle eşleşmişsin.',
  INVALID_CODE: 'Kod geçersiz ya da süresi dolmuş. Partnerinden yeni kod iste.',
  RATE_LIMITED: 'Çok fazla hatalı deneme. Bir saat sonra tekrar dene.',
  CODE_GENERATION_FAILED: 'Kod oluşturulamadı, tekrar dene.',
  NOT_PAIRED: 'Önce partnerinle eşleşmelisin.',
  DAILY_CASE_LIMIT: 'Bugünlük dava hakkın doldu (24 saatte 5). Biraz soğuyun 🙂',
  CASE_NOT_FOUND: 'Dava bulunamadı.',
  NOT_DEFENDANT: 'Bu davada savunma yapma yetkin yok.',
  DEFENSE_CLOSED: 'Bu davanın savunma aşaması kapandı.',
  DEFENSE_DEADLINE_PASSED: 'Savunma süresi doldu; heyet savunmasız karar verecek.',
  INVALID_DELAY: 'Bekleme süresi 15–60 dakika arasında olmalı.',
  TOO_LATE_TO_CANCEL: 'Çok geç — mesaj soğuma odasından çıkmış.',
  QUESTION_NOT_FOUND: 'Soru bulunamadı.',
  CANNOT_ANSWER_OWN: 'Kendi sorunu cevaplayamazsın.',
  ALREADY_ANSWERED: 'Bu soru zaten cevaplanmış.',
  PLAN_NOT_FOUND: 'Plan bulunamadı.',
  INVALID_ITEM_ID: 'Geçersiz liste öğesi.',
  INVALID_ITEM_TEXT: 'Liste öğesi 1–200 karakter olmalı.',
  INVALID_ITEM_TIMESTAMP: 'Geçersiz zaman bilgisi.',
  CHECKLIST_FULL: 'Bir plana en fazla 100 madde eklenebilir.',
};

const AUTH_MESSAGES: Array<[RegExp, string]> = [
  [/invalid login credentials/i, 'E-posta ya da şifre hatalı.'],
  [/email not confirmed/i, 'E-postanı henüz onaylamadın. Gelen kutunu kontrol et.'],
  [/user already registered/i, 'Bu e-posta ile zaten bir hesap var.'],
  [/password should be at least/i, 'Şifre en az 6 karakter olmalı.'],
  [/rate limit/i, 'Çok fazla deneme. Biraz sonra tekrar dene.'],
];

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const name = err instanceof Error ? err.name : '';
  return (
    /network request failed|failed to fetch|networkerror|timeout|ECONNRESET|ENOTFOUND/i.test(msg) ||
    name === 'FunctionsFetchError' ||
    name === 'AuthRetryableFetchError'
  );
}

export function errorCode(err: unknown): string | null {
  if (err instanceof AppError) return err.code;
  const msg = (err as { message?: unknown } | null)?.message;
  if (typeof msg === 'string' && msg in CODE_MESSAGES) return msg;
  return null;
}

export function toUserMessage(err: unknown): string {
  if (!err) return 'Bilinmeyen bir hata oluştu.';
  if (isNetworkError(err)) return 'Bağlantı yok. İnternetini kontrol edip tekrar dene.';
  const code = errorCode(err);
  if (code) return CODE_MESSAGES[code] ?? code;
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === 'string') {
    for (const [re, text] of AUTH_MESSAGES) if (re.test(msg)) return text;
    if (/row-level security|permission denied/i.test(msg)) return 'Bu işlem için yetkin yok.';
    if (/violates check constraint/i.test(msg)) return 'Girilen değer geçersiz (uzunluk ya da biçim).';
  }
  return 'Bir şeyler ters gitti. Tekrar dene.';
}

type Result = { data: unknown; error: unknown };
/** The `data` type of the success branch of a supabase-js result union. */
type SuccessData<R extends Result> = Extract<R, { error: null }>['data'];

/**
 * Unwraps a supabase-js `{ data, error }` result, throwing on error.
 * Narrows to the success branch, so `.single()` / RPC results come back
 * non-null without casts.
 */
export function unwrap<R extends Result>(res: R): SuccessData<R> {
  if (res.error) throw res.error;
  return res.data as SuccessData<R>;
}
