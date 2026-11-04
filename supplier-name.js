// Display-name matching only. The supplier id, account, amount and currency are
// compared byte for byte elsewhere and never pass through this file.
// Shared by the server check and the browser, so the two cannot disagree.

/**
 * NFKC, then Unicode case folding, then collapsed whitespace. toLowerCase plus the
 * two folds it omits is used on purpose: an upper-then-lower round trip would turn
 * a dotless i into a plain i and let that lookalike through.
 */
export function foldSupplierName(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return '';
  return value.normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function supplierNamesMatch(left, right) {
  const folded = foldSupplierName(left);
  return folded.length > 0 && folded === foldSupplierName(right);
}
