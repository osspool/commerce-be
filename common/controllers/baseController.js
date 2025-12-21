import { queryParser } from '@classytic/mongokit/utils';

class BaseController {
  constructor(service, schemaOptions = {}) {
    this.service = service;
    this.schemaOptions = schemaOptions;

    this.create = this.create.bind(this);
    this.getAll = this.getAll.bind(this);
    this.getById = this.getById.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
  }

  async create(req, reply) {
    const options = this._buildContext(req);
    const document = await this.service.create(req.body, options);
    return reply.code(201).send({ success: true, data: document });
  }

  async getAll(req, reply) {
    const rawQuery = req.validated?.query || req.query;
    const queryParams = queryParser.parseQuery(rawQuery);
    const options = this._buildContext(req);

    // MongoKit Repository.getAll() expects:
    // First arg: { page/after, limit, filters, sort, search }
    // Second arg: { populate, select, lean, session, context }
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
      // Merge populate from queryParams (parsed from URL) with options
      populate: queryParams.populate || options.populate,
    };

    const result = await this.service.getAll(paginationParams, repoOptions);
    return reply.code(200).send({ success: true, ...result });
  }

  async getById(req, reply) {
    const options = this._buildContext(req);
    const document = await this.service.getById(req.params.id, options);
    return reply.code(200).send({ success: true, data: document });
  }

  async update(req, reply) {
    const options = this._buildContext(req);
    const document = await this.service.update(req.params.id, req.body, options);
    return reply.code(200).send({ success: true, data: document });
  }

  async delete(req, reply) {
    const options = this._buildContext(req);
    const result = await this.service.delete(req.params.id, options);
    return reply.code(200).send(result);
  }

  _buildContext(req) {
    const rawQuery = req.validated?.query || req.query;
    const schemaOptions = req.route?.schemaOptions || this.schemaOptions || {};

    return {
      context: {
        user: req.user,
        ...req.context,
      },
      user: req.user,
      select: this._sanitizeSelect(
        req.fieldPreset?.select || rawQuery.select,
        schemaOptions
      ),
      populate: this._sanitizePopulate(rawQuery.populate, schemaOptions),
      lean: rawQuery.lean !== 'false',
    };
  }

  _getBlockedFields(schemaOptions) {
    const fieldRules = schemaOptions.fieldRules || {};
    return Object.entries(fieldRules)
      .filter(([_, rules]) => rules.systemManaged)
      .map(([field]) => field);
  }

  _sanitizeSelect(select, schemaOptions) {
    if (!select) return undefined;

    const blockedFields = this._getBlockedFields(schemaOptions);
    if (blockedFields.length === 0) return select;

    const fields = select.split(/[\s,]+/).filter(Boolean);
    const sanitized = fields.filter(f => {
      const fieldName = f.replace(/^-/, '');
      return !blockedFields.includes(fieldName);
    });

    return sanitized.length > 0 ? sanitized.join(' ') : undefined;
  }

  _sanitizePopulate(populate, schemaOptions) {
    if (!populate) return undefined;

    const allowedPopulate = schemaOptions.query?.allowedPopulate;
    if (!allowedPopulate) return undefined;

    const requested = Array.isArray(populate) ? populate : [populate];
    const sanitized = requested.filter(p => allowedPopulate.includes(p));

    return sanitized.length > 0 ? sanitized : undefined;
  }
}

export default BaseController;



