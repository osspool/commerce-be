import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';

const orderEngine = await ensureOrderEngine();

if (!orderEngine.models.BlanketOrder || !orderEngine.repositories.blanketOrder) {
  throw new Error('[blanket-order] order engine has no BlanketOrder — enable modules.blanket in order.engine.ts');
}

export const blanketOrderModel = orderEngine.models.BlanketOrder;
export const blanketOrderRepository = orderEngine.repositories.blanketOrder;
