# DuoSync

İki partner arasında kapalı devre (strictly 1-to-1) çalışan ilişki asistanı: AI Mahkemesi, Canlı Masa (ortak ajanda + checklist), Soğuma Odası, Soru Kasası ve pasif pil/durum senkronu.

| Katman | Teknoloji |
|---|---|
| Mobil | Expo SDK 57 · React Native 0.86 · TypeScript (strict) |
| Stil | NativeWind 4.2 (Tailwind 3) |
| State | Zustand (kimlik/çift) + TanStack Query v5 (sunucu verisi, offline persist) |
| Backend | Supabase: Postgres + RLS, Realtime, Edge Functions (Deno), pg_cron, pg_net, Vault |
| AI | Gemini Flash (`gemini-3.8-flash` varsayılan, `GEMINI_MODEL` ile değiştirilebilir) — structured JSON |

---

## Kurulum

### 1. Uygulama
```bash
npm install
cp .env.example .env      # SUPABASE_URL, ANON/PUBLISHABLE KEY, EAS project id
```

### 2. Supabase
```bash
npx supabase link --project-ref <ref>
npx supabase db push                          # iki migration

# Vault (SQL editöründe, bir kez — git'e girmesin diye migration'da değil):
#   select vault.create_secret('https://<ref>.supabase.co', 'duosync_project_url');
#   select vault.create_secret('<uzun-rastgele-dize>',       'duosync_internal_secret');

npx supabase secrets set \
  GEMINI_API_KEY=<key> \
  INTERNAL_WEBHOOK_SECRET=<vault'takiyle aynı dize> \
  GEMINI_MODEL=gemini-3.8-flash           # opsiyonel
# EXPO_ACCESS_TOKEN=<token>               # opsiyonel: Expo "enhanced push security"

npx supabase functions deploy ai-court-verdict send-push-notification
```
`supabase/config.toml` iki fonksiyon için `verify_jwt = false` ayarlar; kimlik doğrulama fonksiyon içinde yapılır (pg_net/pg_cron çağrıları kullanıcı JWT'si taşımaz).

### 3. Push bildirimleri
```bash
npx eas-cli@latest init                   # EAS project id → .env
npx eas-cli@latest build --profile development --platform android
```
Uzak push, Expo Go'da değil **development build**'de çalışır.

### 4. Çalıştırma
```bash
npx expo start --dev-client
```

---

## Doğrulama

| Komut | Kapsam | Sonuç |
|---|---|---|
| `npm run lint` | ESLint (`eslint-config-expo` + react-hooks kuralları, `exhaustive-deps` hata seviyesinde) | ✅ 0 bulgu |
| `npm run typecheck` | Tüm istemci kodu, `database.types.ts` ile RPC/tablo tipleri | ✅ 0 hata |
| `npm run test:db` | Migration'lar + RLS + iş kuralları + çiftler arası izolasyon, PGlite (WASM Postgres) üzerinde, Supabase rolleri/auth/vault/pg_net/pg_cron stub'lanarak | ✅ 43/43 |
| `deno test supabase/functions/_shared` | Verdict doğrulama, kusur normalizasyonu, prompt-injection çiti | ✅ 7/7 |
| `deno check supabase/functions/*/index.ts` | Edge Function tipleri | ✅ |
| `npx expo export --platform android` | Metro + NativeWind + Reanimated 4 + Hermes bundle | ✅ 4.1 MB `.hbc` |

CI (`.github/workflows/ci.yml`) bu kontrolleri her push ve PR'da çalıştırır.

Gerçek cihazda/emülatörde çalıştırılmadı; Realtime, push ve Gemini çağrıları canlı bir Supabase projesine karşı test edilmedi.

---

## Mimari

```
Client (Expo)                         Supabase
─────────────                         ────────
 RPC (SECURITY DEFINER) ───────────►  file_case · submit_defense · pair_with_code …
 SELECT (RLS)           ───────────►  is_couple_member(couple_id)
 Realtime (RLS-filtered)◄───────────  postgres_changes
                                        │ trigger (pg_net, commit sonrası)
                                        ▼
                                      Edge: ai-court-verdict ──► Gemini
                                      Edge: send-push-notification ──► Expo Push
                                        ▲
                                      pg_cron: release_due_messages (1 dk)
                                               court sweep (10 dk)
```

**Yazma modeli:** İş kuralı taşıyan her geçiş RPC üzerinden; istemcinin doğrudan yazabildiği yerler bilinçli olarak dar tutuldu (profil adı/avatar, plan başlık/yer/tarih, plan ekle/sil, soru silme, kendi push token'ı).

### Kritik iş kuralları nasıl uygulandı

| Kural | Uygulama | Test |
|---|---|---|
| 1-to-1 izolasyon | Tüm çift tablolarında `is_couple_member()` RLS; `couples` için kullanıcı başına tek satır (iki unique index + çapraz kolon trigger'ı + advisory lock) | 3. taraf C hiçbir şey göremiyor/yazamıyor |
| Savunma kilidi | `claim_case_for_verdict()` tek kapı: savunma yoksa ve 24 saat dolmadıysa **boş set** döner; LLM çağrılmaz. Satır kilidi ile atomik, ikinci worker boş alır | ✅ |
| 24 saat timeout | pg_cron sweep → claim varsayılan savunmayı yazar (`defense_timed_out=true`) → LLM | ✅ |
| JSON şeması + toplam 100 | Gemini `responseSchema` + sunucu tarafı doğrulama; toplam ≠ 100 ise orantılı ölçekleme; DB'de `CHECK (p + d = 100)` son savunma hattı | ✅ |
| Sessiz iptal | Alıcının SELECT politikası yalnız `status='SENT'`. PENDING→CANCELLED alıcı için görünmez satırdan görünmez satıra geçiş → Realtime olayı da yok. Push trigger'ı sadece PENDING→SENT'te | ✅ (push kuyruğu sayısı değişmiyor) |
| Pasif pil | `AppState` background/inactive→active geçişinde tek okuma + throttle (2 dk / %5). Arka plan görevi, listener, polling yok | — |
| Offline checklist | İstemci UUID'li öğeler, öğe başına LWW (`updated_at`), sunucuda satır kilitli atomik merge, saat kayması koruması (+1 dk tavan), tombstone silme; TanStack paused mutation + AsyncStorage persist ile yeniden başlatmaya dayanıklı | ✅ |

---

## Spec'ten sapmalar (gerekçeli)

| # | Spec | Uygulanan | Neden |
|---|---|---|---|
| 1 | `court_cases` UPDATE politikası: davacı **veya** davalı her kolonu güncelleyebilir | Doğrudan UPDATE kapalı; `submit_defense` RPC + verdict yalnız `service_role` | Spec hâliyle davacı `fault_ratio_*`/`verdict_*` alanlarını kendisi yazabiliyordu |
| 2 | Edge Function auth'suz; pleas **request body**'den alınıyor | Pleas DB'den okunur; kullanıcı JWT + taraf kontrolü veya internal secret | Spec hâliyle herkes herhangi bir `case_id` için sahte savunmayla karar üretip DB'ye yazdırabiliyordu |
| 3 | `is_couple_member` `SECURITY DEFINER`, `search_path` yok | `SET search_path = ''`, `STABLE`, `is_active` şartı | search_path hijack (Supabase advisor 0011) |
| 4 | `gemini-1.5-flash`, `?key=` query | `gemini-3.8-flash` (env ile), `x-goog-api-key` header, `systemInstruction` | 1.5 Flash 29.09.2025'te kapatıldı → 404. Query string'deki anahtar loglara düşer |
| 5 | `profiles`, `plans`, `pending_questions`, `delayed_messages`, `couples` için politika yok | Hepsi tanımlandı | RLS açık + politika yok = uygulama hiçbir şey okuyamaz |
| 6 | Eşleşme kodu: 6 rakam, süresiz | 6 karakter, 32'lik alfabe (0/O/1/I yok), 24 saat ömür, saatte 10 hatalı deneme sınırı | 10⁶ → 32⁶ ≈ 1.07×10⁹ arama uzayı; kaba kuvvete karşı |
| 7 | `push_token` `profiles` içinde | Ayrı `push_tokens`, yalnız sahibine görünür | Partner profili okuyabiliyor; Expo token'ını bilen o cihaza push atabilir |
| 8 | `user_b_id ON DELETE SET NULL` | `CASCADE` | SET NULL "aktif ama tek kişilik çift" bırakır, 1-to-1 değişmezini bozar |
| 9 | `UNIQUE(user_a_id, user_b_id)` | + `user_a_id` unique, `user_b_id` partial unique, çapraz trigger | Spec kısıtı bir kullanıcının birden çok çifte girmesini engellemiyordu |
| 10 | Checklist: tüm JSONB dizisi LWW | Öğe başına LWW, sunucu tarafı atomik merge RPC | Dizi bazında LWW'de iki kişi farklı maddeleri aynı anda işaretlerse biri kaybolur |
| 11 | Enum `case_status` | `DELIBERATING` eklendi | Atomik claim ve "öldü mü" (5 dk stale) tespiti için ara durum gerekli |
| 12 | `uuid-ossp` | `gen_random_uuid()` | PG13+ çekirdeğinde; eklenti gereksiz |
| 13 | Dizin yapısında olmayan dosyalar | `src/lib/`, `src/api/{auth,couple,keys,queryClient}.ts`, `src/hooks/{useCourt,usePlans,useBuffer,useNow,usePushRegistration}.ts`, `src/navigation/{types,navigationRef}.ts` | Modüler yapı korunarak eklendi |

## Kapsam dışı bırakılanlar

- **İstinaf (`APPEALED`)**: enum'da duruyor, akış tanımlanmadığı için UI/RPC yok.
- **Karar çarkı ("Ne yesek?")** ve **sessiz modu aşan acil alarm**: proje açıklamasında var, spec'te yok. Acil alarm iOS'ta Apple'ın *Critical Alerts* entitlement onayı, Android'de `USE_FULL_SCREEN_INTENT`/DND erişimi gerektirir — ayrı bir iş kalemi.
- **Ayrılma / eşleşmeyi bozma** akışı.

## Bilinen riskler

| Risk | Etki | Azaltma |
|---|---|---|
| NativeWind 4.2 + Reanimated 4 + RN 0.86 | Bundle derleniyor, ancak cihazda çalışma doğrulanmadı | İlk dev build'de tüm ekranları gez; sorun olursa NativeWind 5 RC veya StyleSheet |
| Soğuma odası gecikmesi | pg_cron 1 dk çözünürlük → mesaj en geç ~60 sn geç düşer | Kabul edilebilir; daha sıkı gerekiyorsa Supabase Queues |
| AsyncStorage'da oturum | Root'lu cihazda token okunabilir | SecureStore 2 KB limitine takılır; gerekirse AES anahtarı SecureStore'da + şifreli AsyncStorage deseni |
| Pil verisi tazeliği | Partner uygulamayı açmazsa veri bayatlar | UI "son görülme" gösterir, 6 saatten eski veriyi soluk çizer |
| Tek cihaz / kullanıcı | `push_tokens` PK = `user_id` | Çoklu cihaz gerekirse PK'yı `(user_id, token)` yap |
| LLM maliyeti | Kötüye kullanım | Davacı başına 24 saatte 5 dava; claim başına en çok 2 çağrı, dava başına toplam 5 deneme |
