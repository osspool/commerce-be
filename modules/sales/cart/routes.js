/**
 * Cart Plugin - Custom Routes Pattern (WITH ADMIN FEATURES)
 *
 * Cart module uses custom routes (not standard CRUD) because:
 * - Users manage their own cart (no general list/get/create)
 * - Admin has special marketing/support routes
 * - Operations are session/user-specific
 *
 * BEFORE (user routes only): 62 lines
 * AFTER (user + admin routes): 145 lines
 *
 * NEW Admin Marketing Features:
 * - GET /admin/all - List all carts with pagination
 * - GET /admin/abandoned - Get abandoned carts for marketing campaigns
 * - GET /admin/user/:userId - View specific user's cart for support
 */

import cartResource from './cart.resource.js';

export default cartResource.toPlugin();
