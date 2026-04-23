/**
 * Cost Price Filter Middleware
 *
 * Filters cost price from responses based on user role.
 * Reusable across product, inventory, and related modules.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

interface UserWithRoles {
  role?: string[];
  [key: string]: unknown;
}

type RequestWithUser = FastifyRequest & {
  user?: UserWithRoles;
};

interface ResponsePayload {
  data?: unknown;
  docs?: unknown[];
  [key: string]: unknown;
}

interface VariantLike {
  costPrice?: number;
  toObject?: () => Record<string, any>;
  [key: string]: unknown;
}

interface DataLike {
  costPrice?: number;
  variants?: VariantLike[];
  toObject?: () => Record<string, any>;
  [key: string]: unknown;
}

/**
 * Check if user can view cost prices
 */
function canManageCostPrice(user: UserWithRoles | undefined): boolean {
  if (!user) return false;
  const roles = user.role || [];
  return roles.includes('admin') || roles.includes('superadmin') || roles.includes('finance-manager');
}

/**
 * Recursively filter cost price from object/array
 */
function filterCostPriceByRole(data: unknown, user: UserWithRoles | undefined): unknown {
  if (!data) return data;

  const canSeeCost = canManageCostPrice(user);

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => filterCostPriceByRole(item, user));
  }

  // Handle objects (including Mongoose documents)
  if (typeof data === 'object') {
    const dataObj = data as DataLike;
    // Convert Mongoose document to plain object
    const plainData = dataObj.toObject ? dataObj.toObject() : dataObj;

    // If user can see cost, return as-is (but converted to plain object)
    if (canSeeCost) return plainData;

    // Filter cost price fields
    const filtered = { ...plainData } as Record<string, any>;
    delete filtered.costPrice;

    // Filter variants if present
    if (Array.isArray(filtered.variants)) {
      filtered.variants = filtered.variants.map((v: VariantLike) => {
        const plainVariant = v.toObject ? v.toObject() : v;
        const variant = { ...plainVariant } as Record<string, any>;
        delete variant.costPrice;
        return variant;
      });
    }

    return filtered;
  }

  return data;
}

/**
 * Middleware: Filter cost price from response body
 */
export function costPriceFilterMiddleware(
  request: RequestWithUser,
  reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  const originalSend = reply.send.bind(reply);

  reply.send = ((payload: ResponsePayload) => {
    if (payload && typeof payload === 'object') {
      // Filter single data object
      if (payload.data) {
        payload.data = filterCostPriceByRole(payload.data, request.user);
      }
      // Filter docs array (paginated responses)
      if (payload.docs && Array.isArray(payload.docs)) {
        payload.docs = filterCostPriceByRole(payload.docs, request.user) as unknown[];
      }
    }
    return originalSend(payload);
  }) as typeof reply.send;

  done();
}

/**
 * Middleware: Strip cost price from request body on create/update
 */
export function stripCostPriceMiddleware(
  request: RequestWithUser,
  _reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  if (!canManageCostPrice(request.user)) {
    if (request.body) {
      const body = request.body as DataLike;
      delete body.costPrice;

      // Strip from variants
      if (Array.isArray(body.variants)) {
        body.variants = body.variants.map((v: VariantLike) => {
          const variant = { ...v };
          delete variant.costPrice;
          return variant;
        });
      }
    }
  }
  done();
}

export { canManageCostPrice, filterCostPriceByRole };
