/**
 * Resolves the effective POS shift policy for a branch.
 *
 * Order of precedence (first defined wins, per field):
 *   1. branch.shiftPolicy     — per-branch override
 *   2. platform.defaultShiftPolicy — platform-wide default
 *   3. DEFAULT_SHIFT_POLICY   — code-level fallback
 *
 * Returned policy is fully populated (no nullable fields except
 * `requiredOpeningFloat` and `autoCloseTime`, which are semantically nullable).
 * Shift handlers snapshot the resolved policy onto the shift at open time.
 */

import Branch from '#resources/commerce/branch/branch.model.js';
import PlatformConfig from '#resources/platform/platform.model.js';
import { DEFAULT_SHIFT_POLICY, type ShiftPolicy } from './shift.constants.js';

/** Keys that are meaningfully nullable. All others get a scalar default. */
const NULLABLE_KEYS = new Set<keyof ShiftPolicy>(['requiredOpeningFloat', 'autoCloseTime']);

function pickDefined<K extends keyof ShiftPolicy>(
  key: K,
  ...sources: ReadonlyArray<Partial<ShiftPolicy> | null | undefined>
): ShiftPolicy[K] {
  for (const source of sources) {
    if (!source) continue;
    const value = source[key];
    if (value === undefined) continue;
    // For nullable keys, treat `null` as "explicitly set to null" (valid).
    // For non-nullable keys, skip `null` so we fall through to the default.
    if (value === null && !NULLABLE_KEYS.has(key)) continue;
    return value as ShiftPolicy[K];
  }
  return DEFAULT_SHIFT_POLICY[key];
}

function mergePolicy(
  branchPolicy: Partial<ShiftPolicy> | null | undefined,
  platformPolicy: Partial<ShiftPolicy> | null | undefined,
): ShiftPolicy {
  return {
    requiredOpeningFloat: pickDefined('requiredOpeningFloat', branchPolicy, platformPolicy),
    enforceBusinessHours: pickDefined('enforceBusinessHours', branchPolicy, platformPolicy),

    blindCloseRequired: pickDefined('blindCloseRequired', branchPolicy, platformPolicy),
    varianceThresholdAbs: pickDefined('varianceThresholdAbs', branchPolicy, platformPolicy),
    varianceThresholdPct: pickDefined('varianceThresholdPct', branchPolicy, platformPolicy),
    managerOverrideRequired: pickDefined('managerOverrideRequired', branchPolicy, platformPolicy),

    autoCloseEnabled: pickDefined('autoCloseEnabled', branchPolicy, platformPolicy),
    autoCloseTime: pickDefined('autoCloseTime', branchPolicy, platformPolicy),
    autoCloseTimezone: pickDefined('autoCloseTimezone', branchPolicy, platformPolicy),

    allowHandover: pickDefined('allowHandover', branchPolicy, platformPolicy),
    requireReasonCode: pickDefined('requireReasonCode', branchPolicy, platformPolicy),
    allowedReasonCodes: pickDefined('allowedReasonCodes', branchPolicy, platformPolicy),
    allowedPaymentMethods: pickDefined('allowedPaymentMethods', branchPolicy, platformPolicy),
  };
}

function toPlain(value: unknown): Partial<ShiftPolicy> | null {
  if (!value) return null;
  const maybeDoc = value as { toObject?: () => unknown };
  const raw = typeof maybeDoc.toObject === 'function' ? maybeDoc.toObject() : value;
  return raw as Partial<ShiftPolicy>;
}

/**
 * Fetch + merge the effective shift policy for a branch.
 *
 * @param branchId Branch / Better Auth organization id.
 * @throws Error when the branch does not exist.
 */
export async function resolveShiftPolicy(branchId: string): Promise<ShiftPolicy> {
  const [branch, platform] = await Promise.all([
    Branch.findById(branchId).lean(),
    PlatformConfig.findOne({ isSingleton: true }).lean(),
  ]);

  if (!branch) {
    throw new Error(`Branch not found: ${branchId}`);
  }

  const branchPolicy = toPlain((branch as { shiftPolicy?: unknown }).shiftPolicy);
  const platformPolicy = toPlain((platform as { defaultShiftPolicy?: unknown } | null)?.defaultShiftPolicy);

  return mergePolicy(branchPolicy, platformPolicy);
}

/**
 * Pure merge — exposed for testing and for callers that have already fetched
 * the branch and platform docs.
 */
export function resolveShiftPolicySync(
  branchPolicy: Partial<ShiftPolicy> | null | undefined,
  platformPolicy: Partial<ShiftPolicy> | null | undefined,
): ShiftPolicy {
  return mergePolicy(branchPolicy, platformPolicy);
}

/**
 * Freeze a resolved policy into a snapshot suitable for storing on a shift.
 * Clones arrays so downstream mutations can't leak back into the branch doc.
 */
export function snapshotPolicy(policy: ShiftPolicy): ShiftPolicy {
  return {
    ...policy,
    allowedReasonCodes: [...policy.allowedReasonCodes],
    allowedPaymentMethods: [...policy.allowedPaymentMethods],
  };
}
