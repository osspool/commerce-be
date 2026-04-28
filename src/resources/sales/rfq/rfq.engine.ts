import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';

const orderEngine = await ensureOrderEngine();

if (!orderEngine.models.Rfq || !orderEngine.repositories.rfq) {
  throw new Error('[rfq] order engine has no Rfq — enable modules.rfq in order.engine.ts');
}

export const rfqModel = orderEngine.models.Rfq;
export const rfqRepository = orderEngine.repositories.rfq;
