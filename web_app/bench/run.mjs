#!/usr/bin/env node
// Repeatable measurement of the planner on a fixed synthetic dataset (or, read-only, on
// real exports). For every measured day, in two modes (LNS off, and the default run of the
// "Запустить оптимизатор" button): open tasks of the day, the lower bound, walking, overtime,
// time per stage, rule violations. Exit code 1 on any of:
//   - a rule violation (planWindow's own, or validatePlan over day-2 .. day+2)
//   - open tasks below the lower bound (a bug: the bound is a proof)
//   - a search cut by the clock (timeCut: the run would not be reproducible)
//   - unusable tasks in the input (the generator or the data is broken)
//   - open tasks of a day above the baseline by more than the tolerance (default: the larger
//     of +2 and +5 %). Time is shown but never compared.
//
//   node bench/run.mjs [--days 3] [--seed 1] [--people 100] [--tasks-min 400 --tasks-max 700]
//        [--modes lns0,default] [--out result.json] [--baseline bench/baseline.json]
//        [--update-baseline] [--tol-abs 2] [--tol-pct 5] [--island]
//   BENCH_REAL_DIR=/path/with/the/CSV/files node bench/run.mjs [--days 3] [--dates a,b,c]
//        (real data: nothing is saved, no baseline; --out, --baseline and --update-baseline refused)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planWindow, planMetrics, validatePlan, setPolicy, DEFAULT_POLICY } from '../src/optimizer.js';
import { createDistanceResolver } from '../src/utils/travelGraph.js';
import { parseCsvCollections } from '../src/utils/dataParser.js';
import { addDays } from '../src/utils/tz.js';
import { generate, GENERATOR_VERSION } from './synthetic.mjs';
import { parseArgs, num, table, hashAssignments, readRealDir } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), ['update-baseline', 'island', 'quiet']);
const REAL_DIR = process.env.BENCH_REAL_DIR || '';
const real = REAL_DIR !== '';
if (real && (args.out || args.baseline || args.updateBaseline)) {
  console.error('BENCH_REAL_DIR is set: real data is never saved or compared (--out, --baseline, --update-baseline are refused)');
  process.exit(2);
}
const MODES = String(args.modes ?? 'lns0,default').split(',').filter(Boolean);
for (const m of MODES) if (!['lns0', 'default'].includes(m)) { console.error(`unknown mode ${m} (lns0, default)`); process.exit(2); }
// The default run is the button's (200 LNS attempts); only the clock's safety net is widened, so that
// a slow machine does not turn a bench into a different, time-cut result.
const SAFETY_NET_MS = 120000;
const TOL_ABS = num(args.tolAbs, 2), TOL_PCT = num(args.tolPct, 5);

// ── the data ────────────────────────────────────────────────────────────────
let data, config, notes = [];
if (real) {
  const { files, locations, edges, notes: n } = await readRealDir(REAL_DIR);
  notes = n;
  const loaded = parseCsvCollections(files);
  const resolver = locations.length && edges.length ? createDistanceResolver({ locations, travelEdges: edges }) : null;
  const perDay = {};
  for (const t of loaded.tasks) perDay[t.date] = (perDay[t.date] || 0) + 1;
  const wanted = args.dates ? String(args.dates).split(',')
    : Object.keys(perDay).filter(d => (loaded.staffDB[d]?.length ?? 0) > 0 && (loaded.staffDB[addDays(d, -1)]?.length ?? 0) > 0 && (loaded.staffDB[addDays(d, 1)]?.length ?? 0) > 0)
      .sort((a, b) => perDay[b] - perDay[a]).slice(0, num(args.days, 3)).sort();
  data = { tasks: loaded.tasks, staffDB: loaded.staffDB, resolver, dates: wanted, meta: { real: true } };
  config = { real: true, days: wanted.length };
  console.log(`real data: ${loaded.tasks.length} tasks, ${wanted.length} day(s) measured; load warnings: ${loaded.loadReport.warnings.length}`);
} else {
  config = {
    seed: num(args.seed, 1), days: num(args.days, 3), people: num(args.people, 100),
    tasksMin: num(args.tasksMin, 400), tasksMax: num(args.tasksMax, 700), island: Boolean(args.island),
  };
  data = generate(config);
  console.log(`synthetic data (generator v${GENERATOR_VERSION}): seed ${config.seed}, ${data.tasks.length} tasks over ${data.allDates.length} days, measured ${data.dates.join(', ')}`);
}
for (const n of notes) console.log('note: ' + n);

// ── the run ─────────────────────────────────────────────────────────────────
setPolicy(DEFAULT_POLICY);
const results = [];
const problems = [];
for (const day of data.dates) {
  const win = [addDays(day, -1), day, addDays(day, 1)];
  const ext = [addDays(day, -2), ...win, addDays(day, 2)];
  for (const mode of MODES) {
    const t0 = performance.now();
    const r = planWindow(data.tasks, data.staffDB, day, data.resolver, win, mode === 'lns0' ? { lnsIterations: 0 } : { lnsBudgetMs: SAFETY_NET_MS });
    const wall = Math.round(performance.now() - t0);
    const s = r.stats;
    const m = planMetrics(r.tasks, data.staffDB, day, data.resolver, [day]);
    const check = validatePlan(r.tasks, data.staffDB, day, data.resolver, ext);
    const row = {
      day, mode, tasksDay: s.tasksDay, openDay: s.openDay, lowerBound: s.lowerBound.bound, noEligible: s.lowerBound.noEligible,
      walkM: m.walkM, overtimeMin: m.overtimeMin, slackShortMin: m.slackShortMin, peopleUsed: m.peopleUsed,
      cost: Math.round(s.cost), openWindow: s.open.final, construction: s.construction,
      violations: s.violations.length + check.length, invalid: s.invalid.count, timeCut: s.timeCut,
      ms: { ...s.ms, total: wall }, hash: hashAssignments(r.tasks.filter(t => t.date === day)),
    };
    results.push(row);
    const tag = `${day} ${mode}`;
    if (row.violations > 0) problems.push(`${tag}: ${row.violations} rule violation(s): ${[...s.violations, ...check].slice(0, 3).map(v => v.code).join(', ')}`);
    if (row.lowerBound !== null && row.openDay < row.lowerBound) problems.push(`${tag}: open ${row.openDay} is below the lower bound ${row.lowerBound} (the bound or the count is wrong)`);
    if (row.timeCut) problems.push(`${tag}: a search was cut by the clock (timeCut), the result is not reproducible`);
    if (row.invalid > 0) problems.push(`${tag}: ${row.invalid} unusable task(s) in the input`);
    if (!args.quiet) console.log(`  done ${tag}: open ${row.openDay}/${row.tasksDay}, bound ${row.lowerBound}, ${wall} ms`);
  }
}

// ── the table ───────────────────────────────────────────────────────────────
const ms = x => (x == null ? '-' : String(x));
console.log('\n' + table(
  ['day', 'mode', 'tasks', 'open', 'bound', 'gap', 'walk,m', 'overt,min', 'slack-,min', 'viol', 'build', 'improve', 'lns', 'check', 'total ms'],
  results.map(r => [r.day, r.mode, r.tasksDay, r.openDay, r.lowerBound, r.lowerBound === null ? null : r.openDay - r.lowerBound,
    r.walkM, r.overtimeMin, r.slackShortMin, r.violations, ms(r.ms.build), ms(r.ms.improve), ms(r.ms.lns), ms(r.ms.check), r.ms.total]),
));
const sum = (mode, k) => results.filter(r => r.mode === mode).reduce((a, r) => a + r[k], 0);
for (const mode of MODES) {
  console.log(`${mode.padEnd(8)} total: open ${sum(mode, 'openDay')} of ${sum(mode, 'tasksDay')}, bound ${sum(mode, 'lowerBound')}, walk ${sum(mode, 'walkM')} m, overtime ${sum(mode, 'overtimeMin')} min, violations ${sum(mode, 'violations')}, time ${Math.round(results.filter(r => r.mode === mode).reduce((a, r) => a + r.ms.total, 0) / 1000)} s`);
}

// ── baseline ────────────────────────────────────────────────────────────────
const snapshot = () => ({
  version: 1, generator: GENERATOR_VERSION, config,
  days: Object.fromEntries(data.dates.map(day => [day, Object.fromEntries(results.filter(r => r.day === day).map(r => [r.mode, {
    tasksDay: r.tasksDay, openDay: r.openDay, lowerBound: r.lowerBound, walkM: r.walkM, overtimeMin: r.overtimeMin, cost: r.cost, hash: r.hash,
  }]))])),
});
if (args.out) {
  writeFileSync(args.out, JSON.stringify({ ...snapshot(), runs: results }, null, 2) + '\n');
  console.log(`result written to ${args.out}`);
}
const baselinePath = args.baseline === true ? join(HERE, 'baseline.json') : args.baseline;
if (args.updateBaseline) {
  if (problems.length > 0) { console.error('\nthe baseline is not updated: this run has problems (see below)'); }
  else {
    const path = baselinePath || join(HERE, 'baseline.json');
    writeFileSync(path, JSON.stringify(snapshot(), null, 2) + '\n');
    console.log(`baseline written to ${path}`);
  }
} else if (baselinePath) {
  if (!existsSync(baselinePath)) { console.error(`no baseline at ${baselinePath} (create it with --update-baseline)`); process.exit(2); }
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (base.generator !== GENERATOR_VERSION) {
    console.error(`the baseline is from generator v${base.generator}, this is v${GENERATOR_VERSION}: refresh it with --update-baseline`);
    process.exit(2);
  }
  const same = ['seed', 'people', 'tasksMin', 'tasksMax', 'island'].filter(k => base.config[k] !== config[k]);
  if (same.length > 0) {
    console.error(`the baseline was made with other settings (${same.map(k => `${k}: ${base.config[k]} -> ${config[k]}`).join(', ')}): compare like with like, or refresh with --update-baseline`);
    process.exit(2);
  }
  let compared = 0, changedHash = 0;
  const rows = [];
  for (const r of results) {
    const b = base.days[r.day]?.[r.mode];
    if (!b) continue;
    compared++;
    const allowed = Math.max(TOL_ABS, Math.ceil(b.openDay * TOL_PCT / 100));
    const delta = r.openDay - b.openDay;
    if (r.hash !== b.hash) changedHash++;
    rows.push([r.day, r.mode, b.openDay, r.openDay, (delta > 0 ? '+' : '') + delta, allowed, r.walkM - b.walkM, r.overtimeMin - b.overtimeMin, r.hash === b.hash ? 'same' : 'changed']);
    if (r.tasksDay !== b.tasksDay || r.lowerBound !== b.lowerBound) {
      problems.push(`${r.day} ${r.mode}: the input differs from the baseline's (tasks ${b.tasksDay} -> ${r.tasksDay}, bound ${b.lowerBound} -> ${r.lowerBound}): the generator or the data changed without a new generator version`);
    }
    if (delta > allowed) problems.push(`${r.day} ${r.mode}: open tasks ${b.openDay} -> ${r.openDay} (+${delta}), more than the allowed +${allowed}`);
  }
  console.log('\nagainst the baseline (open: before -> now, allowed rise, change in walk m / overtime min, assignments):');
  console.log(table(['day', 'mode', 'base', 'now', 'delta', 'allowed', 'walk d', 'overt d', 'plan'], rows));
  if (compared === 0) problems.push('nothing to compare: the baseline has none of these days or modes');
  console.log(`compared ${compared} run(s); ${changedHash} with different assignments (not a failure by itself)`);
}

if (problems.length > 0) {
  console.error('\nFAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nOK');
