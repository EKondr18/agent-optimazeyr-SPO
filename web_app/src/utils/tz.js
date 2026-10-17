// The operating timezone of the airport's "shift day": Moscow, UTC+3, with no
// daylight-saving changes. Every place that turns a moment into a calendar day
// (the day a task or shift belongs to, the date picker, the planning window)
// goes through these helpers instead of the local-time Date methods, which
// follow the timezone of whatever runs the code — in UTC the same export put
// 13-16 % of its tasks on another day, and the browser and a backend would
// disagree about "the same day".
export const OPERATING_TZ = 'Europe/Moscow';
export const TZ_OFFSET_MS = 3 * 3600000;

const pad = n => String(n).padStart(2, '0');

// 'YYYY-MM-DD' of the Moscow day this moment falls in.
export function dayKey(d) {
  return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

// The moment a Moscow calendar day starts (its 00:00).
export function dayStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - TZ_OFFSET_MS);
}

// 'YYYY-MM-DD' shifted by whole days.
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Moscow wall-clock pieces of a moment.
export function wallClock(d) {
  const x = new Date(d.getTime() + TZ_OFFSET_MS);
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() };
}

export const fmtHM = d => { const w = wallClock(d); return `${pad(w.h)}:${pad(w.mi)}`; };
export const fmtDM = d => { const w = wallClock(d); return `${pad(w.d)}.${pad(w.mo)}`; };
export const fmtDMHM = d => `${fmtDM(d)} ${fmtHM(d)}`;

// Every 'YYYY-MM-DD' from `from` to `to`, inclusive.
export function daysBetween(from, to) {
  const out = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}
