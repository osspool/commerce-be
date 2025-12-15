import BaseController from '#common/controllers/baseController.js';
import productRepository from './product.repository.js';
import { productSchemaOptions } from './product.schemas.js';
import { filterCostPriceByRole } from './product.utils.js';
import { queryParser } from '@classytic/mongokit/utils';

class ProductController extends BaseController {
  constructor() {
    super(productRepository, productSchemaOptions);
    this.getRecommendations = this.getRecommendations.bind(this);
    this.getBySlug = this.getBySlug.bind(this);
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
      result.docs = filterCostPriceByRole(result.docs, req.user?.role);
    }

    return reply.code(200).send({ success: true, ...result });
  }

  // Override getById to filter cost prices
  async getById(req, reply) {
    const options = this._buildContext(req);
    const document = await this.service.getById(req.params.id, options);
    const filtered = filterCostPriceByRole(document, req.user?.role);
    return reply.code(200).send({ success: true, data: filtered });
  }

  async getRecommendations(req, reply) {
    const { productId } = req.params;
    const recommendations = await productRepository.getRecommendations(productId, 4);
    const filtered = filterCostPriceByRole(recommendations, req.user?.role);
    return reply.code(200).send({ success: true, data: filtered });
  }

  async getBySlug(req, reply) {
    const { slug } = req.params;
    const options = this._buildContext(req);
    const product = await productRepository.getBySlug(slug, options);
    const filtered = filterCostPriceByRole(product, req.user?.role);
    return reply.code(200).send({ success: true, data: filtered });
  }
}

export default new ProductController();
