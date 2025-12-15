import platformConfigRepository from './platform.repository.js';

class PlatformConfigController {
  constructor() {
    this.getConfig = this.getConfig.bind(this);
    this.updateConfig = this.updateConfig.bind(this);
    // Delivery options
    this.getActiveDeliveryOptions = this.getActiveDeliveryOptions.bind(this);
    this.getAllDeliveryOptions = this.getAllDeliveryOptions.bind(this);
    this.addDeliveryOption = this.addDeliveryOption.bind(this);
    this.updateDeliveryOption = this.updateDeliveryOption.bind(this);
    this.removeDeliveryOption = this.removeDeliveryOption.bind(this);
  }

  async getConfig(req, reply) {
    try {
      // Support field selection via query: ?select=payment,deliveryOptions
      const select = req.query.select || null;
      const config = await platformConfigRepository.getConfig(select);
      return reply.code(200).send({ success: true, data: config });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  async updateConfig(req, reply) {
    try {
      const config = await platformConfigRepository.updateConfig(req.body);
      return reply.code(200).send({ success: true, data: config });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  // ============ Delivery Options ============

  async getActiveDeliveryOptions(req, reply) {
    try {
      const options = await platformConfigRepository.getActiveDeliveryOptions();
      return reply.code(200).send({ success: true, data: options });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  async getAllDeliveryOptions(req, reply) {
    try {
      const options = await platformConfigRepository.getAllDeliveryOptions();
      return reply.code(200).send({ success: true, data: options });
    } catch (error) {
      return reply.code(500).send({ success: false, message: error.message });
    }
  }

  async addDeliveryOption(req, reply) {
    try {
      const option = await platformConfigRepository.addDeliveryOption(req.body);
      return reply.code(201).send({ success: true, data: option, message: 'Delivery option added' });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ success: false, message: error.message });
    }
  }

  async updateDeliveryOption(req, reply) {
    try {
      const option = await platformConfigRepository.updateDeliveryOption(req.params.id, req.body);
      return reply.code(200).send({ success: true, data: option, message: 'Delivery option updated' });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ success: false, message: error.message });
    }
  }

  async removeDeliveryOption(req, reply) {
    try {
      await platformConfigRepository.removeDeliveryOption(req.params.id);
      return reply.code(200).send({ success: true, message: 'Delivery option removed' });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ success: false, message: error.message });
    }
  }
}

export default new PlatformConfigController();

