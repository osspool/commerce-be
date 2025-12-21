/**
 * Cost Price Access Configuration
 *
 * Cost price is sensitive (profit/leakage). We keep access rules configurable.
 *
 * - viewRoles: can see cost prices in API responses (Product.costPrice, variants[].costPrice, StockEntry.costPrice, Order.items[].costPriceAtSale)
 * - manageRoles: can set/update cost prices via write APIs
 */

export default {
  costPrice: {
    // BD market default:
    // - warehouse staff needs to record purchase costs at head office
    // - store managers may view margin, but not change cost
    viewRoles: ['admin', 'superadmin', 'finance-admin', 'finance-manager', 'warehouse-admin', 'warehouse-staff', 'store-manager'],
    manageRoles: ['admin', 'superadmin', 'finance-admin', 'finance-manager', 'warehouse-admin', 'warehouse-staff'],
  },
};
