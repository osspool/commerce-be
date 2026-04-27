import { type AnyRecord, BaseController } from '@classytic/arc';
import type { ISizeGuide } from './size-guide.model.js';
import sizeGuideRepository from './size-guide.repository.js';

/**
 * Size Guide Controller
 *
 * Extends BaseController for standard CRUD.
 * No custom methods needed - MongoKit + BaseController handles everything.
 * getBySlug -- handled by BaseController + slugLookup preset.
 */
class SizeGuideController extends BaseController<ISizeGuide & AnyRecord> {
  constructor() {
    super(sizeGuideRepository, { presetFields: { slugField: 'slug' } });
  }
}

export default new SizeGuideController();
