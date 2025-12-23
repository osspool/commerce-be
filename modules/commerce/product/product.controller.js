import BaseController from '#common/controllers/baseController.js';
import productRepository from './product.repository.js';
import { productSchemaOptions } from './product.schemas.js';
import { filterCostPriceByRole } from './product.utils.js';
import { queryParser } from '@classytic/mongokit/utils';
import { syncProduct } from '../inventory/stockSync.util.js';

class ProductController extends BaseController {
  constructor() {
    super(productRepository, productSchemaOptions);
    this.getRecommendations = this.getRecommendations.bind(this);
    this.getBySlug = this.getBySlug.bind(this);
    this.delete = this.delete.bind(this);
    this.restore = this.restore.bind(this);
    this.getDeleted = this.getDeleted.bind(this);
    this.syncStock = this.syncStock.bind(this);
  }

  // Override getAll to filter cost prices
  async getAll(req, reply) {
    const rawQuery = req.validated?.query || req.query;
    const queryParams = queryParser.parseQuery(rawQuery);
    const options = this._buildContext(req);

    const paginationParams = {
      ...(queryParams.page !== undefined && { page: queryParams.page }),
      ...(queryParams.after && { after: queryParams.after }),
      limit: queryParams.limit,
      filters: queryParams.filters,
      sort: queryParams.sort,
      ...(queryParams.search && { search: queryParams.search }),
    };

    const repoOptions = {
      ...options,
      populate: queryParams.populate || options.populate,
    };

    const result = await this.service.getAll(paginationParams, repoOptions);

    // Filter cost prices based on role
    if (result.docs) {
      result.docs = filterCostPriceByRole(result.docs, req.user);
    }

    return reply.code(200).send({ success: true, ...result });
  }

  // Override getById to filter cost prices
  async getById(req, reply) {
    const options = this._buildContext(req);
    const document = await this.service.getById(req.params.id, options);
    const filtered = filterCostPriceByRole(document, req.user);
    return reply.code(200).send({ success: true, data: filtered });
  }

  async getRecommendations(req, reply) {
    const { productId } = req.params;
    const recommendations = await productRepository.getRecommendations(productId, 4);
    const filtered = filterCostPriceByRole(recommendations, req.user);
    return reply.code(200).send({ success: true, data: filtered });
  }

  async getBySlug(req, reply) {
    const { slug } = req.params;
    const options = this._buildContext(req);
    const product = await productRepository.getBySlug(slug, options);
    const filtered = filterCostPriceByRole(product, req.user);
    return reply.code(200).send({ success: true, data: filtered });
  }

  /**
   * Delete product
   * Default: soft delete (preserves data for order history)
   * With ?hard=true: permanent delete (admin only, cascades to inventory)
   */
  async delete(req, reply) {
    const { hard } = req.query;

    let result;
    if (hard === 'true') {
      // Hard delete - permanently remove product and cascade to inventory
      result = await productRepository.hardDelete(req.params.id);
    } else {
      // Soft delete via softDeletePlugin (sets deletedAt, auto-filters from queries)
      await productRepository.delete(req.params.id);
      result = { deleted: true, productId: req.params.id, soft: true };
    }

    return reply.code(200).send({ success: true, ...result });
  }

  /**
   * Restore a soft-deleted product
   * POST /products/:id/restore
   */
  async restore(req, reply) {
    const product = await productRepository.restore(req.params.id);
    const filtered = filterCostPriceByRole(product, req.user);
    return reply.code(200).send({ success: true, data: filtered });
  }

  /**
   * Get soft-deleted products (admin recovery)
   * GET /products/deleted
   */
  async getDeleted(req, reply) {
    const rawQuery = req.validated?.query || req.query;
    const queryParams = queryParser.parseQuery(rawQuery);
    const options = this._buildContext(req);

    const paginationParams = {
      ...(queryParams.page !== undefined && { page: queryParams.page }),
      ...(queryParams.after && { after: queryParams.after }),
      limit: queryParams.limit,
    };

    const result = await productRepository.getDeleted(paginationParams, options);

    if (result.docs) {
      result.docs = filterCostPriceByRole(result.docs, req.user);
    }

    return reply.code(200).send({ success: true, ...result });
  }

  /**
   * Sync product.quantity from StockEntry totals
   * POST /products/:id/sync-stock
   */
  async syncStock(req, reply) {
    const { id } = req.params;
    const product = await productRepository.getById(id, { lean: true, select: '_id quantity costPrice' });
    if (!product) {
      return reply.code(404).send({ success: false, error: 'Product not found' });
    }

    const result = await syncProduct(id);

    return reply.code(200).send({
      success: true,
      data: {
        productId: id,
        totalQuantity: result.totalQuantity || 0,
        variantQuantities: result.variantQuantities || [],
        synced: result.synced === true,
        errors: result.errors || [],
      },
    });
  }
}

export default new ProductController();
