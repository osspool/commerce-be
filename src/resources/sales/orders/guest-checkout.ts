/**
 * Guest checkout helpers.
 *
 * `POST /orders/guest/place` accepts anonymous submissions when
 * `config.sales.guestCheckoutEnabled` is true. Two jobs live here:
 *
 *   1. `sanitizeGuestBody` — strip everything the storefront is not allowed
 *      to set. Staff-scoped fields (sellerId, typeData, metadata, sourceId,
 *      staff-supplied idempotencyKey) are dropped even if a malicious client
 *      sends them. The caller-supplied body is not trusted.
 *
 *   2. `upsertGuestCustomer` — find-or-create a Customer row keyed by phone
 *      (primary id in BD), writing the flat "Full Name" into the structured
 *      `PersonName` and inheriting the existing uniqueness rules from
 *      `customer.repository.ts`.
 *
 * The pipeline itself is shared with `/place` via `placement.service.ts` —
 * this file only adds the guest-side guardrails.
 */

import type { CountryCode } from 'libphonenumber-js';
import config from '#config/index.js';
import customerRepository from '#resources/sales/customers/customer.repository.js';
import { normalizePhone, PhoneFormatError } from '#shared/phone.js';

/**
 * Fields the guest route forwards to the placement pipeline. Everything
 * else on `req.body` is dropped before the pipeline sees it.
 */
const ALLOWED_GUEST_KEYS = new Set([
  'lines',
  'customer',
  'shippingAddress',
  'payment',
  'delivery',
  'notes',
  'promoCodes',
  'promoEvaluationId',
  'promoCartHash',
  'orderType',
  'idempotencyKey',
]);

export interface GuestCustomerInput {
  name: string;
  phone: string;
  /** Required: the order package's customerSnapshot schema mandates email. */
  email: string;
}

export class GuestCheckoutValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'GuestCheckoutValidationError';
  }
}

/**
 * Keep only the fields a storefront is allowed to send. Dropping unknown
 * keys (not throwing) keeps the surface tight without giving hints about
 * internal field names to a probing client.
 */
export function sanitizeGuestBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ALLOWED_GUEST_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Validate the guest body before touching the pipeline. Throws a
 * `GuestCheckoutValidationError` whose message is safe to surface.
 */
export function validateGuestBody(body: Record<string, unknown>): GuestCustomerInput {
  const lines = body.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new GuestCheckoutValidationError('Order must contain at least one line', 'lines');
  }
  if (lines.length > 20) {
    throw new GuestCheckoutValidationError('Guest orders are limited to 20 lines', 'lines');
  }

  const customer = body.customer as Record<string, unknown> | undefined;
  if (!customer || typeof customer !== 'object') {
    throw new GuestCheckoutValidationError('customer is required', 'customer');
  }

  const name = typeof customer.name === 'string' ? customer.name.trim() : '';
  const rawPhone = typeof customer.phone === 'string' ? customer.phone : '';
  const email = typeof customer.email === 'string' ? customer.email.trim().toLowerCase() : '';

  if (name.length < 2) {
    throw new GuestCheckoutValidationError('customer.name is required', 'customer.name');
  }

  let phone: string;
  try {
    phone = normalizePhone(rawPhone, {
      defaultCountry: config.sales.defaultPhoneCountry as CountryCode,
    });
  } catch (err) {
    if (err instanceof PhoneFormatError) {
      throw new GuestCheckoutValidationError(err.message, 'customer.phone');
    }
    throw err;
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GuestCheckoutValidationError('customer.email is required', 'customer.email');
  }

  return { name, phone, email };
}

/**
 * Find-or-create the Customer row for a guest. Reuses the existing phone-
 * keyed uniqueness rules — a returning guest with the same phone hits the
 * same row and the CRM view stays consistent.
 */
export async function upsertGuestCustomer(input: GuestCustomerInput): Promise<{
  id: string;
  name: string;
  phone: string;
  email: string;
}> {
  const customer = await customerRepository.findOrCreateByPhone(input);
  return {
    id: String(customer._id),
    name: input.name,
    phone: input.phone,
    email: input.email,
  };
}
