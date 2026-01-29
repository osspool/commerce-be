/**
 * Product view tracking (feature flag) tests
 *
 * Principle:
 * - No hidden writes on reads by default
 * - View count tracking must be opt-in via env (TRACK_PRODUCT_VIEWS=1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function createReplyStub() {
  return {
    statusCode: null,
    payload: null,
    code(status) {
      this.statusCode = status;
      return this;
    },
    send(payload) {
      this.payload = payload;
      // Set default statusCode if not already set (Fastify behavior)
      if (this.statusCode === null) {
        this.statusCode = 200;
      }
      return this;
    },
  };
}

describe('Product view tracking (TRACK_PRODUCT_VIEWS)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not increment viewCount when TRACK_PRODUCT_VIEWS is 0/undefined (default)', async () => {
    delete process.env.TRACK_PRODUCT_VIEWS;
    await vi.resetModules();

    const { default: productRepository } = await import('#modules/catalog/products/product.repository.js');
    const { default: productController } = await import('#modules/catalog/products/product.controller.js');

    // Avoid needing full BaseController context wiring
    productController._buildContext = () => ({});

    vi.spyOn(productRepository, 'getBySlug').mockResolvedValue({ _id: 'p1', name: 'Demo', costPrice: 0 });
    const incSpy = vi.spyOn(productRepository, 'incrementViewCount').mockImplementation(() => {});

    const req = { params: { slug: 'demo' }, user: null };
    const reply = createReplyStub();
    await productController.getBySlug(req, reply);

    expect(incSpy).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(200);
    expect(reply.payload?.success).toBe(true);
  });

  it('increments viewCount when TRACK_PRODUCT_VIEWS=1', async () => {
    process.env.TRACK_PRODUCT_VIEWS = '1';
    await vi.resetModules();

    const { default: productRepository } = await import('#modules/catalog/products/product.repository.js');
    const { default: productController } = await import('#modules/catalog/products/product.controller.js');

    productController._buildContext = () => ({});

    vi.spyOn(productRepository, 'getBySlug').mockResolvedValue({ _id: 'p1', name: 'Demo', costPrice: 0 });
    const incSpy = vi.spyOn(productRepository, 'incrementViewCount').mockImplementation(() => {});

    const req = { params: { slug: 'demo' }, user: null };
    const reply = createReplyStub();
    await productController.getBySlug(req, reply);

    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledWith('p1');
  });
});

