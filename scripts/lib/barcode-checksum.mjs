/**
 * Barcode/identifier checksum predicates for be-prod scripts.
 *
 * These mirror `@classytic/catalog/schemas` exactly — same fixtures,
 * same algorithms — but live as a standalone .mjs so scripts (data
 * migrations, pre-flight checks) can import them without booting
 * mongoose / Arc. Drift between this file and catalog's predicates
 * is what `barcode-checksum.test.mjs` exists to catch.
 */

export const ean13Check = (s) => {
  if (!/^\d{13}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const c = d.pop();
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * (i % 2 === 0 ? 1 : 3);
  return ((10 - (sum % 10)) % 10) === c;
};

const mod10leading3 = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += digits[i] * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
};

export const upcaCheck = (s) => {
  if (!/^\d{12}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const c = d.pop();
  return mod10leading3(d) === c;
};

export const ean8Check = (s) => {
  if (!/^\d{8}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const c = d.pop();
  return mod10leading3(d) === c;
};

export const gtin14Check = (s) => {
  if (!/^\d{14}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const c = d.pop();
  return mod10leading3(d) === c;
};

export const gtinCheck = (s) => {
  if (s.length === 8)  return ean8Check(s);
  if (s.length === 12) return upcaCheck(s);
  if (s.length === 13) return ean13Check(s);
  if (s.length === 14) return gtin14Check(s);
  return false;
};

export const isbn10Check = (s) => {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  sum += s[9] === 'X' ? 10 : Number(s[9]);
  return sum % 11 === 0;
};

export const isbnCheck = (s) => {
  const t = s.replace(/-/g, '');
  if (/^97[89]\d{10}$/.test(t)) return ean13Check(t);
  return isbn10Check(t);
};

/**
 * Mirrors `validateScannableBarcode` in @classytic/catalog/schemas:
 *
 *   - Empty → treated as "valid" here (callers filter out empties first).
 *   - Standard formats (EAN-8/13, UPC-A, GTIN-14, ISBN-10/13) → checksum.
 *   - Numeric strings of unrecognised length → reject (POS scanners can't read).
 *   - Printable ASCII ≥ 4 chars → CODE128, accepted as-is.
 */
export const scannableValid = (s) => {
  if (!s) return true;
  if (/^\d{14}$/.test(s)) return gtin14Check(s);
  if (/^97[89]\d{10}$/.test(s)) return ean13Check(s);
  if (/^\d{13}$/.test(s)) return ean13Check(s);
  if (/^\d{12}$/.test(s)) return upcaCheck(s);
  if (/^\d{9}[\dX]$/.test(s)) return isbn10Check(s);
  if (/^\d{8}$/.test(s)) return ean8Check(s);
  if (/^\d+$/.test(s)) return false;
  return /^[\x20-\x7E]{4,}$/.test(s);
};
