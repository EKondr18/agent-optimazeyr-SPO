export function getPosDistance(pos1, pos2) {
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
