/**
 * Map `ApprovalError` codes from `@classytic/primitives/approval` onto the
 * canonical `ArcError` contract so clients get stable `code`s through the
 * Arc 2.13 flat error envelope.
 *
 * Primitive errors are framework-agnostic — they carry `code` + `message`
 * but no HTTP status. Status assignment lives here, where we know about
 * the wire layer.
 */

import { ApprovalError, type ApprovalErrorCode } from '@classytic/primitives/approval';
import { createDomainError, ValidationError } from '@classytic/arc/utils';

const STATUS_BY_CODE: Readonly<Record<ApprovalErrorCode, number>> = {
  EMPTY_STEPS: 400,
  DUPLICATE_STEP_ID: 400,
  EMPTY_APPROVERS: 400,
  DUPLICATE_APPROVER_ID: 400,
  INVALID_QUORUM: 400,
  UNKNOWN_STEP: 422,
  UNAUTHORIZED_APPROVER: 403,
  STEP_NOT_ACTIVE: 422,
  STEP_ALREADY_DECIDED_BY_APPROVER: 409,
};

/**
 * Wrap a synchronous chain operation that may throw `ApprovalError`. Maps
 * the primitive's `code` onto a `arc.<lower_snake>` domain code so the FE
 * can discriminate without parsing messages.
 */
export function rethrowApprovalError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ApprovalError) {
      const status = STATUS_BY_CODE[err.code] ?? 422;
      const code = `approval.${err.code.toLowerCase()}`;
      throw createDomainError(code, err.message, status);
    }
    throw err;
  }
}

/** Validation-error builder used by the action preset for body checks. */
export function approvalValidationError(message: string): never {
  throw new ValidationError(message);
}
