#!/usr/bin/env node
// One input, one result. On a fixed synthetic day:
//   1. planWindow with the default settings twice in this process: the same assignments;
//   2. applyChanges with the default settings (a fixed batch of 20 changes, a fixed `now`)
//      twice: the same assignments;
//   3. the same two hashes in child processes under TZ=UTC, Europe/Moscow and
//      America/Los_Angeles: the Moscow day must not depend on the machine's zone.
// Exit 1 on any difference.
//
//   node bench/determinism.mjs                       the checks above
//   node bench/determinism.mjs --save [file]         also store the hashes (default bench/determinism.hashes.json)
//   node bench/determinism.mjs --check [file]        compare with stored hashes: for a change that must
//                                                    not alter any result (a speed-up): save BEFORE it,
//                                                    check AFTER. Stored hashes belong to one version of
//                                                    the code and generator; they are not committed.
//   node bench/determinism.mjs --hash-only           print the two hashes as JSON (used for the children)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planWindow, applyChanges, setPolicy, DEFAULT_POLICY } from '../src/optimizer.js';
import { addDays, dayStart } from '../src/utils/tz.js';
import { generate, rng, GENERATOR_VERSION } from './synthetic.mjs';
import { parseArgs, hashAssignments } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const args = parseArgs(process.argv.slice(2), ['hash-only', 'save', 'check']);
const CONFIG = { seed: 3, days: 1, people: 45, tasksMin: 200, tasksMax: 260 };

function compute() {
  setPolicy(DEFAULT_POLICY);
  const data = generate(CONFIG);
  const day = data.dates[0];
  const win = [addDays(day, -1), day, addDays(day, 1)];
  const plan = () => planWindow(data.tasks, data.staffDB, day, data.resolver, win, { lnsBudgetMs: 120000 });   // the safety net widened only
  const p1 = plan(), p2 = plan();
  // a batch of 20 in the future of `now` (08:00 Moscow): new tasks, moved, removed
  const now = new Date(dayStart(day).getTime() + 8 * 3600000);
  const rnd = rng(99);
  const future = p1.tasks.filter(t => t.date === day && t.start.getTime() >= now.getTime() + 3600000);
  const changes = [];
  for (let i = 0; i < 20 && future.length > 0; i++) {
    const t = future[Math.floor(rnd() * future.length)];
    const k = i % 4;
    if (k === 0) changes.push({ id: t.id, removed: true });
    else if (k === 1) changes.push({ id: t.id, start: new Date(t.start.getTime() + 30 * 60000), end: new Date(t.end.getTime() + 30 * 60000) });
    else if (k === 2) {
      const { employee, isLocked, ...fresh } = { ...t, id: 'NEW' + i, start: new Date(t.start.getTime() + 15 * 60000), end: new Date(t.end.getTime() + 15 * 60000) };
      changes.push(fresh);
    } else changes.push({ id: t.id, reqTypes: ['SPO_SV'], reqType: 'SPO_SV' });
  }
  const apply = () => applyChanges(p1.tasks, data.staffDB, day, data.resolver, win, changes, { now });
  const a1 = apply(), a2 = apply();
  return {
    plan: [hashAssignments(p1.tasks), hashAssignments(p2.tasks)],
    apply: [hashAssignments(a1.tasks), hashAssignments(a2.tasks)],
    detail: { open: p1.stats.openDay, openAfter: a1.tasks.filter(t => t.date === day && t.employee === 'Не назначено').length, changes: changes.length, timeCut: p1.stats.timeCut || p2.stats.timeCut || a1.timeCut || a2.timeCut },
  };
}

if (args.hashOnly) {
  const r = compute();
  console.log(JSON.stringify({ plan: r.plan[0], apply: r.apply[0], twice: r.plan[0] === r.plan[1] && r.apply[0] === r.apply[1] }));
  process.exit(0);
}

const problems = [];
const r = compute();
console.log(`generator v${GENERATOR_VERSION}, node ${process.version}, TZ ${process.env.TZ || '(system)'}`);
console.log(`planWindow   twice: ${r.plan[0]} ${r.plan[1]}  ${r.plan[0] === r.plan[1] ? 'same' : 'DIFFERENT'}   (open ${r.detail.open})`);
console.log(`applyChanges twice: ${r.apply[0]} ${r.apply[1]}  ${r.apply[0] === r.apply[1] ? 'same' : 'DIFFERENT'}   (${r.detail.changes} changes, open ${r.detail.openAfter})`);
if (r.plan[0] !== r.plan[1]) problems.push('planWindow: two runs of one input gave different plans');
if (r.apply[0] !== r.apply[1]) problems.push('applyChanges: two runs of one input gave different plans');
if (r.detail.timeCut) problems.push('a search was cut by the clock (timeCut): results depend on the speed of the machine');

for (const tz of ['UTC', 'Europe/Moscow', 'America/Los_Angeles']) {
  const out = JSON.parse(execFileSync(process.execPath, [SELF, '--hash-only'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  const same = out.plan === r.plan[0] && out.apply === r.apply[0] && out.twice;
  console.log(`TZ=${tz.padEnd(20)} plan ${out.plan} apply ${out.apply}  ${same ? 'same' : 'DIFFERENT'}`);
  if (!same) problems.push(`under TZ=${tz} the result differs: the Moscow day must not depend on the process timezone`);
}

const file = typeof args.save === 'string' ? args.save : typeof args.check === 'string' ? args.check : join(HERE, 'determinism.hashes.json');
const stored = { generator: GENERATOR_VERSION, config: CONFIG, plan: r.plan[0], apply: r.apply[0] };
if (args.save) {
  writeFileSync(file, JSON.stringify(stored, null, 2) + '\n');
  console.log(`hashes saved to ${file}`);
}
if (args.check) {
  if (!existsSync(file)) { console.error(`no stored hashes at ${file} (use --save first)`); process.exit(2); }
  const was = JSON.parse(readFileSync(file, 'utf8'));
  if (was.generator !== GENERATOR_VERSION || JSON.stringify(was.config) !== JSON.stringify(CONFIG)) {
    console.error('the stored hashes were made with another generator or settings: save them again');
    process.exit(2);
  }
  for (const k of ['plan', 'apply']) {
    const ok = was[k] === stored[k];
    console.log(`${k.padEnd(5)} stored ${was[k]} now ${stored[k]}  ${ok ? 'same' : 'DIFFERENT'}`);
    if (!ok) problems.push(`${k}: the result differs from the stored one`);
  }
}

if (problems.length > 0) {
  console.error('\nFAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nOK');
