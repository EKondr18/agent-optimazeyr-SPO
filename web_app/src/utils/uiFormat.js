// Small text helpers for the interface. Pure functions, no React.

// Russian plural form: pluralRu(1, 'смена', 'смены', 'смен') -> 'смена',
// 2..4 -> 'смены', 5..20 and 0 -> 'смен', 21 -> 'смена', 22 -> 'смены'.
export function pluralRu(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// "22 смены", "1 смена" — the number together with the right word form.
export const countRu = (n, one, few, many) => `${n} ${pluralRu(n, one, few, many)}`;

// The export identifies a flight by a 24-digit hex id, unreadable in a row
// label or table cell. The last six characters are enough to tell flights of
// one day apart; the full id stays available in tooltips (title attributes).
const HEX_ID = /^[0-9a-f]{24}$/i;
export function shortFlight(flight) {
  const s = String(flight ?? '').trim();
  return HEX_ID.test(s) ? `…${s.slice(-6)}` : s;
}
// Short form, plus the full id in brackets when it was shortened (for tooltips).
export function flightWithFull(flight) {
  const s = String(flight ?? '').trim();
  const short = shortFlight(s);
  return short === s ? s : `${short} (${s})`;
}

// Secondary text colors that stay readable (WCAG AA, 4.5:1) on both themes;
// antd's default grey (#8c8c8c on white) is only 3.35:1.
export const mutedColor = isDark => (isDark ? '#9a9a9a' : '#595959');
// Status text colors for numbers and marks on cards.
export const statusColor = (isDark, kind) => ({
  success: isDark ? '#73d13d' : '#237804',
  warning: isDark ? '#ffc53d' : '#874d00',
  danger: isDark ? '#ff7875' : '#cf1322',
  info: isDark ? '#69b1ff' : '#0958d9',
}[kind]);
