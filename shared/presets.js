/**
 * Shared Presets
 *
 * Centralized preset instances for single-tenant e-commerce.
 * Uses Arc 2.3.0 preset factory functions.
 */
import { softDeletePreset, slugLookupPreset, treePreset } from '@classytic/arc/presets';

export const softDelete = softDeletePreset();
export const slugLookup = slugLookupPreset();
export const tree = treePreset();
