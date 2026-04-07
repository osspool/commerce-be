import {
  BaseController,
  type RequestWithExtras,
  type IRequestContext,
  type IControllerResponse,
  type RouteSchemaOptions,
} from '@classytic/arc';
import { QueryParser } from '@classytic/mongokit';
import type { FastifyReply } from 'fastify';
import productRepository from './product.repository.js';
import Product from './product.model.js';
import type { IProduct } from './product.model.js';
import { productSchemaOptions } from './product.schemas.js';
import { NotFoundError } from '#shared/utils/errors.js';
import { getFlowEngineOrNull, buildFlowContext, DEFAULT_LOCATION } from '#resources/inventory/flow/index.js';

interface SyncStockRequest extends RequestWithExtras {
  params: { id: string };
}

interface RecommendationsRequest extends RequestWithExtras {
  params: { productId: string };
}

class ProductController extends BaseController<IProduct> {
  constructor() {
    super(productRepository, {
      schemaOptions: productSchemaOptions as unknown as RouteSchemaOptions,
      queryParser: new QueryParser() as unknown as import('@classytic/arc/types').QueryParserInterface,
    });
    this.getRecommendations = this.getRecommendations.bind(this);
    this.delete = this.delete.bind(this);
    this.syncStock = this.syncStock.bind(this);
  }

  // getBySlug, restore, getDeleted — handled by BaseController + presets

  async getRecommendations(req: RecommendationsRequest, reply: FastifyReply): Promise<void> {
    const { productId } = req.params;
    const recommendations = await productRepository.getRecommendations(productId, 4);
    return reply.send({ success: true, data: recommendations });
  }

  /**
   * Delete product
   * Default: soft delete (preserves data for order history)
   * With ?hard=true: permanent delete (admin only, cascades to inventory)
   */
  async delete(
    context: IRequestContext,
  ): Promise<IControllerResponse<{ message: string; id?: string; soft?: boolean }>> {
    const hard = context.query?.hard as string | undefined;

    let result: Record<string, unknown>;
    if (hard === 'true') {
      result = (await productRepository.hardDelete(context.params.id)) as unknown as Record<string, unknown>;
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
   * Sync product.quantity + stockProjection from Flow quants.
   * POST /products/:id/sync-stock
   *
   * Reads current on-hand from Flow for each variant (or product._id for simple)
   * and updates the cached product.quantity and stockProjection fields.
   */
  async syncStock(req: SyncStockRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params;
    const product = await productRepository.getById(id, { lean: true });

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    const flow = getFlowEngineOrNull();
    if (!flow) {
      return reply.send({
        success: true,
        data: { productId: id, totalQuantity: product.quantity || 0, synced: false, errors: ['Flow engine not available'] },
      });
    }

    const orgId = (req.scope as { organizationId?: string })?.organizationId
      || (req.headers['x-organization-id'] as string);
    const ctx = buildFlowContext(orgId);

    const isVariant = product.productType === 'variant' && product.variants?.length > 0;
    let totalQuantity = 0;
    const variantQuantities: { sku: string; quantity: number }[] = [];

    if (isVariant) {
      // Read each variant's on-hand from Flow
      for (const v of product.variants) {
        const avail = await flow.services.quant.getAvailability(
          { skuRef: v.sku, locationId: DEFAULT_LOCATION }, ctx,
        );
        const qty = avail.quantityOnHand;
        variantQuantities.push({ sku: v.sku, quantity: qty });
        totalQuantity += qty;
      }

      // Update stockProjection + quantity
      await Product.updateOne(
        { _id: id },
        {
          $set: {
            quantity: totalQuantity,
            'stockProjection.variants': variantQuantities,
            'stockProjection.syncedAt': new Date(),
          },
        },
      );
    } else {
      // Simple product — skuRef = product._id
      const avail = await flow.services.quant.getAvailability(
        { skuRef: id, locationId: DEFAULT_LOCATION }, ctx,
      );
      totalQuantity = avail.quantityOnHand;
      await Product.updateOne({ _id: id }, { $set: { quantity: totalQuantity } });
    }

    return reply.send({
      success: true,
      data: {
        productId: id,
        totalQuantity,
        variantQuantities,
        synced: true,
      },
    });
  }
}

export default new ProductController();
