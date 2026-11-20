import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { netUnitCost } from '../../purchase-domain/procurement-support';
import { PurchaseFeatureConfig } from '../../config/domains/features/purchase-feature.config';

/** Receipt states whose accepted quantities are real (the goods are in stock). */
export const ACCEPTED_RECEIPT_STATUSES = ['ACCEPTED', 'COMPLETED', 'CLOSED'] as const;

/** Bill states that hold billed quantity against a receipt line. */
const LIVE_BILL_STATUSES_EXCLUDED = ['DRAFT', 'REJECTED', 'CANCELLED'] as const;

export interface BillHeader {
  supplierId: string;
  purchaseOrderId?: string | null;
  goodsReceiptId?: string | null;
}

export interface BillLineToMatch {
  productId: string;
  variantId?: string | null;
  purchaseOrderLineId?: string | null;
  grnLineId?: string | null;
  billedQuantity: Prisma.Decimal | number | string;
  /** Taxable value of the line (GST excluded), 2 dp. */
  baseAmount: Prisma.Decimal;
}

export interface MatchOptions {
  /** Submission: every line must be matched and the quantities are checked cumulatively. */
  final: boolean;
  /** The bill being re-validated, excluded from the other bills' billed quantities. */
  excludeBillId?: string;
}

const bad = (message: string, code: string, details?: Record<string, unknown>) => new BadRequestException({ message, code, details });

@Injectable()
export class VendorBillMatchingService {
  constructor(private readonly config: PurchaseFeatureConfig) {}

  /**
   * Three-way match (roadmap 4.2, release audit S8/S9): a bill line that is
   * matched names both its purchase-order line and its goods-receipt line,
   * and they must agree with each other, with the line's product (and
   * variant) and with the bill: the order and the receipt are the bill's
   * supplier's, the receipt line belongs to the bill's receipt and the order
   * line to the bill's order when the bill names them, and the receipt was
   * accepted (its accepted quantities are in stock). The unit price (GST
   * excluded) must equal the order line's net unit cost within
   * `PURCHASE_BILL_PRICE_TOLERANCE_PERCENT` (and one paisa of rounding).
   * At submission every line must be matched, and the quantity billed over
   * every live bill of a receipt line may not exceed what that line accepted
   * nor what was ordered: a bill pays for goods that are in stock.
   */
  async enforceThreeWayMatch(tx: Prisma.TransactionClient, shopId: string, bill: BillHeader, lines: BillLineToMatch[], options: MatchOptions) {
    const tolerance = new Prisma.Decimal(this.config.billPriceTolerancePercent).dividedBy(100);
    const billedPerGrnLine = new Map<string, Prisma.Decimal>();

    for (const billLine of lines) {
      const referenced = Boolean(billLine.purchaseOrderLineId || billLine.grnLineId);
      if (!referenced && !options.final && !bill.purchaseOrderId && !bill.goodsReceiptId) continue;
      if (!billLine.purchaseOrderLineId || !billLine.grnLineId) {
        throw bad('Every line of a vendor bill must name the purchase-order line and the goods-receipt line it bills.', 'VENDOR_BILL_LINE_UNMATCHED', { productId: billLine.productId });
      }

      const poLine = await tx.purchaseOrderItem.findFirst({
        where: { id: billLine.purchaseOrderLineId, shopId, isDeleted: false },
        include: { purchaseOrder: { select: { id: true, supplierId: true, isDeleted: true } } },
      });
      const grnLine = await tx.goodsReceiptLine.findFirst({
        where: { id: billLine.grnLineId, shopId, isDeleted: false },
        include: { goodsReceipt: { select: { id: true, supplierId: true, status: true, purchaseOrderId: true, isDeleted: true } } },
      });
      if (!poLine || !grnLine || poLine.purchaseOrder.isDeleted || grnLine.goodsReceipt.isDeleted) {
        throw bad('Matching documents not found for the three-way match.', 'VENDOR_BILL_MATCH_NOT_FOUND', { purchaseOrderLineId: billLine.purchaseOrderLineId, grnLineId: billLine.grnLineId });
      }
      if (grnLine.productId !== billLine.productId || poLine.productId !== billLine.productId) {
        throw bad('Three-way match failed: the bill line names a different product than the matched order and receipt lines.', 'VENDOR_BILL_LINE_MISMATCH', { grnLineId: grnLine.id });
      }
      if (billLine.variantId && (grnLine.variantId ?? null) !== billLine.variantId) {
        throw bad('Three-way match failed: the bill line names a different variant than the receipt line.', 'VENDOR_BILL_LINE_MISMATCH', { grnLineId: grnLine.id });
      }
      if (grnLine.purchaseOrderItemId !== poLine.id) {
        throw bad('Three-way match failed: the receipt line does not fulfil the named order line.', 'VENDOR_BILL_LINE_MISMATCH', { grnLineId: grnLine.id, purchaseOrderLineId: poLine.id });
      }
      if (poLine.purchaseOrder.supplierId !== bill.supplierId || grnLine.goodsReceipt.supplierId !== bill.supplierId) {
        throw bad('Three-way match failed: the order or the receipt belongs to another supplier.', 'VENDOR_BILL_SUPPLIER_MISMATCH', { grnLineId: grnLine.id });
      }
      if (bill.purchaseOrderId && poLine.purchaseOrderId !== bill.purchaseOrderId) {
        throw bad('Three-way match failed: the order line belongs to another purchase order than the bill.', 'VENDOR_BILL_LINE_MISMATCH', { purchaseOrderLineId: poLine.id });
      }
      if (bill.goodsReceiptId && grnLine.goodsReceiptId !== bill.goodsReceiptId) {
        throw bad('Three-way match failed: the receipt line belongs to another goods receipt than the bill.', 'VENDOR_BILL_LINE_MISMATCH', { grnLineId: grnLine.id });
      }
      if (!(ACCEPTED_RECEIPT_STATUSES as readonly string[]).includes(grnLine.goodsReceipt.status)) {
        throw bad(`Three-way match failed: goods receipt is ${grnLine.goodsReceipt.status}; only accepted goods can be billed.`, 'VENDOR_BILL_RECEIPT_NOT_ACCEPTED', { goodsReceiptId: grnLine.goodsReceiptId, status: grnLine.goodsReceipt.status });
      }

      // Price: the bill's unit price before GST against the order line's net unit cost.
      const quantity = new Prisma.Decimal(billLine.billedQuantity.toString());
      const billedUnit = billLine.baseAmount.dividedBy(quantity);
      const orderedUnit = netUnitCost(poLine);
      const allowed = orderedUnit.times(tolerance).plus('0.01');
      if (billedUnit.minus(orderedUnit).abs().greaterThan(allowed)) {
        throw bad(
          `Three-way match failed: billed unit price ${billedUnit.toFixed(2)} (before GST) differs from the purchase order's ${orderedUnit.toFixed(2)}.`,
          'VENDOR_BILL_PRICE_MISMATCH',
          { purchaseOrderLineId: poLine.id, billed: billedUnit.toFixed(2), ordered: orderedUnit.toFixed(2), tolerancePercent: this.config.billPriceTolerancePercent },
        );
      }

      if (!options.final) continue;
      // Quantity: cumulative over the other live bills of the same receipt line (roadmap 4.2).
      const priorBilled = await tx.vendorBillLine.aggregate({
        where: {
          grnLineId: grnLine.id,
          shopId,
          isDeleted: false,
          vendorBill: { isDeleted: false, status: { notIn: [...LIVE_BILL_STATUSES_EXCLUDED] }, ...(options.excludeBillId ? { id: { not: options.excludeBillId } } : {}) },
        },
        _sum: { billedQuantity: true },
      });
      const thisBill = (billedPerGrnLine.get(grnLine.id) ?? new Prisma.Decimal(0)).plus(quantity);
      billedPerGrnLine.set(grnLine.id, thisBill);
      const billed = thisBill.plus(priorBilled._sum.billedQuantity ?? 0);
      if (billed.greaterThan(grnLine.acceptedQuantity)) {
        throw bad(`Three-way match failed: billed quantity (${billed.toString()}) exceeds the accepted quantity (${grnLine.acceptedQuantity.toString()}).`, 'VENDOR_BILL_OVER_BILLED', {
          grnLineId: grnLine.id,
          billed: billed.toString(),
          accepted: grnLine.acceptedQuantity.toString(),
        });
      }
      if (billed.greaterThan(poLine.quantity)) {
        throw bad(`Three-way match failed: billed quantity (${billed.toString()}) exceeds the ordered quantity (${poLine.quantity.toString()}).`, 'VENDOR_BILL_OVER_BILLED', {
          purchaseOrderLineId: poLine.id,
          billed: billed.toString(),
          ordered: poLine.quantity.toString(),
        });
      }
    }
  }
}
