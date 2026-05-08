/**
 * Partner bridge — resolves a partnerId to contact info for the invoice
 * engine's notification layer. Routing:
 *   out_* moveTypes → Customer collection (contact.email / contact.phone)
 *   in_*  moveTypes → Supplier collection (email / phone)
 *
 * See `packages/invoice/src/domain/contracts/partner-bridge.ts` for the port.
 */

import { isCustomerSide } from '@classytic/invoice';
import type { PartnerBridge, PartnerContact } from '@classytic/invoice/domain/contracts';
import supplierRepository from '#resources/inventory/supplier/supplier.repository.js';
import customerRepository from '#resources/sales/customers/customer.repository.js';

export function createPartnerBridge(): PartnerBridge {
  return {
    async resolveContact(partnerId, moveType): Promise<PartnerContact | null> {
      if (isCustomerSide(moveType)) {
        const customer = (await customerRepository.getById(partnerId, {
          select: 'contact displayName firstName lastName',
          lean: true,
          throwOnNotFound: false,
        })) as
          | {
              contact?: { email?: string; phone?: string };
              displayName?: string;
              firstName?: string;
              lastName?: string;
            }
          | null;
        if (!customer) return null;
        const composedName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || undefined;
        const name = customer.displayName ?? composedName;
        return {
          id: partnerId,
          name,
          email: customer.contact?.email,
          phone: customer.contact?.phone,
        };
      }

      const supplier = (await supplierRepository.getById(partnerId, {
        select: 'email phone name',
        lean: true,
        throwOnNotFound: false,
      })) as { email?: string; phone?: string; name?: string } | null;
      if (!supplier) return null;
      return {
        id: partnerId,
        name: supplier.name,
        email: supplier.email,
        phone: supplier.phone,
      };
    },
  };
}
