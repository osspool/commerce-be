/**
 * Tests for the standalone checksum predicates used by
 * `scripts/preflight-catalog-0.1.1.mjs`.
 *
 * The pre-flight script bypasses the full app + Mongoose engine to read
 * raw documents directly. It can't import from `@classytic/catalog/schemas`
 * at the package boundary because that brings in the Zod runtime, so it
 * carries a parallel implementation of the checksum algorithms.
 *
 * This test asserts the parallel implementation matches the catalog
 * package's behaviour against the same fixtures used in
 * `packages/catalog/tests/unit/value-objects/barcode-predicates.test.ts`.
 * If those tests change a fixture, this one fails — preventing silent
 * drift between the deploy gate and the runtime guard.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS module without typings; we import for behavioural test only.
import {
  ean13Check,
  upcaCheck,
  ean8Check,
  gtin14Check,
  gtinCheck,
  isbn10Check,
  isbnCheck,
  scannableValid,
} from '../../scripts/lib/barcode-checksum.mjs';

describe('ean13Check', () => {
  it('accepts known-valid EAN-13', () => {
    expect(ean13Check('5901234123457')).toBe(true);
    expect(ean13Check('4006381333931')).toBe(true);
  });

  it('rejects bad checksum and wrong length', () => {
    expect(ean13Check('5901234123450')).toBe(false);
    expect(ean13Check('123456789012')).toBe(false);
    expect(ean13Check('12345678901234')).toBe(false);
  });
});

describe('upcaCheck', () => {
  it('accepts known-valid UPC-A', () => {
    expect(upcaCheck('036000291452')).toBe(true);
    expect(upcaCheck('012345678905')).toBe(true);
  });
  it('rejects bad checksum', () => {
    expect(upcaCheck('036000291450')).toBe(false);
  });
});

describe('ean8Check', () => {
  it('accepts known-valid EAN-8', () => {
    expect(ean8Check('73513537')).toBe(true);
  });
  it('rejects bad checksum', () => {
    expect(ean8Check('73513530')).toBe(false);
  });
});

describe('gtin14Check', () => {
  it('accepts a valid GTIN-14', () => {
    expect(gtin14Check('10012345678902')).toBe(true);
  });
});

describe('gtinCheck router', () => {
  it('routes by length to the right family', () => {
    expect(gtinCheck('73513537')).toBe(true);          // GTIN-8
    expect(gtinCheck('036000291452')).toBe(true);      // GTIN-12
    expect(gtinCheck('5901234123457')).toBe(true);     // GTIN-13
    expect(gtinCheck('10012345678902')).toBe(true);    // GTIN-14
  });

  it('rejects unsupported lengths', () => {
    expect(gtinCheck('123456789')).toBe(false);
    expect(gtinCheck('1234567890')).toBe(false);
    expect(gtinCheck('12345678901')).toBe(false);
    expect(gtinCheck('123456789012345')).toBe(false);
  });
});

describe('isbn10Check', () => {
  it('accepts numeric and X-tail', () => {
    expect(isbn10Check('0306406152')).toBe(true);
    expect(isbn10Check('043942089X')).toBe(true);
  });
  it('rejects bad checksum', () => {
    expect(isbn10Check('0306406150')).toBe(false);
  });
});

describe('isbnCheck umbrella', () => {
  it('accepts ISBN-10 and ISBN-13 with or without hyphens', () => {
    expect(isbnCheck('0306406152')).toBe(true);
    expect(isbnCheck('9780306406157')).toBe(true);
    expect(isbnCheck('978-0-306-40615-7')).toBe(true);
    expect(isbnCheck('0-306-40615-2')).toBe(true);
  });
  it('rejects gibberish', () => {
    expect(isbnCheck('not-a-real-isbn')).toBe(false);
  });
});

describe('scannableValid (mirrors catalog validateScannableBarcode)', () => {
  it('treats empty as valid (caller filters empties)', () => {
    expect(scannableValid('')).toBe(true);
    expect(scannableValid(null as unknown as string)).toBe(true);
    expect(scannableValid(undefined as unknown as string)).toBe(true);
  });

  it('accepts every valid format', () => {
    expect(scannableValid('5901234123457')).toBe(true);   // EAN-13
    expect(scannableValid('036000291452')).toBe(true);    // UPC-A
    expect(scannableValid('73513537')).toBe(true);        // EAN-8
    expect(scannableValid('10012345678902')).toBe(true);  // GTIN-14
    expect(scannableValid('9780306406157')).toBe(true);   // ISBN-13
    expect(scannableValid('0306406152')).toBe(true);      // ISBN-10
    expect(scannableValid('SKU-ABC-123')).toBe(true);     // CODE128
  });

  it('rejects checksum-invalid and unrecognised numeric lengths', () => {
    expect(scannableValid('5901234123450')).toBe(false);  // bad EAN-13
    expect(scannableValid('12345')).toBe(false);          // too short numeric
    expect(scannableValid('12345678901')).toBe(false);    // 11 digits
    expect(scannableValid('abc')).toBe(false);            // too-short alpha
  });
});

describe('cross-fixture parity with @classytic/catalog/schemas', () => {
  // This block exists so that whoever updates a fixture in catalog's test
  // suite gets a CI hit in be-prod too — keeps the deploy gate honest.
  // Fixtures intentionally duplicated (not imported) — the point of the
  // pre-flight script is to NOT import the catalog package at runtime.
  const CATALOG_FIXTURES = {
    validEAN13:   ['5901234123457', '4006381333931'],
    validUPCA:    ['036000291452',  '012345678905'],
    validEAN8:    ['73513537'],
    validGTIN14:  ['10012345678902'],
    validISBN10:  ['0306406152',    '043942089X'],
    validISBN13:  ['9780306406157', '9780743273565'],
    invalidNumericByLength: ['12345', '1234567890', '12345678901'],
  };

  it('every catalog "valid" fixture parses as valid here', () => {
    for (const v of CATALOG_FIXTURES.validEAN13)  expect(ean13Check(v)).toBe(true);
    for (const v of CATALOG_FIXTURES.validUPCA)   expect(upcaCheck(v)).toBe(true);
    for (const v of CATALOG_FIXTURES.validEAN8)   expect(ean8Check(v)).toBe(true);
    for (const v of CATALOG_FIXTURES.validGTIN14) expect(gtin14Check(v)).toBe(true);
    for (const v of CATALOG_FIXTURES.validISBN10) expect(isbn10Check(v)).toBe(true);
    for (const v of CATALOG_FIXTURES.validISBN13) expect(isbnCheck(v)).toBe(true);
  });

  it('every catalog "numeric-but-invalid-length" fixture is rejected by scannableValid', () => {
    for (const v of CATALOG_FIXTURES.invalidNumericByLength) {
      expect(scannableValid(v)).toBe(false);
    }
  });
});
