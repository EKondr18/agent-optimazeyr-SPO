#!/usr/bin/env node
// Smoke test of the page in a real browser (Playwright), on synthetic files:
//   load the six CSV files (+ stands and the walking network) -> pick the day -> "Запустить
//   оптимизатор" -> open "Нехватка персонала" -> "Применить план" and confirm in the window.
// Checks: no console errors, no page errors, no failed requests, no toast saying "Не удалось" /
// "ошибка" / "error", no NaN / undefined / Infinity on the page, the day's task count equals the
// generator's, "Не назначено" never grows from applying the plan. The whole scenario runs in
// three browser timezones (UTC, Europe/Moscow, America/Los_Angeles): the numbers must be
// the same in all three (the shift day is the Moscow day). Stage times are printed.
//
//   node bench/ui-smoke.mjs [--tz UTC,Europe/Moscow,America/Los_Angeles] [--dist dir] [--no-build]
//        [--port 4184] [--headed] [--allow-no-plan]
// Environment: PLAYWRIGHT_CHROMIUM_PATH (browser binary; default /opt/pw-browsers/chromium if it
//   exists, else the one Playwright installed), PLAYWRIGHT_MODULE (path to the playwright module),
//   BENCH_UI_PORT (preview port), UI_SMOKE_OUT (where screenshots and the log go on failure).
// The page is built into a temporary folder (the project's dist is not touched) unless --dist is given.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate, toCsvFiles } from './synthetic.mjs';
import { parseArgs, num, table } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = parseArgs(process.argv.slice(2), ['headed', 'no-build', 'allow-no-plan']);
const TZS = String(args.tz ?? 'UTC,Europe/Moscow,America/Los_Angeles').split(',');
const OUT = process.env.UI_SMOKE_OUT || join(tmpdir(), 'spo-ui-smoke');
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'spo-ui-'));
const T0 = Date.now();
const say = m => console.log(`[${String(Math.round((Date.now() - T0) / 1000)).padStart(3)} s] ${m}`);

// ── Playwright ──────────────────────────────────────────────────────────────
async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright', 'playwright-core'].filter(Boolean);
  for (const t of tries) {
    try { return await import(t.startsWith('/') ? pathToFileURL(t).href : t); } catch { /* next */ }
  }
  throw new Error('Playwright not found: set PLAYWRIGHT_MODULE, or `npm install --no-save playwright` (see bench/README.md)');
}
const chromiumPath = () => {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
};

// ── the page: build, serve ──────────────────────────────────────────────────
const freePort = want => new Promise(resolve => {
  const s = createServer();
  s.once('error', () => { const t = createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => resolve(p)); }); });
  s.listen(want, '127.0.0.1', () => s.close(() => resolve(want)));
});
const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

let server = null;
async function startServer() {
  let dist = args.dist;
  if (!dist) {
    dist = join(work, 'dist');
    if (!args.noBuild) {
      say('building the page into a temporary folder');
      execFileSync(process.execPath, [vite, 'build', '--outDir', dist, '--emptyOutDir'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    }
  }
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`no built page at ${dist}`);
  const port = await freePort(num(args.port ?? process.env.BENCH_UI_PORT, 4184));
  server = spawn(process.execPath, [vite, 'preview', '--outDir', dist, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) { say(`preview on ${url} (pid ${server.pid}, built page: ${dist})`); return url; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('the preview server did not start');
}
const stopServer = () => { if (server && !server.killed) server.kill('SIGTERM'); };   // only our own process

// ── the data ────────────────────────────────────────────────────────────────
const data = generate({ seed: 5, days: 1, people: 28, tasksMin: 170, tasksMax: 170 });
const DAY = data.dates[0];
const EXPECTED_TASKS = data.tasks.filter(t => t.date === DAY).length;
const files = toCsvFiles(data);
const FILE_DIR = join(work, 'csv');
mkdirSync(FILE_DIR);
for (const [name, text] of Object.entries(files)) writeFileSync(join(FILE_DIR, name), text);
const SIX = ['tb_sub_orders.csv', 'tb_shifts.csv', 'tb_resources.csv', 'tb_res_qual.csv', 'tb_relation_resource_qualification.csv', 'tb_relation_shift_qualification.csv'];

// ── one scenario in one timezone ────────────────────────────────────────────
const BAD_TOAST = /не удалось|ошибк|error/i;
const BAD_TEXT = /\bNaN\b|\bundefined\b|\bInfinity\b/;

async function scenario(pw, url, tz) {
  const browser = await pw.chromium.launch({ headless: !args.headed, executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: tz, locale: 'ru-RU' });
  await ctx.addInitScript(() => {
    window.__toasts = [];
    const scan = () => document.querySelectorAll('.ant-message-notice, .ant-notification-notice').forEach(e => {
      const t = e.innerText.replace(/\s+/g, ' ').trim();
      if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
    });
    const start = () => new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  });
  const page = await ctx.newPage();
  const log = { console: [], page: [], requests: [] };
  page.on('console', m => { if (m.type() === 'error') log.console.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => log.page.push(String(e.message || e).slice(0, 300)));
  page.on('requestfailed', r => log.requests.push(`failed ${r.url().slice(0, 100)}`));
  page.on('response', r => { if (r.status() >= 400) log.requests.push(`${r.status()} ${r.url().slice(0, 100)}`); });

  const res = { tz, ms: {}, problems: [], tiles: {} };
  const problem = p => res.problems.push(p);
  const timed = async (name, fn) => { const t = Date.now(); try { return await fn(); } finally { res.ms[name] = Date.now() - t; } };
  const tiles = async () => {
    const list = await page.$$eval('.ant-statistic', els => els.map(e => ({
      title: (e.querySelector('.ant-statistic-title')?.innerText || '').replace(/\s+/g, ' ').trim(),
      value: (e.querySelector('.ant-statistic-content-value')?.innerText || '').replace(/\s+/g, ' ').trim(),
    })));
    const out = {};
    for (const t of list) out[t.title.split(' на ')[0].split(',')[0]] = t.value;
    return out;
  };
  const tileNumber = (map, start) => {
    const key = Object.keys(map).find(k => k.startsWith(start));
    if (key === undefined) return null;
    const n = parseFloat(map[key].replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const toasts = () => page.evaluate(() => window.__toasts.slice());
  const openCollapse = async text => {
    const header = page.locator('.ant-collapse-header', { hasText: text }).first();
    if ((await header.count()) === 0) throw new Error(`no section "${text}"`);
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
    return page.locator('.ant-collapse-item', { has: page.locator('.ant-collapse-header', { hasText: text }) }).first();
  };
  const shot = async name => { try { await page.screenshot({ path: join(OUT, `${name}-${tz.replace('/', '_')}.png`) }); } catch { /* ignore */ } };

  try {
    await page.goto(url, { waitUntil: 'load' });

    await timed('load', async () => {
      const csv = await openCollapse('Загрузить CSV вручную');
      const inputs = csv.locator('input[type=file]');
      if ((await inputs.count()) !== SIX.length) throw new Error(`expected ${SIX.length} file inputs in "Загрузить CSV вручную", found ${await inputs.count()}`);
      for (let i = 0; i < SIX.length; i++) await inputs.nth(i).setInputFiles(join(FILE_DIR, SIX[i]));
      const net = await openCollapse('Локации и сеть');
      const aux = net.locator('input[type=file]');
      if ((await aux.count()) >= 2) {
        await aux.nth(0).setInputFiles(join(FILE_DIR, 'tb_locations.csv'));
        await aux.nth(1).setInputFiles(join(FILE_DIR, 'travel_network.csv'));
      } else problem('the "Локации и сеть" section has fewer than two file inputs');
      await page.getByRole('button', { name: 'Загрузить', exact: true }).first().click();
      await page.waitForSelector('.ant-statistic', { timeout: 120000 });
    });

    await timed('pick the day', async () => {
      const select = page.locator('.ant-select').first();
      await select.click();
      const option = page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: DAY }).first();
      for (let i = 0; i < 40 && (await option.count()) === 0; i++) {
        await page.locator('.ant-select-dropdown:visible .rc-virtual-list-holder').first().evaluate(el => { el.scrollTop += 150; }).catch(() => {});
        await page.waitForTimeout(60);
      }
      if ((await option.count()) === 0) throw new Error(`the date ${DAY} is not in the date list`);
      await option.click();
      await page.waitForTimeout(600);
    });
    res.tiles.before = await tiles();
    if (args.debug) console.log('tiles before:', JSON.stringify(res.tiles.before), (await page.$$eval('.ant-statistic', els => els.slice(0, 2).map(e => e.outerHTML.slice(0, 500)))).join('\n'));
    res.tasksDay = tileNumber(res.tiles.before, 'Задач дня');
    res.shiftsAvailable = tileNumber(res.tiles.before, 'Доступно смены');
    await shot('1-loaded');

    await timed('run optimizer', async () => {
      await page.getByRole('button', { name: /Запустить оптимизатор/ }).click();
      await page.waitForFunction(() => {
        const t = [...document.querySelectorAll('.ant-statistic')].find(e => /Не назначено/.test(e.innerText));
        return t && /\d/.test(t.querySelector('.ant-statistic-content')?.innerText || '') && !document.querySelector('button.ant-btn-loading');
      }, null, { timeout: 240000 });
    });
    res.tiles.run = await tiles();
    res.openAfterRun = tileNumber(res.tiles.run, 'Не назначено');
    await shot('2-after-run');

    let applied = false;
    await timed('staffing gap', async () => {
      await openCollapse('Нехватка персонала');
      try {
        await page.waitForSelector('button:has-text("Применить план")', { timeout: 120000 });
        applied = true;
      } catch { /* handled below */ }
    });
    await shot('3-staffing-gap');
    if (!applied) {
      if (!args.allowNoPlan) problem('no "Применить план" button appeared in "Нехватка персонала" within 120 s');
    } else {
      await timed('apply plan', async () => {
        await page.locator('button:has-text("Применить план")').first().click();
        const dialog = page.locator('.ant-modal-confirm, .ant-modal').filter({ hasText: 'Применить' }).first();
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
        res.confirmText = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 160);
        await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
        await page.waitForFunction(() => window.__toasts.some(t => /План применён|план не применён|Не удалось/i.test(t)), null, { timeout: 120000 });
        await page.waitForTimeout(800);
      });
      res.tiles.after = await tiles();
      res.openAfterApply = tileNumber(res.tiles.after, 'Не назначено');
      await shot('4-after-apply');
      if (!(await toasts()).some(t => /План применён/.test(t))) problem(`the plan was not applied; toasts: ${(await toasts()).join(' | ').slice(0, 200)}`);
      if (res.openAfterApply !== null && res.openAfterRun !== null && res.openAfterApply > res.openAfterRun) {
        problem(`"Не назначено" grew after applying the plan: ${res.openAfterRun} -> ${res.openAfterApply}`);
      }
    }

    // ── checks on what was seen ──
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (BAD_TEXT.test(text)) problem(`the page shows "${text.match(BAD_TEXT)[0]}" (${text.slice(Math.max(0, text.search(BAD_TEXT) - 40), text.search(BAD_TEXT) + 40)})`);
    for (const [stage, map] of Object.entries(res.tiles)) {
      for (const [title, value] of Object.entries(map)) if (BAD_TEXT.test(value)) problem(`tile "${title}" after "${stage}" reads "${value}"`);
    }
    res.toasts = await toasts();
    for (const t of res.toasts) if (BAD_TOAST.test(t)) problem(`toast: ${t.slice(0, 160)}`);
    if (res.tasksDay !== EXPECTED_TASKS) problem(`"Задач дня" is ${res.tasksDay}, the data has ${EXPECTED_TASKS} on ${DAY}`);
    if (res.openAfterRun === null) problem('"Не назначено" is not a number after the run');
    for (const e of log.console) problem(`console error: ${e}`);
    for (const e of log.page) problem(`page error: ${e}`);
    for (const e of log.requests) problem(`request: ${e}`);
  } catch (e) {
    problem(`scenario stopped: ${String(e.message).split('\n')[0].slice(0, 300)}`);
    await shot('error');
  } finally {
    await browser.close();
  }
  return res;
}

// ── main ────────────────────────────────────────────────────────────────────
let exitCode = 0;
try {
  const pw = await loadPlaywright();
  const url = await startServer();
  say(`data: ${data.tasks.length} tasks in ${data.allDates.length} days, ${EXPECTED_TASKS} on ${DAY}`);
  const results = [];
  for (const tz of TZS) {
    say(`scenario in ${tz}`);
    const r = await scenario(pw, url, tz);
    results.push(r);
    say(`  ${r.problems.length === 0 ? 'ok' : 'PROBLEMS'}: ${Object.entries(r.ms).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(', ')}`);
  }
  const numbers = r => JSON.stringify([r.tasksDay, r.shiftsAvailable, r.openAfterRun, r.openAfterApply]);
  console.log('\n' + table(['timezone', 'day tasks', 'shifts', 'open after run', 'open after apply', 'load s', 'run s', 'gap s', 'apply s', 'problems'],
    results.map(r => [r.tz, r.tasksDay, r.shiftsAvailable, r.openAfterRun, r.openAfterApply ?? null,
      (r.ms.load / 1000).toFixed(1), (r.ms['run optimizer'] / 1000).toFixed(1), (r.ms['staffing gap'] / 1000).toFixed(1), r.ms['apply plan'] === undefined ? null : (r.ms['apply plan'] / 1000).toFixed(1), r.problems.length])));
  const problems = results.flatMap(r => r.problems.map(p => `[${r.tz}] ${p}`));
  if (new Set(results.map(numbers)).size > 1) {
    problems.push(`the numbers differ between timezones: ${results.map(r => `${r.tz} ${numbers(r)}`).join('; ')}`);
  }
  if (results[0]?.confirmText) console.log(`confirmation window: ${results[0].confirmText}`);
  if (problems.length > 0) {
    console.error('\nFAILED:\n  ' + problems.join('\n  '));
    writeFileSync(join(OUT, 'ui-smoke.log'), problems.join('\n') + '\n');
    console.error(`screenshots and the log: ${OUT}`);
    exitCode = 1;
  } else console.log('\nOK');
} catch (e) {
  console.error('ui-smoke could not run: ' + (e.stack || e.message));
  exitCode = 2;
} finally {
  stopServer();
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
