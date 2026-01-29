import { BaseController } from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import productRepository from './product.repository.js';
import { productSchemaOptions } from './product.schemas.js';
import { syncProduct } from '#modules/inventory/stockSync.util.js';
import { NotFoundError } from '#shared/utils/errors.js';

class ProductController extends BaseController {
  constructor() {
    super(productRepository, {
      schemaOptions: productSchemaOptions,
      queryParser: new QueryParser(),
    });
    this.getRecommendations = this.getRecommendations.bind(this);
    this.delete = this.delete.bind(this);
    this.syncStock = this.syncStock.bind(this);
  }

  // getBySlug, restore, getDeleted — handled by BaseController + presets

  async getRecommendations(req, reply) {
    const { productId } = req.params;
    const recommendations = await productRepository.getRecommendations(productId, 4);
    return reply.send({ success: true, data: recommendations });
  }

  /**
   * Delete product
   * Default: soft delete (preserves data for order history)
   * With ?hard=true: permanent delete (admin only, cascades to inventory)
   */
  async delete(context) {
    const { hard } = context.query;

    let result;
    if (hard === 'true') {
      result = await productRepository.hardDelete(context.params.id);
    } else {
      await productRepository.delete(context.params.id);
      result = { deleted: true, productId: context.params.id, soft: true };
    }

    return {
      success: true,
      data: { message: 'Product deleted successfully' },
      status: 200,
      meta: result,
    };
  }

  /**
   * Sync product.quantity from StockEntry totals
   * POST /products/:id/sync-stock
   */
  async syncStock(req, reply) {
    const { id } = req.params;
    const product = await productRepository.getById(id, { lean: true, select: '_id quantity costPrice' });

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    const result = await syncProduct(id);

    return reply.send({
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
