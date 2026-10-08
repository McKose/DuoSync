// End-to-end smoke test of DuoSync demo mode in headless Chromium.
//
//   npx expo export --platform web --output-dir dist-web   (no Supabase env → demo mode)
//   python3 -m http.server 8099 --directory dist-web &
//   cd tests/e2e && npm install && node demo.e2e.mjs http://127.0.0.1:8099/ ./shots
//
// Exits non-zero on any failed step or any browser error. Set CHROME_PATH to
// use a local Chrome instead of the bundled @sparticuz/chromium.
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:8099/';
const OUT = process.argv[3] ?? './shots';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (await chromium.executablePath()),
  args: process.env.CHROME_PATH ? ['--no-sandbox'] : chromium.args,
  headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
// Sandboxed viewers make confirm() return false; dismiss every native dialog so
// destructive flows can only pass through the in-app confirm modal.
page.on('dialog', (d) => d.dismiss());

const results = [];
let n = 0;
const shot = async (name) => page.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until visible text appears anywhere on the page. */
async function waitText(text, timeout = 15000) {
  // textContent, not innerText: innerText applies CSS text-transform
  // (section titles are uppercase) and would never match the source copy.
  await page.waitForFunction((t) => window.__visibleText().includes(t), { timeout }, text);
}
/**
 * Click the innermost element containing `text`. Waits until its button is
 * enabled: a button that becomes enabled by the keystroke just typed may not
 * have re-rendered yet, and clicking a disabled button is a silent no-op.
 */
async function click(text) {
  await waitText(text);
  await page.waitForFunction(
    (t) => {
      const el = window.__leafWith(t);
      const target = el?.closest('[role="button"],[role="tab"],[role="radio"],[role="checkbox"],a,button') ?? el;
      return target && target.getAttribute('aria-disabled') !== 'true';
    },
    { timeout: 5000 },
    text,
  );
  const ok = await page.evaluate((t) => {
    const el = window.__leafWith(t);
    if (!el) return false;
    const target = el.closest('[role="button"],[role="tab"],[role="radio"],[role="checkbox"],a,button') ?? el;
    target.click();
    return true;
  }, text);
  if (!ok) throw new Error(`no clickable text: ${text}`);
  await sleep(300);
}
/** Header back button (React Navigation renders it with an aria-label). */
async function back() {
  const ok = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[role="button"],button,a')].filter((b) => {
      const l = (b.getAttribute('aria-label') ?? '').toLowerCase();
      return (l.includes('geri') || l.includes('back')) && b.offsetParent !== null;
    });
    btns.at(-1)?.click();
    return btns.length;
  });
  if (!ok) throw new Error('no back button');
  await sleep(500);
}
async function type(label, value) {
  const sel = `[aria-label="${label}"]`;
  await page.waitForSelector(sel, { timeout: 10000 });
  await page.click(sel, { clickCount: 3 });
  await page.type(sel, value);
}
async function step(name, fn) {
  try {
    await fn();
    results.push(`✓ ${name}`);
  } catch (e) {
    results.push(`✗ ${name}: ${e.message.split('\n')[0]}`);
    await shot(`FAIL-${name.replace(/\W+/g, '_')}`);
  }
}
const hasText = (t) => page.evaluate((x) => window.__visibleText().includes(x), t);

// In-page text helpers. Text inside <script>/<style>/<noscript> is excluded:
// a single-file build inlines the JS bundle into <body>, whose source code
// contains every UI string and would otherwise satisfy every text check.
await page.evaluateOnNewDocument(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  window.__visibleText = () => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !n.parentElement.closest('script,style,noscript,template') ? 1 : 2),
    });
    let out = '';
    while (w.nextNode()) out += w.currentNode.nodeValue;
    return out;
  };
  window.__leafWith = (t) =>
    [...document.querySelectorAll('body *')]
      .filter((e) => !SKIP.has(e.tagName) && !e.closest('script,style,noscript,template'))
      .filter((e) => e.childElementCount === 0 && e.textContent.trim().includes(t))
      .at(-1);
});

await page.goto(URL, { waitUntil: 'networkidle0' });

await step('boots with no database + demo banner', async () => {
  await waitText('DuoSync');
  await waitText('DEMO');
  await shot('login');
});

await step('sign up', async () => {
  await click('Hesabın yok mu? Kayıt ol');
  await type('Adın', 'Çağatay');
  await type('E-posta', 'test@example.com');
  await type('Şifre', 'demo1234');
  await click('Hesap oluştur');
  await waitText('Partnerini bağla');
  await shot('pairing');
});

await step('pair by creating a code (partner joins ~5s)', async () => {
  await click('Eşleşme kodu oluştur');
  await waitText('içinde geçerliliğini yitirir');
  await shot('code');
  await waitText('Canlı Masa', 15000);
  await sleep(800);
  await shot('dashboard');
});

await step('dashboard shows partner + seeded plan', async () => {
  await waitText('Deniz');
  await waitText('Cuma akşamı yemek');
  await waitText('%64');
});

await step('plan detail: toggle checklist + add item', async () => {
  await click('Cuma akşamı yemek');
  await waitText('Yapılacaklar');
  await click('Çiçek al');
  await page.waitForSelector('[role="checkbox"][aria-label="Çiçek al"][aria-checked="true"]', { timeout: 5000 });
  await type('Yeni madde', 'Pasta siparişi');
  await click('Ekle');
  await waitText('Pasta siparişi');
  await sleep(600);
  await shot('plan-detail');
  await back();
});

await step('court: defend seeded case → verdict', async () => {
  await click('Mahkeme');
  await waitText('Telefonun sürekli sessizde kalması');
  await shot('court-home');
  await click('Telefonun sürekli sessizde kalması');
  await type('Savunman', 'Toplantıdaydım, çıkar çıkmaz aradım.');
  await click('Savunmayı sun');
  await waitText('Ağır Ceza Hâkimi', 15000);
  await waitText('Hüküm');
  await sleep(500);
  await shot('verdict');
  if (!(await hasText('DEMO HAKEM'))) throw new Error('verdict not labelled as demo');
  await back();
});

await step('court: file a case → partner defends → judged', async () => {
  await click('Dava aç');
  await type('Dava başlığı', 'Kumanda yine kayıp');
  await type('İddian', 'Kumandayı her seferinde koltuğun arasına sıkıştırıyor.');
  await click('Davayı aç');
  await waitText('Kumanda yine kayıp');
  await waitText('Ağır Ceza Hâkimi', 20000);
  await shot('verdict-2');
  await back();
});

await step('cooling-off: schedule then silently cancel', async () => {
  await click('Soğuma');
  await type("Deniz'e mesaj", 'Şu an çok sinirliyim!');
  await click('15 dk');
  await click('Soğumaya bırak');
  await waitText('Vazgeç, gönderme');
  await shot('cooling-pending');
  await click('Vazgeç, gönderme');
  await waitText('bu mesajın varlığından hiç haberdar olmayacak'); // in-app confirm modal
  await shot('cooling-confirm');
  await click('Geri çek');
  await waitText('Geri çekildi');
  await shot('cooling-cancelled');
});

await step('questions vault: answer partner question', async () => {
  await click('Kasa');
  await waitText('Pazar günü annemlere');
  await click('Cevapla →');
  await type('Cevabın', 'Olur, 12 gibi çıkalım.');
  await click('Cevapla');
  await waitText('Olur, 12 gibi çıkalım.');
  await shot('vault');
});

await step('demo panel: partner sends + silently cancels → no trace', async () => {
  await click('Kontrol paneli');
  await waitText('Ortam');
  await shot('demo-panel');
  await click('Deniz soğuma mesajı yazsın');
  await click('Deniz bekleyen mesajını geri çeksin');
  await sleep(16000); // past the 15 "min" (=15 s) window
  await back();
  await click('Soğuma');
  await sleep(800);
  if (await hasText('Biraz kırıldım')) throw new Error('cancelled partner message leaked to recipient');
});

await step('offline simulation shows banner', async () => {
  await click('Kontrol paneli');
  await page.click('[aria-label="Çevrimdışı simülasyonu"]');
  await waitText('Çevrimdışısın');
  await shot('offline');
  await page.click('[aria-label="Çevrimdışı simülasyonu"]');
});

console.log(results.join('\n'));
console.log(errors.length ? `\nBrowser errors (${errors.length}):\n${[...new Set(errors)].join('\n')}` : '\nNo browser errors.');
await browser.close();
const failed = results.filter((r) => r.startsWith('✗')).length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
// expo-notifications warns on web that push listeners are unsupported; that
// is expected (push is disabled in demo mode) and not an app error.
if (failed || errors.length) process.exit(1);
