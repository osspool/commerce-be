/**
 * SettlementImport Repository — extends mongokit Repository.
 *
 * Inherits CRUD/pagination/hooks. Adds two domain methods used by the
 * matcher service and the aging report:
 *   - `findUnmatchedLegs(orgId, clearingCode)` — feeds auto-match
 *   - `findOpenStatements(orgId, clearingCode, asOf)` — feeds aging
 */

import { Repository } from '@classytic/mongokit';
import type mongoose from 'mongoose';
import type { ISettlementImport, ISettlementLeg } from './settlement-import.model.js';
import SettlementImport from './settlement-import.model.js';

interface UnmatchedLeg extends ISettlementLeg {
  importId: mongoose.Types.ObjectId;
  provider: string;
  clearingAccountCode: string;
}

class SettlementImportRepository extends Repository<ISettlementImport> {
  constructor() {
    // Mongokit Repository signature is (Model, plugins?, paginationConfig?, options?).
    // `plugins` must be plugin objects/functions, not tenant-field strings —
    // the older mongokit API took a tenantFields list as the 2nd arg, but
    // that's been replaced by the `multiTenantPlugin` wired explicitly.
    // Tenant scoping for this collection happens at the controller layer
    // via `getOrgId(req)` filters, matching journal-entry / audit repos.
    super(SettlementImport, [], { maxLimit: 200 });
  }

  /**
   * Returns every leg flagged `unmatched` across all imports for the given
   * (org, clearing-code), enriched with its parent import id + provider.
   * The matcher passes these into the JE search to find the corresponding
   * sales-side credit on the clearing account.
   */
  async findUnmatchedLegs(
    organizationId: string,
    clearingAccountCode?: string,
  ): Promise<UnmatchedLeg[]> {
    const query: Record<string, unknown> = {
      organizationId,
      'legs.matchState': 'unmatched',
    };
    if (clearingAccountCode) query.clearingAccountCode = clearingAccountCode;

    const docs = await this.findAll(query);

    const out: UnmatchedLeg[] = [];
    for (const doc of docs) {
      for (const leg of doc.legs) {
        if (leg.matchState === 'unmatched') {
          out.push({
            ...leg,
            importId: doc._id as mongoose.Types.ObjectId,
            provider: doc.provider,
            clearingAccountCode: doc.clearingAccountCode,
          });
        }
      }
    }
    return out;
  }

  /**
   * Statements still draining a clearing account as of `asOf`. A statement
   * is "open" when status is `pending` (not yet posted) OR `posted` (posted
   * but legs still unmatched). The aging report buckets these by
   * `statementDate` to flag stuck float.
   */
  async findOpenStatements(
    organizationId: string,
    clearingAccountCode: string,
    asOf: Date,
  ): Promise<ISettlementImport[]> {
    return this.findAll(
      {
        organizationId,
        clearingAccountCode,
        status: { $in: ['pending', 'posted'] },
        statementDate: { $lte: asOf },
      },
      { sort: { statementDate: 1 } },
    );
  }
}

const settlementImportRepository = new SettlementImportRepository();
export default settlementImportRepository;
