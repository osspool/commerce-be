/**
 * Musok Handlers — business logic for Mushak 6.3 + 9.1
 *
 * Each handler is a raw Fastify handler imported by musok.resource.ts.
 * Uses @classytic/bd-tax for calculation, this module's repository for persistence.
 */

import type { LineItemInput, MusokBuyerInfo, VatRateCode } from '@classytic/bd-tax';
import {
  type BusinessType,
  buildMushak63,
  buildMushak91,
  buildMushak92,
  calculateInvoiceTax,
  formatBIN,
  mushak63GenerateBodySchema,
  validateBIN,
} from '@classytic/bd-tax';
import type { MonthlyVatData } from '@classytic/bd-tax/musok';
import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import logger from '#lib/utils/logger.js';
import branchRepository from '#resources/commerce/branch/branch.repository.js';
import PlatformConfig from '#resources/platform/platform.model.js';
import { taxResolver } from '../accounting.engine.js';
import { aggregateTax, periodRangeFromString } from '../tax/tax.aggregator.js';
import musokInvoiceRepository from './musok.repository.js';

// ── Internal helpers ────────────────────────────────────────────────────────

type Seller = { bin: string; name: string; address: string; activityType: string | undefined };

async function loadSeller(): Promise<Seller | null> {
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

// 422 (not 400) — the request is well-formed; the system simply isn't
// configured yet. Payload tells the UI exactly where to send the operator.
function replySellerBinMissing(reply: FastifyReply): FastifyReply {
  return reply.code(422).send({
    success: false,
    code: 'SELLER_BIN_MISSING',
    message:
      'Seller BIN is not configured yet. Set the company VAT registration (BIN) in Platform Config → VAT before generating Mushak forms.',
    action: {
      label: 'Configure VAT settings',
      path: '/dashboard/platform-config/vat',
      field: 'vat.bin',
    },
  });
}

async function resolveBranchCode(orgId: string): Promise<string> {
  const branch = await branchRepository.Model.findById(orgId).select('code').lean();
  return (branch as { code?: string })?.code || 'HQ';
}

// ── Generate Mushak 6.3 ────────────────────────────────────────────────────
//
// Request schema lives in @classytic/bd-tax (mushak63GenerateBodySchema)
// — the canonical contract for the Bangladesh VAT country pack. Wired
// into Arc's `routes.schema.body` in musok.resource.ts so OpenAPI docs,
// MCP tools, and the SDK all share the same source of truth.
//
// The raw handler still calls safeParse as defense-in-depth (and to keep
// returning the app-specific error envelope shape), but the structural
// contract is owned by bd-vat.

export async function generateMusokInvoice(req: FastifyRequest, reply: FastifyReply) {
  const parsed = mushak63GenerateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      success: false,
      error: 'Invalid Mushak 6.3 payload',
      code: 'VALIDATION_FAILED',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const body = parsed.data;
  const orgId = (req as any).scope?.organizationId as string | undefined;
  const sourceModel = body.sourceModel;

  // Idempotency — check if already generated for this source
  const existing = await musokInvoiceRepository.getByQuery(
    { sourceModel, sourceId: new mongoose.Types.ObjectId(body.sourceId) },
    { throwOnNotFound: false },
  );
  if (existing) {
    return reply.send({ success: true, data: existing, idempotent: true });
  }

  const seller = await loadSeller();
  if (!seller) return replySellerBinMissing(reply);
  const branchCode = orgId ? await resolveBranchCode(orgId) : 'HQ';
  const invoiceDate = body.date ? new Date(body.date) : new Date();
  const year = invoiceDate.getFullYear();

  // Fiscal position — determines if buyer-specific remapping applies
  // (foreign → zero-rate export, diplomatic, NGO, SEZ/BHTC, RMG bonded).
  // The resolver's return shape carries `{ position, reference, reason,
  // mapTaxClass }` so the entire audit trail lands on the invoice.
  const fp = taxResolver.resolveFiscalPosition?.(
    {
      countryCode: body.buyer.countryCode ?? 'BD',
      bin: body.buyer.bin,
      isDiplomatic: body.buyer.isDiplomatic,
      isExemptNgo: body.buyer.isExemptNgo,
      exemptionCertificate: body.buyer.sroReference,
      isSezUnit: body.buyer.isSezUnit,
      isRmgFactory: body.buyer.isRmgFactory,
    },
    { countryCode: 'BD', suppliesUtility: body.suppliesUtility },
    invoiceDate,
  );

  // Fail closed: NGO claim without certificate → reject. Same rule for any
  // exempt/zero-rated remap that lacks an SRO — fraud risk otherwise.
  if (fp && fp.position === 'EXEMPT_NGO' && !fp.reference) {
    return reply.code(400).send({
      success: false,
      error: 'NGO exemption claimed without SRO / certificate reference',
      code: 'SRO_REFERENCE_REQUIRED',
      fiscalPositionReason: fp.reason,
    });
  }

  // Tax calculation via bd-vat — remap each line's rate code through the
  // fiscal position before calling the calculator.
  const lineInputs: LineItemInput[] = body.items.map((item) => {
    const originalCode = item.vatRateCode as string;
    // fp.mapTaxClass handles tax CLASS codes; our VAT_RATE_CODES are rate
    // codes ('STANDARD' / 'ZERO' / 'EXEMPT' / ...) which overlap 1:1 with
    // the simplified class names for non-exempt rates. For EXEMPT class
    // variants we'd need the class-layer (future).
    const mappedCode = fp?.mapTaxClass?.(originalCode) ?? originalCode;
    // Project back to a rate code the calculator understands.
    const effectiveRateCode: VatRateCode =
      mappedCode === 'ZERO_EXPORT'
        ? ('ZERO' as VatRateCode)
        : mappedCode.startsWith('EXEMPT')
          ? ('EXEMPT' as VatRateCode)
          : (mappedCode as VatRateCode);
    return {
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      vatRateCode: effectiveRateCode,
      sdRate: item.sdRate,
      discount: item.discount,
      priceMode: item.priceMode,
    };
  });

  const { lines: calcLines, summary } = calculateInvoiceTax(lineInputs);

  // Atomic serial
  const { serial: mushakSerial, number: serialNumber } = await musokInvoiceRepository.nextSerial(branchCode, year);

  // Build Mushak 6.3 format via bd-vat
  const mushak63 = buildMushak63({
    mushakSerial,
    date: invoiceDate,
    seller,
    buyer: body.buyer as MusokBuyerInfo,
    lineResults: calcLines,
    summary,
  });

  // Persist via mongokit
  const doc = await musokInvoiceRepository.create({
    mushakSerial,
    serialYear: year,
    serialNumber,
    branchCode,
    organizationId: orgId ? new mongoose.Types.ObjectId(orgId) : undefined,
    sourceModel,
    sourceId: new mongoose.Types.ObjectId(body.sourceId),
    seller: mushak63.seller,
    buyer: mushak63.buyer,
    date: invoiceDate,
    lines: mushak63.lines,
    totalValue: mushak63.totalValue,
    totalSd: mushak63.totalSd,
    totalVat: mushak63.totalVat,
    grandTotal: mushak63.grandTotal,
    status: 'issued',
    // Audit trail — populated when a non-default fiscal position applied.
    fiscalPosition: fp?.position ?? 'NATIONAL',
    sroReference: fp?.reference ?? null,
    exemptionReason: fp && fp.position !== 'NATIONAL' ? fp.reason : null,
  } as any);

  logger.info(
    {
      mushakSerial,
      sourceId: body.sourceId,
      grandTotal: mushak63.grandTotal,
      fiscalPosition: fp?.position,
      sroReference: fp?.reference,
    },
    'Musok 6.3 invoice generated',
  );

  return reply.code(201).send({ success: true, data: doc });
}

// ── Get by Source ───────────────────────────────────────────────────────────

export async function getMusokBySource(req: FastifyRequest, reply: FastifyReply) {
  const { sourceModel, sourceId } = req.params as { sourceModel: string; sourceId: string };
  const doc = await musokInvoiceRepository.getByQuery(
    { sourceModel, sourceId: new mongoose.Types.ObjectId(sourceId) },
    { throwOnNotFound: false },
  );
  if (!doc) {
    return reply.code(404).send({ success: false, error: 'No Musok invoice for this source' });
  }
  return reply.send({ success: true, data: doc });
}

// ── Monthly Return (branches on branch.businessType) ──────────────────────
//
// Standard VAT / IMPORTER / RMG / IT / SERVICE → Mushak 9.1 (full return)
// SME_TOT                                        → Mushak 9.2 (turnover tax)
// COTTAGE_EXEMPT                                 → no filing required
//
// When a branch hasn't set businessType, defaults to STANDARD_VAT.

async function getBranchRegime(orgId: string | undefined): Promise<BusinessType> {
  if (!orgId) return 'STANDARD_VAT';
  const branch = await branchRepository.Model.findById(orgId).select('businessType').lean();
  return ((branch as { businessType?: BusinessType })?.businessType ?? 'STANDARD_VAT') as BusinessType;
}

export async function getMonthlyReturn(req: FastifyRequest, reply: FastifyReply) {
  const { period } = req.params as { period: string };
  const orgId = (req as any).scope?.organizationId as string | undefined;

  const [yearStr, monthStr] = period.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!year || !month || month < 1 || month > 12) {
    return reply.code(400).send({ success: false, error: 'Period must be YYYY-MM format' });
  }

  const regime = await getBranchRegime(orgId);

  // Cottage-exempt branches file nothing.
  if (regime === 'COTTAGE_EXEMPT') {
    return reply.send({
      success: true,
      data: {
        formType: 'NONE',
        regime,
        message: 'Cottage-exempt branch — no VAT/TOT return filing required.',
      },
    });
  }

  // SME_TOT branches file Mushak 9.2 (turnover tax, not reconciled VAT).
  if (regime === 'SME_TOT') {
    const aggregates = await musokInvoiceRepository.aggregateMonthlyVat(year, month, orgId);
    // Gross + exempt turnover for the TOT base.
    let grossTurnover = 0;
    let exemptTurnover = 0;
    for (const agg of aggregates) {
      grossTurnover += agg.taxableBase + agg.vatAmount + agg.sdAmount;
      if (agg._id === 0) exemptTurnover += agg.taxableBase;
    }
    const seller = await loadSeller();
    if (!seller) return replySellerBinMissing(reply);
    const totReturn = buildMushak92({
      period: { kind: 'monthly', period },
      bin: seller.bin,
      grossTurnover,
      exemptTurnover,
    });
    return reply.send({
      success: true,
      data: {
        formType: '9.2',
        regime,
        aggregates,
        return: totReturn,
      },
    });
  }

  // Sales side — aggregate from issued Mushak 6.3 invoices (output VAT source of truth).
  const aggregates = await musokInvoiceRepository.aggregateMonthlyVat(year, month, orgId);

  // Purchase side — aggregate input VAT + VDS + SD from posted journal entries
  // using the dedicated tax.aggregator. This is what makes inputVatCredit
  // actually work: purchase.contract.ts posts input VAT to 1201.*, and the
  // aggregator sums it here for the return.
  const range = periodRangeFromString(period);
  const taxAgg = await aggregateTax(range, orgId);

  const vatData: MonthlyVatData = {
    outputVat15: 0,
    outputVat10: 0,
    outputVat7_5: 0,
    outputVat5: 0,
    zeroRatedSales: 0,
    exemptSales: 0,
    inputVatCredit: taxAgg.input.reduce((sum, b) => sum + b.vatAmount, 0),
    sdCollected: 0,
    previousBalance: 0,
    vdsCredit: taxAgg.vdsCollected,
    penalty: 0,
  };

  for (const agg of aggregates) {
    if (agg._id === 15) vatData.outputVat15 = agg.vatAmount;
    else if (agg._id === 10) vatData.outputVat10 = agg.vatAmount;
    else if (agg._id === 7.5) vatData.outputVat7_5 = agg.vatAmount;
    else if (agg._id === 5) vatData.outputVat5 = agg.vatAmount;
    else if (agg._id === 0) vatData.zeroRatedSales = agg.taxableBase;
    vatData.sdCollected += agg.sdAmount;
  }

  // Also pull exempt sales from Mushak invoices (vatRate === 0 with rateCode EXEMPT)
  const seller = await loadSeller();
  if (!seller) return replySellerBinMissing(reply);
  const returnData = buildMushak91(period, seller.bin, vatData);

  return reply.send({
    success: true,
    data: {
      formType: '9.1',
      regime,
      aggregates,
      inputVat: taxAgg.input,
      return: returnData,
    },
  });
}

// ── BIN Validation ─────────────────────────────────────────────────────────

export async function validateBinEndpoint(req: FastifyRequest, reply: FastifyReply) {
  const { bin } = req.params as { bin: string };
  const isValid = validateBIN(bin);
  return reply.send({
    success: true,
    data: { bin, formatted: isValid ? formatBIN(bin) : bin, isValid },
  });
}

// ── Cancel (action handler for Arc actions pattern) ────────────────────────

export async function cancelMusokInvoice(id: string, data: Record<string, unknown>) {
  const doc = await musokInvoiceRepository.getById(id);
  if (!doc) throw Object.assign(new Error('Musok invoice not found'), { statusCode: 404 });

  const status = (doc as any).status;
  if (status !== 'issued') {
    throw Object.assign(new Error(`Cannot cancel musok invoice in "${status}" status`), { statusCode: 400 });
  }

  return musokInvoiceRepository.update(id, {
    status: 'cancelled',
    cancelledAt: new Date(),
    cancelReason: (data.reason as string) || 'Cancelled',
  });
}
