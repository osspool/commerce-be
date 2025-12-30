import { StockMovement } from '../stock/models/index.js';

/**
 * Stock Movement Service
 *
 * Handles stock movement audit trail queries.
 */
class StockMovementService {
  /**
   * Get stock movements with filters and pagination
   *
   * @param {Object} filters - { productId, branchId, type, startDate, endDate }
   * @param {Object} options - { page, limit, sort, after, cursor, populate }
   * @returns {Promise<Object>} Paginated movements
   */
  async getMovements(filters = {}, options = {}) {
    const { productId, branchId, type, startDate, endDate } = filters;
    const { page, limit = 50, sort = '-createdAt', after, cursor, populate } = options;

    const query = {};
    if (productId) query.product = productId;
    if (branchId) query.branch = branchId;
    if (type) query.type = type;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Keyset pagination
    if (after || cursor) {
      const cursorValue = after || cursor;
      try {
        const decoded = JSON.parse(Buffer.from(cursorValue, 'base64').toString('utf8'));
        if (decoded.createdAt) {
          query.createdAt = { ...query.createdAt, $lt: new Date(decoded.createdAt) };
        }
      } catch {
        // Invalid cursor, ignore
      }
    }

    let queryBuilder = StockMovement.find(query)
      .sort(sort)
      .limit(limit + 1);

    if (populate) {
      for (const p of Array.isArray(populate) ? populate : [populate]) {
        queryBuilder = queryBuilder.populate(p);
      }
    } else {
      queryBuilder = queryBuilder
        .populate('product', 'name sku')
        .populate('branch', 'code name');
    }

    const docs = await queryBuilder.lean();

    const hasMore = docs.length > limit;
    if (hasMore) docs.pop();

    let next = null;
    if (hasMore && docs.length > 0) {
      const lastDoc = docs[docs.length - 1];
      next = Buffer.from(JSON.stringify({ createdAt: lastDoc.createdAt })).toString('base64');
    }

    // Offset pagination support
    if (page && !after && !cursor) {
      const skip = (page - 1) * limit;
      const [offsetDocs, total] = await Promise.all([
        StockMovement.find(query)
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .populate('product', 'name sku')
          .populate('branch', 'code name')
          .lean(),
        StockMovement.countDocuments(query),
      ]);

      return {
        method: 'offset',
        docs: offsetDocs,
        total,
        pages: Math.ceil(total / limit),
        page,
        limit,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      };
    }

    return {
      method: 'keyset',
      docs,
      limit,
      hasMore,
      next,
    };
  }
}

export default new StockMovementService();
