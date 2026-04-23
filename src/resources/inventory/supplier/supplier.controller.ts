import { BaseController } from '@classytic/arc';
import supplierRepository from './supplier.repository.js';
import { supplierSchemaOptions } from './supplier.schemas.js';

/**
 * Supplier Controller — vanilla extends of Arc's BaseController.
 *
 * No overrides. All CRUD flows through BaseController and its composed
 * helpers (AccessControl, BodySanitizer, QueryResolver):
 *   - `create` / `update` inject `createdBy` / `updatedBy`, sanitize, hooks
 *   - `delete` soft-deletes via `mongokit.softDeletePlugin` wired on the
 *     repository; subsequent GETs return 404 automatically
 *   - Existence checks return canonical `{ success:false, status:404,
 *     details:{ code } }` from `notFoundResponse`
 *
 * `tenantField: false` is critical — suppliers are company-wide per the
 * BigBoss single-tenant multi-branch model, so we opt out of the default
 * `organizationId` scope filter. Without this, the `organizationId` field
 * (absent from the Mongoose schema) gets injected on CREATE, silently
 * dropped by `strict: true`, and subsequent reads filter by the missing
 * field → 404 on every GET/PATCH/DELETE.
 */
class SupplierController extends BaseController {
  constructor() {
    super(supplierRepository, {
      schemaOptions: supplierSchemaOptions,
      tenantField: false,
    });
  }
}

export default new SupplierController();
