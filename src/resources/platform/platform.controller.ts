import type { FastifyReply, FastifyRequest } from 'fastify';
import platformConfigRepository from './platform.repository.js';
import { createError } from '@classytic/arc/utils';

interface ConfigQuery {
  select?: string;
}

class PlatformConfigController {
  constructor() {
    this.getConfig = this.getConfig.bind(this);
    this.updateConfig = this.updateConfig.bind(this);
    this.getActiveDeliveryOptions = this.getActiveDeliveryOptions.bind(this);
    this.getAllDeliveryOptions = this.getAllDeliveryOptions.bind(this);
    this.addDeliveryOption = this.addDeliveryOption.bind(this);
    this.updateDeliveryOption = this.updateDeliveryOption.bind(this);
    this.removeDeliveryOption = this.removeDeliveryOption.bind(this);
  }

  async getConfig(req: FastifyRequest<{ Querystring: ConfigQuery }>, reply: FastifyReply): Promise<void> {
    try {
      const select = req.query.select || null;
      const config = await platformConfigRepository.getConfig(select);
      return reply.code(200).send(config);
    } catch (error) {
      const err = error as Error;
      throw createError(500, err.message);
    }
  }

  async updateConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const config = await platformConfigRepository.updateConfig(req.body as Record<string, unknown>);
      return reply.code(200).send(config);
    } catch (error) {
      const err = error as Error;
      throw createError(500, err.message);
    }
  }

  // ============ Delivery Options ============

  async getActiveDeliveryOptions(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const options = await platformConfigRepository.getActiveDeliveryOptions();
      return reply.code(200).send(options);
    } catch (error) {
      const err = error as Error;
      throw createError(500, err.message);
    }
  }

  async getAllDeliveryOptions(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const options = await platformConfigRepository.getAllDeliveryOptions();
      return reply.code(200).send(options);
    } catch (error) {
      const err = error as Error;
      throw createError(500, err.message);
    }
  }

  async addDeliveryOption(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const option = await platformConfigRepository.addDeliveryOption(req.body as Record<string, unknown>);
      return reply.code(201).send(option);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      throw createError(err.statusCode || 500, err.message);
    }
  }

  async updateDeliveryOption(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    try {
      const option = await platformConfigRepository.updateDeliveryOption(
        req.params.id,
        req.body as Record<string, unknown>,
      );
      return reply.code(200).send(option);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      throw createError(err.statusCode || 500, err.message);
    }
  }

  async removeDeliveryOption(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> {
    try {
      await platformConfigRepository.removeDeliveryOption(req.params.id);
      return reply.code(200).send(null);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      throw createError(err.statusCode || 500, err.message);
    }
  }
}

export default new PlatformConfigController();
