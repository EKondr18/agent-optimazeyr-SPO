// One color per qualification code, shared by every chart that groups by
// qualification (the Gantt, the hourly load chart, the call-in plan) so the
// same code reads the same everywhere.
//
// The colors come from the Okabe-Ito palette, which stays distinguishable for
// people with the common kinds of color-blindness. It has seven usable
// colors, so the seven most frequent codes get one each and everything else
// is lumped into a grey "Прочие": a hash over a longer palette gave different
// codes the same color and looked random.
export const OKABE_ITO = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442'];
export const OTHER_COLOR = '#7F7F7F';
export const OTHER_LABEL = 'Прочие';

const keyOf = t => t.reqType || '(без допуска)';

// Codes ordered by how many tasks need them (most first), ties alphabetical:
// a stable order, so the colors don't move around when the data is reshuffled.
export function rankQuals(tasks) {
  const count = new Map();
  for (const t of tasks) count.set(keyOf(t), (count.get(keyOf(t)) || 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([q]) => q);
}

// colorOf(code) for a ranking from rankQuals.
export function makeQualColors(order = []) {
  const rank = new Map(order.map((q, i) => [q, i]));
  const isOther = q => !(rank.has(q) && rank.get(q) < OKABE_ITO.length);
  return {
    isOther,
    colorOf: q => (isOther(q) ? OTHER_COLOR : OKABE_ITO[rank.get(q)]),
    keyOf,
  };
}

// Black or white text, whichever reads better on this fill.
export function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.35 ? '#000000' : '#ffffff';
}

// Legend rows for the codes present in `counts` (code -> number): the colored
// ones in rank order, then one grey "Прочие" row with the rest summed up.
export function legendItems(counts, qc, order = []) {
  const rank = new Map(order.map((q, i) => [q, i]));
  const colored = [];
  let otherCount = 0;
  const otherCodes = [];
  for (const [q, n] of counts) {
    if (qc.isOther(q)) { otherCount += n; otherCodes.push(q); } else colored.push({ label: q, color: qc.colorOf(q), count: n });
  }
  colored.sort((a, b) => rank.get(a.label) - rank.get(b.label));
  if (otherCodes.length) colored.push({ label: OTHER_LABEL, color: OTHER_COLOR, count: otherCount, title: otherCodes.join(', ') });
  return colored;
}
