import { Repository, validationChainPlugin, uniqueField, requireField } from '@classytic/mongokit';
import Customer from './customer.model.js';
import type { ICustomer, CustomerDocument, IAddress } from './customer.model.js';

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

/**
 * Customer Repository
 *
 * Simple and clean - no unnecessary plugins.
 */
class CustomerRepository extends Repository<ICustomer> {
  constructor() {
    super(
      Customer,
      [
        validationChainPlugin([
          requireField('name', ['create']),
          requireField('phone', ['create']),
          uniqueField('phone', 'Phone number already in use'),
        ]),
      ],
      {
        defaultLimit: 20,
        maxLimit: 100,
      },
    );
  }

  /**
   * Link user to existing customer or create new
   */
  async linkOrCreateForUser(user: UserLike): Promise<ICustomer> {
    const userId = user._id || user.id;
    const email = user.email?.toLowerCase().trim();
    const phone = user.phone?.trim();

    // Already linked?
    const existing = await this.Model.findOne({ userId });
    if (existing) {
      let updated = false;
      if (user.name && user.name !== existing.name) {
        existing.name = user.name;
        updated = true;
      }
      if (email && email !== existing.email) {
        existing.email = email;
        updated = true;
      }
      if (phone && existing.phone !== phone) {
        const phoneOwner = await this.Model.findOne({ phone, _id: { $ne: existing._id } }).lean();
        if (!phoneOwner) {
          existing.phone = phone;
          updated = true;
        }
      }
      if (updated) {
        await existing.save();
      }
      return existing;
    }

    // Customer exists by phone? (preferred primary identifier)
    if (phone) {
      const byPhone = await this.Model.findOne({ phone });
      if (byPhone) {
        if (!byPhone.userId || byPhone.userId.toString() === userId?.toString()) {
          (byPhone as any).userId = userId;
          if (user.name && user.name !== byPhone.name) {
            byPhone.name = user.name;
          }
          if (email && email !== byPhone.email) {
            byPhone.email = email;
          }
          await byPhone.save();
        }
        return byPhone;
      }
    }

    // Customer exists by email? (from guest checkout)
    if (email) {
      const byEmail = await this.Model.findOne({ email, userId: null });
      if (byEmail) {
        (byEmail as any).userId = userId;
        byEmail.name = user.name || byEmail.name;
        if (phone && (!byEmail.phone || byEmail.phone.startsWith('pending_'))) {
          const phoneOwner = await this.Model.findOne({ phone, _id: { $ne: byEmail._id } }).lean();
          if (!phoneOwner) {
            byEmail.phone = phone;
          }
        }
        await byEmail.save();
        return byEmail;
      }
    }

    // Create new
    return this.create({
      userId,
      name: user.name,
      email,
      phone: phone || `pending_${userId}`,
    });
  }

  /**
   * Find or create by phone (guest checkout)
   */
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

    return (await this.getOrCreate({ phone }, { name, phone, email }))!;
  }

  async getByUserId(userId: string): Promise<ICustomer | null> {
    return this.getByQuery({ userId }, { throwOnNotFound: false });
  }

  async getByPhone(phone: string): Promise<ICustomer> {
    return (await this.getByQuery({ phone }))!;
  }

  async getByEmail(email: string): Promise<ICustomer> {
    return (await this.getByQuery({ email: email.toLowerCase().trim() }))!;
  }

  // ============================================
  // POS CUSTOMER RESOLUTION
  // ============================================

  /**
   * Resolve customer for POS checkout
   *
   * Quick lookup/create for POS transactions:
   * - If customerId provided: fetch existing
   * - If phone provided: find or create by phone
   * - If neither: return null (guest/walk-in)
   */
  async resolvePosCustomer(
    customerData: CustomerData = {},
    customerId: string | null = null,
  ): Promise<ICustomer | null> {
    // Existing customer by ID
    if (customerId) {
      return this.getById(customerId);
    }

    // Find or create by phone
    if (customerData?.phone) {
      const phone = customerData.phone.trim();
      const existing = await this.Model.findOne({ phone }).lean();

      if (existing) {
        // Update name if provided and different
        if (customerData.name && customerData.name !== existing.name) {
          await this.Model.updateOne({ _id: existing._id }, { name: customerData.name });
          existing.name = customerData.name;
        }
        return existing as CustomerDocument;
      }

      // Create new customer
      return this.create({
        phone,
        name: customerData.name || 'Walk-in',
        email: customerData.email || undefined,
        tags: ['pos'],
      });
    }

    // Guest checkout - no customer record
    return null;
  }

  // ============================================
  // ADDRESS OPERATIONS - Simple $push/$pull
  // ============================================

  async addAddress(customerId: string, address: Partial<IAddress>): Promise<ICustomer> {
    // First address is always default
    const customer = await this.Model.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    if (!customer.addresses.length) {
      address.isDefault = true;
    } else if (address.isDefault) {
      // Unset other defaults
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

  // ============================================
  // MEMBERSHIP LOOKUP (thin field on Customer — synced from loyalty engine)
  // ============================================

  /**
   * Lookup customer by membership card ID (for POS card scanner).
   * Reads from the Customer.membership thin field which is synced from the loyalty engine.
   */
  async lookupByCardId(cardId: string): Promise<ICustomer | null> {
    if (!cardId) return null;
    return this.Model.findOne({
      'membership.cardId': cardId,
      'membership.isActive': true,
    }).lean();
  }
}

export default new CustomerRepository();
