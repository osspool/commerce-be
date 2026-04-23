/**
 * Scan resolution schemas — Zod v4.
 *
 * Resolves arbitrary scan tokens (barcodes, QR, RFID, plain SKU) to
 * typed entity references.
 */
import { z } from 'zod';

const successEnvelope = (dataSchema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: dataSchema });

const scanResult = z.object({
  token: z.string().describe('Original scanned token'),
  resolvedType: z
    .enum(['sku', 'lot', 'serial', 'location', 'package', 'document', 'unknown'])
    .describe('Resolved entity type'),
  resolvedId: z.string().nullable().describe('Resolved entity ID, or null when unknown'),
  resolvedEntity: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('Resolved entity details, or null when unknown'),
  action: z.enum(['receive', 'pick', 'move', 'count', 'verify']).optional(),
});

export const scanSchemas = {
  resolve: {
    body: z.object({
      token: z.string().min(1).describe('Barcode, QR code, RFID, or SKU token to resolve'),
    }),
    response: { 200: successEnvelope(scanResult) },
  },
};
