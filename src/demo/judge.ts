// Deterministic, offline stand-in for the Gemini court. Produces the same
// shape the Edge Function writes (two personas, fault split summing to 100,
// one practical penalty) so every verdict UI path can be exercised.
// Clearly labelled as a demo — it does not read meaning from the pleas.

export interface DemoJudgeInput {
  title: string;
  category: string;
  prosecutor_plea: string;
  defendant_plea: string;
  defense_timed_out: boolean;
  prosecutorName: string;
  defendantName: string;
}

export interface DemoVerdict {
  verdict_judge: string;
  verdict_comedian: string;
  fault_ratio_prosecutor: number;
  fault_ratio_defendant: number;
  penalty: string;
}

/** FNV-1a 32-bit — stable across platforms, no crypto needed. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pick = <T,>(arr: readonly T[], seed: number): T => arr[seed % arr.length]!;

const PENALTIES: Record<string, readonly string[]> = {
  CHORES: [
    'bu hafta iki akşam bulaşığı tek başına yıkar ve makineyi boşaltır',
    'hafta sonu banyoyu baştan sona temizler, şarkı söylemek serbesttir',
  ],
  PLANS: [
    'bir sonraki buluşmaya 10 dakika erken gelir ve kahveleri ısmarlar',
    'bu haftanın akşam planını kendisi organize eder, rezervasyon dahil',
  ],
  COMMUNICATION: [
    'yarın akşam 15 dakika telefonsuz, yüz yüze sohbet eder',
    'bu hafta her gün bir kez "nasılsın?" diye gerçekten sorar ve cevabı dinler',
  ],
  MONEY: [
    'bu haftaki market alışverişinin listesini birlikte hazırlar ve sepeti taşır',
    'bir sonraki sinema biletlerini ve mısırı karşılar',
  ],
  FAMILY: [
    'bir sonraki aile ziyaretinde tatlıyı kendisi seçip götürür',
    'bu hafta karşı tarafın ailesine kısa ve içten bir mesaj atar',
  ],
  OTHER: [
    'bu akşam karşı tarafın seçtiği filmi itirazsız izler',
    'yarın sabah kahvaltıyı hazırlar, çay demlemek dahil',
  ],
};

const COMEDIAN = [
  'Bu dava aslında ilişkiniz hakkında değil, ikinizin de yorgun olduğu hakkında. Bir uyuyun, sonra yine kavga edersiniz.',
  'Davacı haklı olmak istiyor, davalı rahat bırakılmak istiyor. Tebrikler, ikiniz de aynı anda kaybettiniz.',
  'Tutanağa geçsin: bu kadar ayrıntılı iddia yazan biri bulaşığı da o hızla yıkabilirdi.',
  'Mahkeme olarak not düşüyoruz: ikinizin de savunması, birbirinize ne kadar değer verdiğinizi kanıtlıyor. İğrenç derecede tatlı.',
];

export function demoVerdict(input: DemoJudgeInput): DemoVerdict {
  const seed = hash32(`${input.title}|${input.prosecutor_plea}|${input.defendant_plea}`);
  let p = 30 + (seed % 41); // 30..70
  if (input.defense_timed_out) p -= 15; // silence weighs against the defendant
  p = Math.min(90, Math.max(10, p));
  const d = 100 - p;

  const heavier = d >= p ? input.defendantName : input.prosecutorName;
  const tie = p === d;
  const penaltyText = pick(PENALTIES[input.category] ?? PENALTIES.OTHER!, seed >>> 3);
  const penalty = tie ? `Kusur eşit: iki taraf da ${penaltyText}.` : `${heavier} ${penaltyText}.`;

  const defenseLine = input.defense_timed_out
    ? `Davalı ${input.defendantName}, kendisine tanınan süre içinde savunma vermemiş; mahkeme bu sessizliği lehine yorumlamamıştır.`
    : `Davalı ${input.defendantName}'in savunması dosyaya alınmış, iddiayla birlikte tartılmıştır.`;

  return {
    verdict_judge:
      `[DEMO HAKEM — yapay zekâ değildir] Gereği düşünüldü. Davacı ${input.prosecutorName}'in "${input.title}" ` +
      `konulu iddiası heyetçe incelenmiştir. ${defenseLine} ` +
      `Delillerin serbestçe takdiri neticesinde kusurun %${p} oranında davacıda, %${d} oranında davalıda ` +
      `olduğuna, kararın taraflara tefhimine oybirliğiyle hükmedilmiştir.`,
    verdict_comedian: pick(COMEDIAN, seed >>> 7),
    fault_ratio_prosecutor: p,
    fault_ratio_defendant: d,
    penalty,
  };
}
