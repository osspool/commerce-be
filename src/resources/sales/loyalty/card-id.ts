/**
 * Card ID Generation
 *
 * Generates human-readable loyalty card IDs with branch provenance.
 * Format: {PREFIX}-{BRANCH_CODE}-{SEQUENCE}-{CHECK}
 * Example: MBR-DHK-00004821-8
 *
 * - PREFIX: from PlatformConfig.membership.cardPrefix (default "MBR")
 * - BRANCH_CODE: enrolling branch's `code` field (provenance only, card works globally)
 * - SEQUENCE: zero-padded atomic counter from MongoDB
 * - CHECK: Luhn mod-10 check digit over the numeric portion
 */
import mongoose from 'mongoose';

// ── Counter Schema (private) ──

const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { collection: 'loyalty_card_sequence', versionKey: false },
);

const Counter = mongoose.models.LoyaltyCardCounter || mongoose.model('LoyaltyCardCounter', counterSchema);

// ── Luhn Algorithm ──

/**
 * Compute a Luhn mod-10 check digit for a numeric string.
 */
export function computeLuhn(digits: string): number {
  let sum = 0;
  let alternate = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }

  return (10 - (sum % 10)) % 10;
}

// ── Card ID Generation ──

interface CardIdConfig {
  prefix?: string;
  digits?: number;
}

/**
 * Generate a globally unique loyalty card ID with branch provenance.
 *
 * Uses an atomic MongoDB counter to ensure monotonic sequences.
 * The branch code is metadata — the card works at any branch.
 */
export async function generateCardId(branchCode: string, config: CardIdConfig = {}): Promise<string> {
  const { prefix = 'MBR', digits = 8 } = config;

  // Atomic increment — single counter for the whole platform (singleton)
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );

  const seq = String(counter.seq).padStart(digits, '0');
  const check = computeLuhn(seq);

  return `${prefix}-${branchCode.toUpperCase()}-${seq}-${check}`;
}

// ── Card ID Validation ──

interface CardIdParts {
  valid: boolean;
  prefix?: string;
  branchCode?: string;
  sequence?: number;
  check?: number;
}

/**
 * Parse and validate a loyalty card ID.
 * Returns the decoded parts if valid, or `{ valid: false }`.
 */
export function validateCardId(cardId: string): CardIdParts {
  const parts = cardId.split('-');
  if (parts.length !== 4) return { valid: false };

  const [prefix, branchCode, seqStr, checkStr] = parts;

  if (!prefix || !branchCode || !seqStr || !checkStr) return { valid: false };
  if (!/^\d+$/.test(seqStr) || !/^\d$/.test(checkStr)) return { valid: false };

  const expectedCheck = computeLuhn(seqStr);
  if (Number(checkStr) !== expectedCheck) return { valid: false };

  return {
    valid: true,
    prefix,
    branchCode,
    sequence: Number(seqStr),
    check: Number(checkStr),
  };
}
