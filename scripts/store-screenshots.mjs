#!/usr/bin/env node
/**
 * Captures the App Store / Google Play screenshot set from the running web build.
 *
 * It builds nothing itself. Start the app first, in another terminal:
 *
 *     npm run build && npx vite preview --port 4173
 *
 * then run:
 *
 *     node scripts/store-screenshots.mjs
 *
 * Playwright is deliberately NOT a dependency of this repository. Either install it
 * without touching package.json:
 *
 *     npm i --no-save playwright && npx playwright install chromium
 *
 * or reuse an existing install (the script also looks in /opt/node-tools/node_modules and in
 * PLAYWRIGHT_MODULE_DIR). Browsers come from PLAYWRIGHT_BROWSERS_PATH, falling back to
 * /opt/pw-browsers when that directory exists.
 *
 * Environment:
 *   PORT                     preview server port (default 4173)
 *   BASE_URL                 full app URL; overrides PORT (default http://127.0.0.1:$PORT/)
 *   OUT_DIR                  output directory (default ./store-screenshots, git-ignored)
 *   PROFILES                 comma list of: iphone, play, ipad (default iphone,play; ipad is opt-in because
 *                            the 1024px tablet layout is not store-ready yet, see docs/STORE_SUBMISSION.md)
 *   SHOT_TODAY               YYYY-MM-DD the app should believe it is, or "real" (default: one
 *                            week before the example trip starts, see below)
 *   PLAYWRIGHT_MODULE_DIR    directory containing node_modules/playwright (optional)
 *   PLAYWRIGHT_BROWSERS_PATH where the Chromium build lives
 *   HTTPS_PROXY              used by Chromium when set (127.0.0.1 and localhost bypass it)
 *   EXTRA_CA_CERT            PEM file of a TLS-inspecting proxy's CA to trust (pinned by public key;
 *                            used only when set)
 *
 * What it shows: guest mode (nothing is signed in) with the example trip the app seeds
 * for every new guest (createDemoTrip in src/data.js), driven through the real UI. The only
 * thing typed in is one journal note, because the Memories screen is empty until someone writes one.
 * No data is injected into localStorage and no network response is faked.
 *
 * The example trip has a fixed 2026 start date. Once that date has passed the app labels the
 * trip "TAMAMLANDI" and the screenshots would look stale, so by default the browser clock
 * starts a week before the trip starts (it keeps ticking in real time). SHOT_TODAY=real
 * disables that.
 *
 * Map tiles (tile.openstreetmap.org) and the forecast (api.open-meteo.com) are loaded for real.
 * If the machine cannot reach them the map shows its "Harita yüklenemedi" fallback and the
 * weather card stays hidden; the script warns, and those shots should be re-taken on a real network.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = process.env.PORT || '4173';
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}/`;
const OUT_DIR = resolve(process.env.OUT_DIR || './store-screenshots');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

// Pixel size = width x height x scale. Apple: 1290x2796 is accepted for 6.9" and 6.7"; iPad 13": 2048x2732.
// Google Play phone: 1080x1920 (9:16). Add a profile here to capture another size.
const PROFILES = {
  iphone: { name: 'iphone-1290x2796', width: 430, height: 932, scale: 3, mobile: true, expected: [1290, 2796] },
  play: { name: 'play-1080x1920', width: 360, height: 640, scale: 3, mobile: true, expected: [1080, 1920] },
  ipad: { name: 'ipad-2048x2732', width: 1024, height: 1366, scale: 2, mobile: true, expected: [2048, 2732] }
};
const selectedProfiles = (process.env.PROFILES || 'iphone,play').split(',').map((id) => id.trim()).filter(Boolean);
for (const id of selectedProfiles) if (!PROFILES[id]) fail(`Unknown profile "${id}". Choose from ${Object.keys(PROFILES).join(', ')}.`);

function fail(message) {
  console.error(`store-screenshots: ${message}`);
  process.exit(1);
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const dirs = [process.cwd(), process.env.PLAYWRIGHT_MODULE_DIR, '/opt/node-tools'].filter(Boolean);
  for (const dir of dirs) {
    try { return require(require.resolve('playwright', { paths: [dir, join(dir, 'node_modules')] })); } catch { /* try the next place */ }
  }
  try { return await import('playwright'); } catch { /* fall through */ }
  return fail('Playwright was not found. Run `npm i --no-save playwright` (do not commit it) or set PLAYWRIGHT_MODULE_DIR.');
}

// The example trip the app seeds for guests; its start date decides what "today" should be.
async function exampleTripStart() {
  const { createDemoTrip } = await import(pathToFileURL(resolve(import.meta.dirname, '../src/data.js')).href);
  return createDemoTrip().startDate;
}

async function fakeToday() {
  const setting = process.env.SHOT_TODAY;
  if (setting === 'real') return null;
  if (setting) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(setting)) fail('SHOT_TODAY must be YYYY-MM-DD or "real".');
    return new Date(`${setting}T09:30:00`);
  }
  const start = new Date(`${await exampleTripStart()}T09:30:00`);
  start.setDate(start.getDate() - 7);
  return start;
}

async function reachable(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(4000) })).ok; } catch { return false; }
}

function pngSize(file) {
  const buffer = readFileSync(file);
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

const warnings = [];
const warn = (message) => { warnings.push(message); console.warn(`  ! ${message}`); };

if (!(await reachable(BASE_URL))) {
  fail(`Nothing answers at ${BASE_URL}. Run \`npm run build && npx vite preview --port ${PORT}\` first (or set PORT / BASE_URL).`);
}
const playwright = await loadPlaywright();
const chromium = playwright.chromium;
const now = await fakeToday();

mkdirSync(OUT_DIR, { recursive: true });
for (const file of readdirSync(OUT_DIR)) if (/\.png$/.test(file)) rmSync(join(OUT_DIR, file));

// Behind a TLS-inspecting proxy Chromium does not trust the proxy's CA, so tiles and the forecast would
// fail. Rather than ignoring certificate errors, trust exactly that CA: EXTRA_CA_CERT (a PEM file) is
// pinned by its public key. The proxy is applied per context so that localhost bypasses it.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const extraCa = process.env.EXTRA_CA_CERT || '';
const launchArgs = ['--hide-scrollbars'];
if (extraCa) {
  const certificate = new X509Certificate(readFileSync(extraCa));
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  launchArgs.push(`--ignore-certificate-errors-spki-list=${spki}`);
}
const browser = await chromium.launch({ args: launchArgs, ...(proxy ? { proxy: { server: 'per-context' } } : {}) });

// ---------------------------------------------------------------- helpers

const visible = (selector) => `${selector}:visible`;

async function go(page, route) {
  // Settings has no bottom-nav tab on phones; it opens from the account button in the top bar.
  const target = route === 'settings' ? '#accountButton' : visible(`[data-route="${route}"]`);
  await page.locator(target).first().click();
  await page.locator(`.page.active[data-page="${route}"]`).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
}

// Scrolls so the element's top sits just below the sticky top bar and day tabs (when the layout has them).
async function scrollBelowStickyBars(page, find) {
  await page.evaluate((source) => {
    const element = new Function(`return (${source})()`)();
    if (!element) throw new Error('scroll target not found');
    const stuck = [...document.querySelectorAll('.topbar, .day-tabs-bar')]
      .filter((bar) => ['sticky', 'fixed'].includes(getComputedStyle(bar).position))
      .reduce((sum, bar) => sum + bar.getBoundingClientRect().height, 0);
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - stuck - 12);
  }, find.toString());
}

async function settle(page, ms = 350) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(ms);
}

// Waits for the route map to finish drawing; reports whether OpenStreetMap tiles actually arrived.
async function waitForMap(page) {
  await page.locator('#routeMap.leaflet-container, #routeMap .map-empty').first().waitFor({ timeout: 10000 });
  const outcome = await page.waitForFunction(() => {
    if (document.querySelector('#routeMap .leaflet-tile-loaded')) return 'tiles';
    const fallback = document.querySelector('#routeMap .map-fallback');
    if (fallback && !fallback.hidden) return 'fallback';
    return false;
  }, null, { timeout: 12000 }).then((handle) => handle.jsonValue()).catch(() => 'fallback');
  if (outcome === 'tiles') await page.waitForTimeout(600); // let the remaining tiles of the viewport paint
  return outcome;
}

// Waits until the weather card either shows a forecast or was hidden because none could be loaded.
async function waitForWeather(page) {
  return page.waitForFunction(() => {
    const card = document.querySelector('#tripWeatherCard');
    if (!card || card.hidden) return 'hidden';
    if (!card.querySelector('.weather-days')) return false;
    // Open-Meteo sometimes answers with nulls, which the card renders as "0° / 0°"; that is not a forecast worth shipping.
    return card.textContent.includes('0° / 0°') ? 'bad' : 'forecast';
  }, null, { timeout: 12000 }).then((handle) => handle.jsonValue()).catch(() => 'hidden');
}

// A screenshot is only worth keeping when nothing transient is on screen.
async function assertClean(page, { modal = null } = {}) {
  const state = await page.evaluate(() => ({
    toast: Boolean(document.querySelector('#toast.show')),
    toastText: document.querySelector('#toast span')?.textContent || '',
    openModals: [...document.querySelectorAll('.modal.open')].map((element) => element.id),
    loading: Boolean(document.querySelector('#loadingOverlay.open')),
    offline: document.body.classList.contains('offline'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    sync: document.querySelector('#syncState em')?.textContent || ''
  }));
  const problems = [];
  if (state.toast) problems.push(`toast visible: "${state.toastText}"`);
  if (state.loading) problems.push('loading overlay is open');
  if (state.offline) problems.push('app thinks it is offline');
  if (state.overflowX) problems.push('page scrolls horizontally');
  if (/gerekli|eşitlenemedi|başlatılamadı|kaydedilemedi/i.test(state.sync)) problems.push(`sync status shows "${state.sync}"`);
  const expected = modal ? [modal.replace(/^#/, '')] : [];
  if (state.openModals.join() !== expected.join()) problems.push(`open modals: [${state.openModals}] but expected [${expected}]`);
  if (problems.length) throw new Error(problems.join('; '));
}

// ---------------------------------------------------------------- the shot list

// Each entry: file stem, Turkish caption for the store (kept in docs/STORE_SUBMISSION.md), and the UI steps.
// Steps run in order on one page, so later screens can rely on earlier ones (the journal note, for example).
const SHOTS = [
  {
    stem: '01-bugun',
    caption: 'Seyahatini kendi ritminde planla',
    async run(page) {
      await go(page, 'home');
      await page.locator('#activeTripCard .route-meta').waitFor();
    }
  },
  {
    stem: '02-ai-plan',
    caption: 'Şehri ve temponu söyle, planı birlikte çıkaralım',
    modal: '#plannerModal',
    async run(page) {
      await go(page, 'home');
      await page.locator(visible('[data-open="planner"]')).first().click();
      await page.locator('#plannerModal.open').waitFor();
      await page.fill('#plannerForm [name="destination"]', 'Lizbon');
      await page.selectOption('#plannerForm [name="days"]', '4');
      await page.locator('#plannerForm .choice-row label', { hasText: 'Yeme içme' }).click(); // the radio itself is visually hidden
      await page.fill('#plannerForm [name="note"]', 'İyi kahve, yürünebilir mahalleler.');
      await page.locator('#plannerForm [name="note"]').blur();
      // Typing in the note scrolled the sheet on short screens; show it from the top (city first).
      await page.evaluate(() => document.querySelectorAll('#plannerModal *').forEach((element) => { if (element.scrollTop) element.scrollTop = 0; }));
    },
    async after(page) {
      await page.keyboard.press('Escape');
      await page.locator('.modal.open').waitFor({ state: 'detached' }).catch(() => {});
    }
  },
  {
    stem: '03-rota',
    caption: 'Günü haritada gör, rotayı düzenle',
    async run(page, ctx) {
      await go(page, 'trips');
      await page.locator('.trip-card').first().click();
      await page.locator('.page.active[data-page="trip"] .trip-hero').waitFor();
      ctx.map = await waitForMap(page);
      ctx.weather = await waitForWeather(page);
      await scrollBelowStickyBars(page, () => document.querySelector('.readiness-pill'));
      await page.waitForTimeout(500); // tiles for the scrolled-to viewport
    }
  },
  {
    stem: '04-duraklar',
    caption: 'Kahvaltıdan akşam yemeğine her gün hazır',
    async run(page) {
      await scrollBelowStickyBars(page, () => document.querySelector('.itinerary-card'));
    }
  },
  {
    stem: '05-butce',
    caption: 'Hava durumu ve bütçen tek bakışta',
    async run(page, ctx) {
      // The weather card (Open-Meteo) sits right above the budget card; start at it only when it holds a real forecast.
      await scrollBelowStickyBars(page, ctx.weather === 'forecast'
        ? () => document.querySelector('#tripWeatherCard')
        : () => [...document.querySelectorAll('.trip-side-card')].find((element) => /BÜTÇE/.test(element.textContent)));
    }
  },
  {
    stem: '06-seyahatler',
    caption: 'Tüm seyahatlerin tek kütüphanede',
    async run(page) { await go(page, 'trips'); }
  },
  {
    stem: '07-anilar',
    caption: 'Günün sende bıraktığını sakla',
    async run(page) {
      // Memories is empty until a note exists, so write one through the real journal form.
      await go(page, 'memories');
      await page.locator(visible('[data-open="journal"]')).first().click();
      await page.locator('#journalModal.open').waitFor();
      await page.fill('#journalForm [name="title"]', 'Gianicolo’da gün batımı');
      await page.fill('#journalForm [name="body"]', 'Yokuşu taksiyle çıktık, yukarıda herkes sessizce şehre baktı. Akşam yemeğine yürüyerek indik.');
      await page.locator('#journalForm button[type="submit"]').click();
      await page.locator('.page.active[data-page="memories"] .journal-card').first().waitFor();
      await page.locator('#toast.show').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector('#toast.show'), null, { timeout: 6000 });
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  },
  {
    stem: '08-gizlilik',
    caption: 'Reklam takibi yok, konum erişimi yok',
    async run(page) {
      await go(page, 'settings');
      // Guests see: cloud sync, backup, Locals waitlist, "Gizlilik ve destek", AI consent. Start at the privacy card.
      await scrollBelowStickyBars(page, () => [...document.querySelectorAll('.settings-card')].find((card) => /Gizlilik ve destek/.test(card.textContent)));
    }
  }
];

// ---------------------------------------------------------------- run

const written = [];
let mapStatus = 'tiles';
let weatherStatus = 'forecast';
const consoleErrors = new Map();

try {
  for (const id of selectedProfiles) {
    const profile = PROFILES[id];
    console.log(`\n${profile.name}: ${profile.width}x${profile.height} @${profile.scale}x`);
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: profile.scale,
      isMobile: profile.mobile,
      hasTouch: true,
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      colorScheme: 'light',
      ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {})
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text().slice(0, 160);
      consoleErrors.set(text, (consoleErrors.get(text) || 0) + 1);
    });
    // Start the page clock at the pretend date but let it keep ticking: a frozen Date (setFixedTime)
    // stops Leaflet's tile fade-in and the map stays blank.
    if (now) await page.clock.install({ time: now });
    // Smooth scrolling and transitions would make captures race the animation.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}';
        document.head.appendChild(style);
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'load' });
    await page.locator('#activeTripCard .route-meta').waitFor({ timeout: 15000 });
    // The guest banner and sync label settle once the example trip has been loaded.
    await page.waitForFunction(() => document.querySelector('#syncState em')?.textContent === 'Bu cihazda', null, { timeout: 8000 });

    const ctx = {};
    for (const shot of SHOTS) {
      try {
        await shot.run(page, ctx);
        await settle(page);
        if (pageErrors.length) throw new Error(`page error: ${pageErrors.join(' | ')}`);
        await assertClean(page, { modal: shot.modal });
        const file = join(OUT_DIR, `${shot.stem}-${profile.name}.png`);
        await page.screenshot({ path: file });
        const [w, h] = pngSize(file);
        if (w !== profile.expected[0] || h !== profile.expected[1]) throw new Error(`wrote ${w}x${h}, expected ${profile.expected.join('x')}`);
        written.push(file);
        console.log(`  ok  ${shot.stem}  ${w}x${h}`);
        await shot.after?.(page);
      } catch (error) {
        await page.screenshot({ path: join(OUT_DIR, `FAILED-${shot.stem}-${profile.name}.png`) }).catch(() => {});
        throw new Error(`${profile.name} / ${shot.stem}: ${error.message}`);
      }
    }
    if (ctx.map === 'fallback') mapStatus = 'fallback';
    if (ctx.weather !== 'forecast') weatherStatus = ctx.weather;
    await context.close();
  }
} finally {
  await browser.close();
}

if (mapStatus !== 'tiles') warn('OpenStreetMap tiles did not load: the route map shows its "Harita yüklenemedi" fallback. Re-shoot 03-rota on a machine with internet access.');
if (weatherStatus !== 'forecast') warn(weatherStatus === 'bad' ? 'Open-Meteo answered with empty values (the card shows 0° / 0°); 05-butce starts at the budget card instead. Re-shoot when it returns a real forecast.' : 'Open-Meteo did not answer: the weather card is hidden. Re-shoot 05-butce with internet access if you want the forecast in it.');
if (consoleErrors.size) {
  console.log('\nBrowser console errors seen (informational):');
  for (const [text, count] of consoleErrors) console.log(`  x${count}  ${text}`);
}
console.log(`\n${written.length} screenshots written to ${OUT_DIR}`);
if (warnings.length) console.log(`${warnings.length} warning(s) above.`);
