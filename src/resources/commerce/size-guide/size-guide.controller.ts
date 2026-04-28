import { type AnyRecord, BaseController } from '@classytic/arc';
import type { ISizeGuide } from './size-guide.model.js';
import sizeGuideRepository from './size-guide.repository.js';

class SizeGuideController extends BaseController<ISizeGuide & AnyRecord> {
  constructor() {
    super(sizeGuideRepository);
  }
}

export default new SizeGuideController();
