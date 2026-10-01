// The distance is a pure function of the two strings and the optimizer asks
// for the same pairs many thousands of times (each call re-parses both with
// regexes), so memoize it. Distinct stand pairs are few, so this stays small.
const distCache = new Map();

export function getPosDistance(pos1, pos2) {
  const key = pos1 + '\u0000' + pos2;
  let d = distCache.get(key);
  if (d === undefined) {
    d = computePosDistance(pos1, pos2);
    distCache.set(key, d);
  }
  return d;
}

function computePosDistance(pos1, pos2) {
  if (!pos1 || !pos2 || pos1.trim() === '' || pos2.trim() === '') return 999;
  const a = pos1.trim().toUpperCase();
  const b = pos2.trim().toUpperCase();
  if (a === b) return 0;

  const lettersA = a.replace(/[^A-ZА-Я]/gi, '');
  const lettersB = b.replace(/[^A-ZА-Я]/gi, '');
  const numsA = a.replace(/[^0-9]/g, '');
  const numsB = b.replace(/[^0-9]/g, '');

  if (lettersA === lettersB && numsA && numsB) {
    return Math.abs(parseInt(numsA, 10) - parseInt(numsB, 10));
  }
  return 100;
}
