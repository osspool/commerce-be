import { BaseController } from '@classytic/arc';
import sizeGuideRepository from './size-guide.repository.js';

/**
 * Size Guide Controller
 *
 * Extends BaseController for standard CRUD.
 * No custom methods needed - MongoKit + BaseController handles everything.
 * getBySlug — handled by BaseController + slugLookup preset
 */
class SizeGuideController extends BaseController {
    constructor() {
        super(sizeGuideRepository);
    }
}

export default new SizeGuideController();
