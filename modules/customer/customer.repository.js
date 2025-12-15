import {
  Repository,
  validationChainPlugin,
  uniqueField,
  requireField,
} from '@classytic/mongokit';
import Customer from './customer.model.js';

/**
 * Customer Repository
 * 
 * Simple and clean - no unnecessary plugins.
 */
class CustomerRepository extends Repository {
  constructor() {
    super(Customer, [
      validationChainPlugin([
        requireField('name', ['create']),
        requireField('phone', ['create']),
        uniqueField('phone', 'Phone number already in use'),
      ]),
    ], {
      defaultLimit: 20,
      maxLimit: 100,
    });
  }

  /**
   * Link user to existing customer or create new
   */
  async linkOrCreateForUser(user) {
    const userId = user._id || user.id;
    const email = user.email?.toLowerCase().trim();

    // Already linked?
    const existing = await this.Model.findOne({ userId }).lean();
    if (existing) return existing;

    // Customer exists by email? (from guest checkout)
    if (email) {
      const byEmail = await this.Model.findOne({ email, userId: null });
      if (byEmail) {
        byEmail.userId = userId;
        byEmail.name = user.name || byEmail.name;
        await byEmail.save();
        return byEmail;
      }
    }

    // Create new
    return this.create({
      userId,
      name: user.name,
      email,
      phone: `pending_${userId}`,
    });
  }

  /**
   * Find or create by phone (guest checkout)
   */
  async findOrCreateByPhone({ name, phone, email }) {
    if (!phone) throw new Error('Phone required');
    if (!name) throw new Error('Name required');

    return this.getOrCreate({ phone }, { name, phone, email });
  }

  async getByUserId(userId) {
    return this.getByQuery({ userId }, { throwOnNotFound: false });
  }

  async getByPhone(phone) {
    return this.getByQuery({ phone });
  }

  async getByEmail(email) {
    return this.getByQuery({ email: email.toLowerCase().trim() });
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
   *
   * @param {Object} customerData - { name, phone, email }
   * @param {string} customerId - Existing customer ID (optional)
   * @returns {Promise<Object|null>} Customer document or null for guest
   */
  async resolvePosCustomer(customerData = {}, customerId = null) {
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
        return existing;
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

  async addAddress(customerId, address) {
    // First address is always default
    const customer = await this.Model.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    if (!customer.addresses.length) {
      address.isDefault = true;
    } else if (address.isDefault) {
      // Unset other defaults
      customer.addresses.forEach(a => a.isDefault = false);
    }

    customer.addresses.push(address);
    await customer.save();
    return customer;
  }

  async updateAddress(customerId, addressId, updates) {
    const customer = await this.Model.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    const address = customer.addresses.id(addressId);
    if (!address) throw new Error('Address not found');

    if (updates.isDefault) {
      customer.addresses.forEach(a => a.isDefault = false);
    }

    Object.assign(address, updates);
    await customer.save();
    return customer;
  }

  async removeAddress(customerId, addressId) {
    return this.Model.findByIdAndUpdate(
      customerId,
      { $pull: { addresses: { _id: addressId } } },
      { new: true }
    );
  }

  async setDefaultAddress(customerId, addressId) {
    const customer = await this.Model.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    customer.addresses.forEach(a => {
      a.isDefault = a._id.toString() === addressId.toString();
    });

    await customer.save();
    return customer;
  }
}

export default new CustomerRepository();
