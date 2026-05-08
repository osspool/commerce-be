import { Repository, validationChainPlugin } from '@classytic/mongokit';
import type { ContactInfo } from '@classytic/primitives/person';
import type { CustomerDocument, IAddress, ICustomer } from './customer.model.js';
import Customer from './customer.model.js';
import { nameFromString } from './customer.name-utils.js';

interface UserLike {
  _id?: string;
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
}

interface CustomerData {
  name?: string;
  phone?: string;
  email?: string;
}

function contactFromPartials(email: string | undefined, phone: string | undefined): ContactInfo {
  return {
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
  };
}

/**
 * Mongokit's built-in `requireField` / `uniqueField` do flat `data[field]`
 * lookups — they can't navigate `name.given` style dotted paths. We use the
 * same plugin shape but with custom traversal for the structured fields.
 *
 * Uniqueness for `contact.phone` is enforced at the DB level via the unique
 * partial index on the schema; we don't duplicate that check here.
 */
function requireNestedFieldOnCreate(path: string): {
  name: string;
  operations: Array<'create'>;
  validate: (ctx: { data?: Record<string, unknown> }) => void;
} {
  const segments = path.split('.');
  return {
    name: `require-${path}`,
    operations: ['create'],
    validate: (ctx) => {
      let cur: unknown = ctx.data;
      for (const seg of segments) {
        if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[seg];
        } else {
          cur = undefined;
          break;
        }
      }
      if (cur === undefined || cur === null || cur === '') {
        throw Object.assign(new Error(`Field '${path}' is required`), { status: 400 });
      }
    },
  };
}

/**
 * Customer Repository
 *
 * Storage shape is structured (`name: PersonName`, `contact: ContactInfo`).
 * Caller-facing methods still accept flat strings because that's what Better
 * Auth + POS clients provide; translation happens inside the repository.
 */
class CustomerRepository extends Repository<ICustomer> {
  constructor() {
    super(
      Customer,
      [validationChainPlugin([requireNestedFieldOnCreate('name.given'), requireNestedFieldOnCreate('contact.phone')])],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
  }

  /**
   * Link a Better Auth user to an existing customer, or create a fresh one.
   *
   * Matching order:
   *   1. Already linked (`userId` match)
   *   2. Same phone number
   *   3. Same email + guest record (no `userId`)
   *   4. Fresh customer with placeholder phone
   */
  async linkOrCreateForUser(user: UserLike): Promise<ICustomer> {
    const userId = user._id || user.id;
    const email = user.email?.toLowerCase().trim();
    const phone = user.phone?.trim();

    const existing = await this.Model.findOne({ userId });
    if (existing) {
      let updated = false;
      if (user.name) {
        const next = nameFromString(user.name, existing.name.given, user);
        if (next.given !== existing.name.given || next.family !== existing.name.family) {
          existing.name = next;
          updated = true;
        }
      }
      if (email && email !== existing.contact?.email) {
        existing.contact = { ...(existing.contact ?? {}), email };
        updated = true;
      }
      if (phone && phone !== existing.contact?.phone) {
        const phoneOwner = await this.Model.findOne({
          'contact.phone': phone,
          _id: { $ne: existing._id },
        }).lean();
        if (!phoneOwner) {
          existing.contact = { ...(existing.contact ?? {}), phone };
          updated = true;
        }
      }
      if (updated) await existing.save();
      return existing;
    }

    if (phone) {
      const byPhone = await this.Model.findOne({ 'contact.phone': phone });
      if (byPhone) {
        if (!byPhone.userId || byPhone.userId.toString() === userId?.toString()) {
          (byPhone as unknown as { userId?: unknown }).userId = userId;
          if (user.name) {
            byPhone.name = nameFromString(user.name, byPhone.name.given, user);
          }
          if (email && email !== byPhone.contact?.email) {
            byPhone.contact = { ...(byPhone.contact ?? {}), email };
          }
          await byPhone.save();
        }
        return byPhone;
      }
    }

    if (email) {
      const byEmail = await this.Model.findOne({ 'contact.email': email, userId: null });
      if (byEmail) {
        (byEmail as unknown as { userId?: unknown }).userId = userId;
        if (user.name) {
          byEmail.name = nameFromString(user.name, byEmail.name.given, user);
        }
        if (phone && (!byEmail.contact?.phone || byEmail.contact.phone.startsWith('pending_'))) {
          const phoneOwner = await this.Model.findOne({
            'contact.phone': phone,
            _id: { $ne: byEmail._id },
          }).lean();
          if (!phoneOwner) {
            byEmail.contact = { ...(byEmail.contact ?? {}), phone };
          }
        }
        await byEmail.save();
        return byEmail;
      }
    }

    return this.create({
      userId,
      name: nameFromString(user.name, 'Unknown', user),
      contact: contactFromPartials(email, phone || `pending_${userId}`),
    });
  }

  /** Find or create a customer by phone (guest checkout / walk-in). */
  async findOrCreateByPhone({
    name,
    phone,
    email,
  }: {
    name: string;
    phone: string;
    email?: string;
  }): Promise<ICustomer> {
    if (!phone) throw new Error('Phone required');
    if (!name) throw new Error('Name required');

    const { doc } = await this.getOrCreate(
      { 'contact.phone': phone },
      {
        name: nameFromString(name, 'Unknown', { name, email }),
        contact: contactFromPartials(email, phone),
      },
    );
    return doc;
  }

  async getByUserId(userId: string): Promise<ICustomer | null> {
    return this.getByQuery({ userId }, { throwOnNotFound: false });
  }

  async getByPhone(phone: string): Promise<ICustomer> {
    return (await this.getByQuery({ 'contact.phone': phone }))!;
  }

  async getByEmail(email: string): Promise<ICustomer> {
    return (await this.getByQuery({ 'contact.email': email.toLowerCase().trim() }))!;
  }

  // ─── POS customer resolution ──────────────────────────────────────────

  /**
   * Resolve a customer for POS checkout.
   * - `customerId` set → fetch existing.
   * - `phone` set → find-or-create.
   * - neither → `null` (guest / walk-in).
   */
  async resolvePosCustomer(
    customerData: CustomerData = {},
    customerId: string | null = null,
  ): Promise<ICustomer | null> {
    if (customerId) return this.getById(customerId);

    if (customerData?.phone) {
      const phone = customerData.phone.trim();
      const existing = await this.Model.findOne({ 'contact.phone': phone }).lean();

      if (existing) {
        if (customerData.name) {
          const next = nameFromString(customerData.name, existing.name.given, customerData);
          if (next.given !== existing.name.given || next.family !== existing.name.family) {
            await this.Model.updateOne({ _id: existing._id }, { name: next });
            existing.name = next;
          }
        }
        return existing as CustomerDocument;
      }

      return this.create({
        name: nameFromString(customerData.name, 'Walk-in', customerData),
        contact: contactFromPartials(customerData.email, phone),
        tags: ['pos'],
      });
    }

    return null;
  }

  // ─── Address operations ───────────────────────────────────────────────

  async addAddress(customerId: string, address: Partial<IAddress>): Promise<ICustomer> {
    const customer = await this.Model.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    if (!customer.addresses.length) {
      address.isDefault = true;
    } else if (address.isDefault) {
      customer.addresses.forEach((a: IAddress) => (a.isDefault = false));
    }

    customer.addresses.push(address);
    await customer.save();
    return customer;
  }

  async updateAddress(customerId: string, addressId: string, updates: Partial<IAddress>): Promise<ICustomer> {
    const customer = await this.Model.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    const address = customer.addresses.id(addressId);
    if (!address) throw new Error('Address not found');

    if (updates.isDefault) {
      customer.addresses.forEach((a: IAddress) => (a.isDefault = false));
    }

    Object.assign(address, updates);
    await customer.save();
    return customer;
  }

  async removeAddress(customerId: string, addressId: string): Promise<ICustomer | null> {
    return this.Model.findByIdAndUpdate(
      customerId,
      { $pull: { addresses: { _id: addressId } } },
      { returnDocument: 'after' },
    );
  }

  async setDefaultAddress(customerId: string, addressId: string): Promise<ICustomer> {
    const customer = await this.Model.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    customer.addresses.forEach((a: IAddress) => {
      a.isDefault = a._id?.toString() === addressId.toString();
    });

    await customer.save();
    return customer;
  }

  // ─── Membership card lookup (POS scanner) ─────────────────────────────

  async lookupByCardId(cardId: string): Promise<ICustomer | null> {
    if (!cardId) return null;
    return this.Model.findOne({
      'membership.cardId': cardId,
      'membership.isActive': true,
    }).lean();
  }
}

export default new CustomerRepository();
