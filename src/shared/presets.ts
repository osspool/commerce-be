/**
 * Shared Presets
 *
 * Centralized preset instances for single-tenant e-commerce.
 * Uses Arc 2.3.0 preset factory functions.
 */
import { softDeletePreset, slugLookupPreset, treePreset } from '@classytic/arc/presets';
import type { PresetResult } from '@classytic/arc';

export const softDelete: PresetResult = softDeletePreset();
export const slugLookup: PresetResult = slugLookupPreset();
export const tree: PresetResult = treePreset();
