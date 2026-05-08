/**
 * Re-export of arc's canonical error classes.
 *
 * arc 2.13+ ships `ArcError` + named subclasses + `createError` /
 * `createDomainError` from `@classytic/arc/utils`. The error handler emits
 * the canonical `ErrorContract` (`{ code, message, status, details? }`) for
 * any thrown `ArcError`. Hosts should throw these — never construct
 * `{ statusCode, code }` envelopes by hand.
 *
 * `BadRequestError` is be-prod's preferred 400 alias for `ValidationError`
 * — same status, same wire shape.
 */

export {
  ArcError,
  ConflictError,
  createDomainError,
  createError,
  ForbiddenError,
  isArcError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '@classytic/arc/utils';

export { ValidationError as BadRequestError } from '@classytic/arc/utils';
