/**
 * Purchase Order Route Schemas — Zod v4. Arc auto-converts via
 * `z.toJSONSchema()` at registration (Fastify validation + OpenAPI).
 *
 * The service still does normalization (supplier lookup, totals, invoice
 * numbering), but the wire shape is enforced at the gateway.
 */
import { z } from 'zod';

const paymentTerms = z.enum(['cash', 'credit']);
const paymentMethod = z.enum(['cash', 'bkash', 'nagad', 'rocket', 'bank_transfer', 'card']);

const purchaseItemInput = z
  .object({
    productId: z.string(),
    variantSku: z.string().nullable().optional(),
    quantity: z.number().min(0).optional(),
    costPrice: z.number().min(0).optional(),
    discount: z.number().min(0).optional(),
    taxRate: z.number().min(0).max(100).optional(),
    notes: z.string().optional(),
    destinationLocationId: z.string().optional(),
  })
  .strict();

const paymentInput = z
  .object({
    amount: z.number().min(0).optional(),
    method: z.string().optional(),
    reference: z.string().optional(),
    accountNumber: z.string().optional(),
    walletNumber: z.string().optional(),
    bankName: z.string().optional(),
    accountName: z.string().optional(),
    proofUrl: z.string().optional(),
    transactionDate: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const createSchema = {
  body: z
    .object({
      supplierId: z.string().optional(),
      branchId: z.string().optional(),
      purchaseOrderNumber: z.string().optional(),
      invoiceDate: z.string().optional(),
      paymentTerms: paymentTerms.optional(),
      creditDays: z.number().min(0).optional(),
      dueDate: z.string().optional(),
      notes: z.string().optional(),
      autoApprove: z.boolean().optional(),
      autoReceive: z.boolean().optional(),
      items: z.array(purchaseItemInput).min(1),
      payment: paymentInput.optional(),
    })
    .strict(),
};

export const updateSchema = {
  body: z
    .object({
      supplierId: z.string().optional(),
      purchaseOrderNumber: z.string().optional(),
      invoiceDate: z.string().optional(),
      paymentTerms: paymentTerms.optional(),
      creditDays: z.number().min(0).optional(),
      dueDate: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(purchaseItemInput).optional(),
    })
    .strict(),
};

// Action schemas — reason / pay payload. The pay action collects payment
// details, all optional (the service derives defaults from the PO).
export const payActionSchema = z.object({
  amount: z.number().optional(),
  method: paymentMethod.optional(),
  reference: z.string().optional(),
  accountNumber: z.string().optional(),
  walletNumber: z.string().optional(),
  bankName: z.string().optional(),
  accountName: z.string().optional(),
  proofUrl: z.string().optional(),
  transactionDate: z.string().optional(),
  notes: z.string().optional(),
});

export const cancelActionSchema = z.object({ reason: z.string().optional() });
