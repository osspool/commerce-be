/**
 * Simplified Permission Model
 *
 * Platform Roles:
 * - user: Regular users (can own organizations, become gym members)
 * - admin, superadmin: Platform staff (monitor all organizations)
 *
 * Organization Roles:
 * - owner: Organization owner (full control of org resources)
 * - manager: Organization manager (manage plans, memberships, staff)
 * - trainer: Organization trainer (view schedules, manage assigned members)
 *
 * Authorization Strategy:
 * - Public routes: [] (no auth required)
 * - Customer routes: ['user', 'admin', 'superadmin'] (any authenticated)
 * - Organization data: Role-based (via orgRoles and organizationScoped middleware)
 * - Platform admin: ['admin', 'superadmin'] (platform staff only)
 *
 * No complex role hierarchies. Simple and clear.
 */

const platformStaff = ['admin', 'superadmin'];
const authenticated = ['user', 'admin', 'superadmin'];

const permissions = {
  // Platform Staff Management
  users: {
    list: platformStaff,
    get: platformStaff,
    create: ['superadmin'],
    update: ['superadmin'],
    remove: ['superadmin'],
  },

  // Organizations (Public - customers see where to buy)
  organizations: {
    list: [], // Public - customers browse organizations
    get: [], // Public - view organization details
    create: authenticated, // Any user can create organization
    update: authenticated, // Owner updates (via ownershipGuard)
    remove: platformStaff, // Only platform staff can delete
  },

  // Landing Pages (Public - marketing pages)
  landingPages: {
    list: [], // Public
    get: [], // Public
    create: authenticated, // Organization owners create
    update: authenticated, // Organization owners update
    remove: authenticated, // Organization owners delete
  },

  // Gym Plans (Public - customers browse gym service offerings)
  gymPlans: {
    list: [], // Public - customers browse gym plans
    get: [], // Public - view plan details
    create: authenticated, // Gym owners create plans
    update: authenticated, // Gym owners update plans
    remove: authenticated, // Gym owners delete plans
  },

  // Gym Memberships (Authenticated - customer purchases/subscriptions)
  memberships: {
    list: authenticated, // List own/org memberships
    get: authenticated, // View own/org memberships
    create: authenticated, // Must login to purchase/subscribe
    update: authenticated, // Gym owners manage
    remove: platformStaff, // Only platform staff
    // Subscription management (customer + gym staff)
    renew: authenticated,
    pause: authenticated,
    resume: authenticated,
    cancel: authenticated,
  },

  // Customers (CRM - organization owners manage)
  customers: {
    list: authenticated, // List own organization customers
    get: authenticated, // View own organization customers
    create: [], // Auto-created from memberships
    update: authenticated, // Organization owners update
    remove: platformStaff, // Only platform staff
  },

  // Leads (CRM intake + follow-up)
  leads: {
    list: authenticated,
    get: authenticated,
    create: authenticated,
    update: authenticated,
    remove: platformStaff,
  },

  // Trainers (Professional profiles - public search, self-manage)
  trainers: {
    list: [], // Public - browse trainers
    get: [], // Public - view trainer profiles
    create: authenticated, // Any user can create trainer profile
    update: authenticated, // Own profile only (enforced in controller)
    remove: platformStaff, // Only platform staff
  },

  // Employees (HRM - organization staff management)
  employees: {
    list: authenticated, // List own organization employees
    get: authenticated, // View own organization employees
    hire: authenticated, // Organization owners hire employees
    update: authenticated, // Organization owners update employment
    terminate: authenticated, // Organization owners terminate employment
    rehire: authenticated, // Organization owners rehire employees
    // Compensation management
    updateSalary: authenticated,
    manageAllowances: authenticated,
    manageDeductions: authenticated,
    updateBankDetails: authenticated,
    // Payroll processing
    processSalary: authenticated,
    processBulk: authenticated,
    viewPayroll: authenticated,
    exportPayroll: authenticated,
  },

  // Transactions (Organization owners view own)
  transactions: {
    list: authenticated, // View own organization transactions
    get: authenticated, // View own organization transactions
    create: authenticated, // Manual transactions
    update: authenticated, // Update reference/notes
    remove: platformStaff, // Only platform staff
  },

  // Platform Subscriptions (Organization billing)
  subscriptions: {
    list: authenticated, // View own subscription
    get: authenticated, // View own subscription
    create: authenticated, // Create own subscription
    update: authenticated, // Update own subscription
    remove: ['superadmin'], // Only superadmin
    // Subscription management (organization + staff)
    renew: authenticated,
    pause: authenticated,
    resume: authenticated,
    cancel: authenticated,
  },

  // Archives (Organization data exports)
  archives: {
    list: authenticated,
    get: authenticated,
    create: authenticated,
    update: authenticated,
    remove: authenticated,
  },

  // Analytics
  analytics: {
    overview: authenticated,
  },

  // Export
  export: {
    any: authenticated,
  },
};

export default permissions;
