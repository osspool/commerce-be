/**
 * Musok Service — shared Mushak 6.3 generation from internal sources.
 *
 * Both the manual `/musok/generate` HTTP endpoint and the auto-generation
 * event handler (`order-fulfilled-mushak.bridge`) call into here so the
 * tax math, fiscal-position resolution, serial allocation, and persistence
 * stay in one place.
 *
 * Idempotency: keyed on (sourceModel, sourceId). Re-running for the same
 * order is a no-op — returns the existing doc.
 *
 * Compliance posture:
 *   - Issued status: 'issued' on persist (not 'draft'). Mushak 6.3 is the
 *     legal VAT invoice — once goods are supplied, the form must be issued
 *     to the buyer with a serial number per BD VAT Act § 51. Drafts are
 *     not a recognised state for this form.
 *   - Best-effort on auto-generate: a missing seller BIN means the company
 *     hasn't completed VAT registration yet — return a typed error so the
 *     bridge can log + skip without blowing up the COGS chain.
 */

import type {
  LineItemInput,
  MusokBuyerInfo,
  VatRateCode,
} from '@classytic/bd-tax';
import { buildMushak63, calculateInvoiceTax } from '@classytic/bd-tax';
import mongoose from 'mongoose';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import PlatformConfig from '#resources/platform/platform.model.js';
import { ensureOrderEngine } from '#resources/sales/orders/order.engine.js';
import { taxResolver } from '../accounting.engine.js';
import musokInvoiceRepository from './musok.repository.js';

interface SellerInfo {
  bin: string;
  name: string;
  address: string;
  activityType: string | undefined;
}

export class MushakGenerationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MushakGenerationError';
  }
}

async function loadSeller(): Promise<SellerInfo | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = await (PlatformConfig as any).getConfig();
  const vat = config.vat || {};
  if (!vat.bin) return null;
  return {
    bin: vat.bin as string,
    name: (vat.registeredName || config.platformName || 'Unknown') as string,
    address: (vat.vatCircle || 'Bangladesh') as string,
    activityType: vat.activityType as string | undefined,
  };
}

async function resolveBranchCode(orgId: string): Promise<string> {
  const branch = await branchRepository.getById(orgId);
  return branch?.code || 'HQ';
}

// ── Order shape (just what we need — duplicated rather than imported to keep
// the seam between accounting/sales narrow). ─────────────────────────────────
interface OrderForMushak {
  _id: mongoose.Types.ObjectId | string;
  orderNumber?: string;
  organizationId?: mongoose.Types.ObjectId | string;
  branch?: mongoose.Types.ObjectId | string;
  customerSnapshot?: { name?: string; email?: string; phone?: string };
  shippingAddress?: { addressLine1?: string; addressLine2?: string; city?: string; country?: string };
  billingAddress?: { addressLine1?: string; addressLine2?: string; city?: string; country?: string };
  lines?: Array<{
    snapshot?: { sku?: string; name?: string; unitPrice?: number };
    quantity?: number;
    unitPrice?: { amount: number; currency: string };
    unitTax?: { amount: number; currency: string };
    unitDiscount?: { amount: number; currency: string };
    vatRateCode?: VatRateCode;
    vatRate?: number;
  }>;
  fulfilledAt?: Date | string;
  confirmedAt?: Date | string;
  placedAt?: Date | string;
  createdAt?: Date | string;
}

function buildBuyerFromOrder(order: OrderForMushak): MusokBuyerInfo {
  const cs = order.customerSnapshot ?? {};
  const addr = order.billingAddress ?? order.shippingAddress ?? {};
  const addrParts = [addr.addressLine1, addr.addressLine2, addr.city, addr.country].filter(Boolean);
  return {
    name: cs.name?.trim() || 'Walk-in customer',
    address: addrParts.join(', ') || undefined,
  };
}

function inferVatRate(unitPriceMinor: number, unitTaxMinor: number): number {
  if (!unitPriceMinor || unitPriceMinor <= 0) return 0;
  return Math.round((unitTaxMinor / unitPriceMinor) * 1000) / 10; // one-decimal
}

function rateToCode(rate: number): VatRateCode {
  if (rate === 0) return 'EXEMPT';
  if (rate === 15) return 'STANDARD';
  if (rate === 10) return 'REDUCED_10';
  if (rate === 7.5) return 'REDUCED_7_5';
  if (rate === 5) return 'REDUCED_5';
  return 'STANDARD';
}

function buildLineInputsFromOrder(order: OrderForMushak): LineItemInput[] {
  return (order.lines ?? []).map((line) => {
    const unitPriceMinor = line.unitPrice?.amount ?? line.snapshot?.unitPrice ?? 0;
    const unitTaxMinor = line.unitTax?.amount ?? 0;
    const unitDiscountMinor = line.unitDiscount?.amount ?? 0;
    let vatRateCode: VatRateCode;
    if (line.vatRateCode) {
      vatRateCode = line.vatRateCode;
    } else if (line.vatRate !== undefined) {
      vatRateCode = rateToCode(line.vatRate);
    } else if (unitTaxMinor > 0) {
      vatRateCode = rateToCode(inferVatRate(unitPriceMinor, unitTaxMinor));
    } else {
      // No tax info on the line — fall back to STANDARD rather than inferring
      // EXEMPT from missing data. POS / e-commerce orders don't carry per-line
      // tax fields; assuming exempt would silently zero out output VAT.
      vatRateCode = 'STANDARD';
    }
    return {
      description: line.snapshot?.name || line.snapshot?.sku || 'Item',
      quantity: line.quantity ?? 1,
      unitPrice: unitPriceMinor,
      vatRateCode,
      discount: unitDiscountMinor,
    };
  });
}

export interface GenerateMushakInput {
  orderId: string;
  /** Optional override; falls back to order.organizationId. */
  organizationId?: string;
  /** Optional issue date; falls back to order.fulfilledAt / confirmedAt / now. */
  date?: Date;
}

export interface GenerateMushakResult {
  /** True when an existing doc was returned instead of creating a new one. */
  alreadyExists: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any;
}

/**
 * Generate (or look up) a Mushak 6.3 invoice for an order. Idempotent on
 * (sourceModel='Order', sourceId=orderId).
 *
 * Throws `MushakGenerationError` with codes:
 *   - 'ORDER_NOT_FOUND'      — orderId not present in DB
 *   - 'NO_LINES'             — order has no lines (corrupt / not a sale)
 *   - 'SELLER_BIN_MISSING'   — Platform Config VAT BIN not set yet
 *   - 'SRO_REFERENCE_REQUIRED' — fiscal position needs SRO but none provided
 */
export async function generateMushakFromOrder(
  input: GenerateMushakInput,
): Promise<GenerateMushakResult> {
  const orderObjectId = new mongoose.Types.ObjectId(input.orderId);
  // Route through the order kernel's mongokit Repository so soft-delete /
  // tenant / hooks / cache plugins fire — never `db.collection('orders')`.
  const orderEngine = await ensureOrderEngine();
  const orderRepo = orderEngine.repositories.order as unknown as {
    getById: (
      id: string,
      options: { lean?: boolean; throwOnNotFound?: boolean },
    ) => Promise<OrderForMushak | null>;
  };
  const order = await orderRepo.getById(input.orderId, { lean: true, throwOnNotFound: false });
  if (!order) throw new MushakGenerationError('ORDER_NOT_FOUND', `Order ${input.orderId} not found`);
  if (!order.lines?.length) throw new MushakGenerationError('NO_LINES', `Order ${input.orderId} has no lines`);

  // Idempotency check — if a Musok already exists for this order, return it.
  const existing = await musokInvoiceRepository.getByQuery(
    { sourceModel: 'Order', sourceId: orderObjectId },
    { throwOnNotFound: false },
  );
  if (existing) {
    return { alreadyExists: true, doc: existing };
  }

  const seller = await loadSeller();
  if (!seller) throw new MushakGenerationError('SELLER_BIN_MISSING', 'Seller BIN is not configured in Platform Config → VAT');

  const orgId =
    input.organizationId ??
    (order.organizationId && String(order.organizationId)) ??
    (order.branch && String(order.branch));
  const branchCode = orgId ? await resolveBranchCode(orgId) : 'HQ';
  const invoiceDate =
    input.date ??
    (order.fulfilledAt ? new Date(order.fulfilledAt) :
     order.confirmedAt ? new Date(order.confirmedAt) :
     order.placedAt ? new Date(order.placedAt) :
     order.createdAt ? new Date(order.createdAt) : new Date());
  const year = invoiceDate.getFullYear();

  const buyer = buildBuyerFromOrder(order);
  const lineInputs = buildLineInputsFromOrder(order);

  // Fiscal position: domestic retail buyers with no BIN → NATIONAL. The
  // resolver tolerates undefined for unregistered consumer sales.
  const fp = taxResolver.resolveFiscalPosition?.(
    {
      countryCode: order.shippingAddress?.country ?? 'BD',
      bin: buyer.bin,
    },
    { countryCode: 'BD' },
    invoiceDate,
  );

  if (fp && fp.position === 'EXEMPT_NGO' && !fp.reference) {
    throw new MushakGenerationError(
      'SRO_REFERENCE_REQUIRED',
      'NGO exemption claimed without SRO / certificate reference',
    );
  }

  // Apply fiscal-position remap to each line.
  const remapped: LineItemInput[] = lineInputs.map((li) => {
    const original = li.vatRateCode ?? ('STANDARD' as VatRateCode);
    const mapped = (fp?.mapTaxClass?.(original as string) ?? original) as VatRateCode;
    const effective: VatRateCode =
      (mapped as string) === 'ZERO_EXPORT'
        ? ('ZERO' as VatRateCode)
        : (mapped as string).startsWith('EXEMPT')
          ? ('EXEMPT' as VatRateCode)
          : mapped;
    return { ...li, vatRateCode: effective };
  });

  const { lines: calcLines, summary } = calculateInvoiceTax(remapped);

  const { serial: mushakSerial, number: serialNumber } =
    await musokInvoiceRepository.nextSerial(branchCode, year);

  const mushak63 = buildMushak63({
    mushakSerial,
    date: invoiceDate,
    seller,
    buyer,
    lineResults: calcLines,
    summary,
  });

  const doc = await musokInvoiceRepository.create({
    mushakSerial,
    serialYear: year,
    serialNumber,
    branchCode,
    organizationId: orgId ? new mongoose.Types.ObjectId(orgId) : undefined,
    sourceModel: 'Order',
    sourceId: orderObjectId,
    seller: mushak63.seller,
    buyer: mushak63.buyer,
    date: invoiceDate,
    lines: mushak63.lines,
    totalValue: mushak63.totalValue,
    totalSd: mushak63.totalSd,
    totalVat: mushak63.totalVat,
    grandTotal: mushak63.grandTotal,
    status: 'issued',
    fiscalPosition: fp?.position ?? 'NATIONAL',
    sroReference: fp?.reference ?? null,
    exemptionReason: fp && fp.position !== 'NATIONAL' ? fp.reason : null,
    metadata: {
      autoGenerated: true,
      orderNumber: order.orderNumber,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return { alreadyExists: false, doc };
}
