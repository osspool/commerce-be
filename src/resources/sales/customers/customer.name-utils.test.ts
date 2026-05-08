/**
 * customer.name-utils contract tests.
 *
 * Pure logic, no Mongoose or DB. Pins:
 *   - `looksLikeIdentifierNotName` heuristic — must catch BA/nanoid-shaped
 *     ids and ObjectIds without flagging real BD names ("Sadman Chowdhury",
 *     single-name "Sadman", multi-token Bangla romanisations).
 *   - `fallbackNameFromUser` email-local-part derivation.
 *   - `nameFromString` end-to-end behaviour: real names pass through,
 *     token names get replaced with the email-derived fallback, empty
 *     input falls through to the static label, the user's email override
 *     wins over the static label when present.
 */

import { describe, expect, it } from 'vitest';
import {
  fallbackNameFromUser,
  hasUsableName,
  looksLikeIdentifierNotName,
  nameFromString,
  sanitizeDisplayName,
} from './customer.name-utils.js';

describe('looksLikeIdentifierNotName', () => {
  it.each([
    ['gcqAUBgGpRnDZbyPgKbS', 'BA nanoid (mixed case, 20 chars)'],
    ['ZdGbYCliZINgcdsZZSJXWSC', 'BA nanoid (23 chars)'],
    ['wEeMNIJwXpPzvNpbkWqQmLXv', 'BA nanoid (24 chars)'],
    ['507f1f77bcf86cd799439011', 'bare ObjectId (24 hex)'],
  ])('flags %s as identifier (%s)', (value) => {
    expect(looksLikeIdentifierNotName(value)).toBe(true);
  });

  it.each([
    ['Sadman', 'single Bangla name'],
    ['Sadman Chowdhury', 'two-word BD name (Title Case)'],
    ['Abdur Raki Howlader', 'three-word BD name'],
    ['Osman Alauddin', 'two-word romanised'],
    ['John Doe', 'two-word western'],
    ['Walk-in', 'POS placeholder with hyphen'],
    ['Unknown', 'static fallback label'],
    ['', 'empty string'],
    ['MIT', '3-char acronym (too short)'],
    ['Mary-Anne', 'hyphenated name (no whitespace, but only 2 uppercase)'],
    ['বাংলাদেশ', 'Bangla unicode (no Latin letters)'],
    ['McDonald', 'Mac-prefix (8 chars, only 2 uppercase — too short anyway)'],
    ['VandenBerg', 'Dutch surname (10 chars, 2 uppercase — too short)'],
  ])('does NOT flag %s (%s)', (value) => {
    expect(looksLikeIdentifierNotName(value)).toBe(false);
  });
});

describe('fallbackNameFromUser', () => {
  it('derives Title-Cased local-part from email', () => {
    expect(fallbackNameFromUser({ email: 'afajuzoz915@gmail.com' }, 'Unknown')).toBe('Afajuzoz');
  });

  it('splits on dots / underscores / pluses / digits', () => {
    expect(fallbackNameFromUser({ email: 'first.last@example.com' }, 'X')).toBe('First Last');
    expect(fallbackNameFromUser({ email: 'first_last@example.com' }, 'X')).toBe('First Last');
    expect(fallbackNameFromUser({ email: 'first+gmail-tag@example.com' }, 'X')).toBe('First Gmail Tag');
    expect(fallbackNameFromUser({ email: 'sadman923@gmail.com' }, 'X')).toBe('Sadman');
  });

  it('returns the static label when no email is present', () => {
    expect(fallbackNameFromUser({}, 'Walk-in')).toBe('Walk-in');
    expect(fallbackNameFromUser({ name: '' }, 'Unknown')).toBe('Unknown');
  });

  it('falls back when email local-part has no usable letters', () => {
    expect(fallbackNameFromUser({ email: '12345@example.com' }, 'Unknown')).toBe('Unknown');
    expect(fallbackNameFromUser({ email: 'a@example.com' }, 'Unknown')).toBe('Unknown');
  });
});

describe('nameFromString', () => {
  it('passes real names through verbatim', () => {
    expect(nameFromString('Sadman Chowdhury', 'Unknown')).toEqual({
      given: 'Sadman',
      family: 'Chowdhury',
    });
    expect(nameFromString('Abdur Raki Howlader', 'Unknown')).toEqual({
      given: 'Abdur Raki',
      family: 'Howlader',
    });
  });

  it('puts a single-token name in `given` with empty `family`', () => {
    expect(nameFromString('Sadman', 'Unknown')).toEqual({ given: 'Sadman', family: '' });
  });

  it('falls through to the static label when input is empty', () => {
    expect(nameFromString('', 'Walk-in')).toEqual({ given: 'Walk-in', family: '' });
    expect(nameFromString(undefined, 'Walk-in')).toEqual({ given: 'Walk-in', family: '' });
  });

  it('replaces a token-shaped input with the email-derived fallback', () => {
    expect(
      nameFromString('gcqAUBgGpRnDZbyPgKbS', 'Unknown', { email: 'afajuzoz915@gmail.com' }),
    ).toEqual({ given: 'Afajuzoz', family: '' });
  });

  it('trims whitespace before evaluating', () => {
    expect(nameFromString('   Sadman   ', 'Unknown')).toEqual({ given: 'Sadman', family: '' });
  });

  it('uses the static label when input is token-shaped and no email is available', () => {
    expect(nameFromString('gcqAUBgGpRnDZbyPgKbS', 'Walk-in')).toEqual({
      given: 'Walk-in',
      family: '',
    });
  });

  it('the heuristic is not triggered by valid multi-token names', () => {
    // 19 chars, no whitespace would trigger — but it has whitespace.
    expect(nameFromString('Mohammad Rakib Hasan', 'Unknown')).toEqual({
      given: 'Mohammad Rakib',
      family: 'Hasan',
    });
  });
});

describe('sanitizeDisplayName', () => {
  it('passes a real name through verbatim', () => {
    expect(sanitizeDisplayName('Sadman Chowdhury', 'Customer')).toBe('Sadman Chowdhury');
  });

  it('replaces a token-shaped string with the fallback', () => {
    expect(sanitizeDisplayName('gcqAUBgGpRnDZbyPgKbS', 'Customer')).toBe('Customer');
    expect(sanitizeDisplayName('507f1f77bcf86cd799439011', 'Customer')).toBe('Customer');
  });

  it('uses the fallback for empty / null / undefined input', () => {
    expect(sanitizeDisplayName('', 'Recipient')).toBe('Recipient');
    expect(sanitizeDisplayName(undefined, 'Recipient')).toBe('Recipient');
    expect(sanitizeDisplayName(null, 'Recipient')).toBe('Recipient');
    expect(sanitizeDisplayName('   ', 'Recipient')).toBe('Recipient');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeDisplayName('  Sadman  ', 'X')).toBe('Sadman');
  });
});

describe('hasUsableName', () => {
  it('returns false for null / undefined / empty shapes', () => {
    expect(hasUsableName(undefined)).toBe(false);
    expect(hasUsableName(null)).toBe(false);
    expect(hasUsableName({} as never)).toBe(false);
    expect(hasUsableName({ given: '', family: '' } as never)).toBe(false);
    expect(hasUsableName({ given: '   ', family: '   ' } as never)).toBe(false);
  });

  it('returns true if any single field has content', () => {
    expect(hasUsableName({ given: 'Sadman', family: '' } as never)).toBe(true);
    expect(hasUsableName({ given: '', family: 'Chowdhury' } as never)).toBe(true);
    expect(hasUsableName({ preferred: 'Sad' } as never)).toBe(true);
  });
});
