// Small shared helpers of the bench scripts: argument parsing, hashing, a plain-text
// table, and the loader of a directory with real exports (read-only; nothing from it is
// ever written anywhere).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// --name value, --flag, --name=value
export function parseArgs(argv, flags = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (v !== undefined) out[key] = v;
    else if (flags.includes(k)) out[key] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}
export const num = (v, dflt) => (v === undefined || v === true || Number.isNaN(Number(v)) ? dflt : Number(v));

// 16 hex digits of the sha1 of "id:employee" lines in id order: one number for "the same plan".
export function hashAssignments(tasks) {
  const lines = tasks.map(t => `${t.id}:${t.employee}`).sort();
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export function table(headers, rows) {
  const cells = [headers, ...rows.map(r => r.map(c => (c === null || c === undefined ? '-' : String(c))))];
  const width = headers.map((_, i) => Math.max(...cells.map(r => r[i].length)));
  const line = r => r.map((c, i) => (i < 2 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ');
  return [line(cells[0]), width.map(w => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

// ── Real exports (BENCH_REAL_DIR) ───────────────────────────────────────────
const KINDS = {
  ordersCsv: /tb_sub_orders/i, shiftsCsv: /tb_shifts/i, resourcesCsv: /tb_resources/i, resQualCsv: /tb_res_qual/i,
  resourceQualificationsCsv: /tb_relation_resource_qualification/i, shiftQualificationsCsv: /tb_relation_shift_qualification/i,
};
const LOCATIONS = /tb_locations/i;
const NETWORK = /(VKO_TRANSPORT|travel_network|transport)/i;

// Picks one file per kind by name (the largest when several match) and reads it. Returns
// { files (text by kind), locations rows, edges rows, notes }. Notes never carry a file name.
export async function readRealDir(dir) {
  const names = readdirSync(dir);
  const notes = [];
  const pick = re => {
    const found = names.filter(n => re.test(n) && /\.(csv|xlsx?)$/i.test(n)).map(n => ({ n, size: statSync(join(dir, n)).size }));
    found.sort((a, b) => b.size - a.size);
    return found;
  };
  const files = {};
  for (const [kind, re] of Object.entries(KINDS)) {
    const found = pick(re).filter(f => /\.csv$/i.test(f.n));
    if (found.length === 0) throw new Error(`BENCH_REAL_DIR: no CSV matching ${re} in the directory`);
    if (found.length > 1) notes.push(`${kind}: ${found.length} candidates, the largest is used`);
    files[kind] = readFileSync(join(dir, found[0].n), 'utf8');
  }
  const Papa = (await import('papaparse')).default;
  const csvRows = text => Papa.parse(text.replace(/^﻿/, '').trim(), { header: true, skipEmptyLines: true, transformHeader: h => h.trim() }).data;
  let locations = [], edges = [];
  const loc = pick(LOCATIONS).filter(f => /\.csv$/i.test(f.n))[0];
  if (loc) locations = csvRows(readFileSync(join(dir, loc.n), 'utf8'));
  const net = pick(NETWORK)[0];
  if (net) {
    if (/\.csv$/i.test(net.n)) edges = csvRows(readFileSync(join(dir, net.n), 'utf8'));
    else {
      const XLSX = await import('xlsx');
      const wb = (XLSX.default ?? XLSX).read(readFileSync(join(dir, net.n)), { type: 'buffer' });
      edges = (XLSX.default ?? XLSX).utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    }
  }
  if (locations.length === 0 || edges.length === 0) notes.push('no travel network: the walk heuristic is used');
  return { files, locations, edges, notes };
}
