import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';

/** Return states that hold quantity against a receipt line; drafts, rejections and cancellations do not. */
export const COUNTED_RETURN_STATUSES = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'SHIPPED', 'COMPLETED'] as const;

/** Receipt states whose accepted quantities are in stock (the goods can go back). */
export const RETURNABLE_RECEIPT_STATUSES = ['ACCEPTED', 'COMPLETED', 'CLOSED'] as const;

export interface ReturnLineCheck {
  grnLineId?: string | null;
  productId: string;
  /** Optional on input: the receipt line decides it, a different one is refused. */
  variantId?: string | null;
  returnQuantity: Decimal.Value;
}

export interface ReturnCheckOptions {
  excludeReturnId?: string;
  /** The return's goods receipt, when it names one: every line must come from it. */
  goodsReceiptId?: string | null;
  /** The return's supplier: every receipt line must be from a receipt of this supplier. */
  supplierId?: string;
  /** The return's warehouse, when it names one: the receipts must have landed there. */
  warehouseId?: string | null;
}

export interface ValidatedReturnLine {
  grnLineId: string;
  /** The receipt line's own price: the return is valued at what the goods cost, never at a client figure. */
  unitPrice: Prisma.Decimal;
  accepted: Prisma.Decimal;
  previouslyReturned: Prisma.Decimal;
  /** The receipt line's variant: the stock row the goods leave. */
  variantId: string | null;
  /** The warehouse the receipt put the goods in: where they leave from. */
  warehouseId: string;
  goodsReceiptId: string;
}

const mismatch = (message: string, details: Record<string, unknown>) => new BadRequestException({ message, code: 'PURCHASE_RETURN_LINE_MISMATCH', details });

/**
 * Over-return guard (roadmap 4.2, audit "over-return double count") and the
 * receipt as the authority of a return line (release audit S7/S8). For every
 * line the quantity already returned against the same receipt line is the
 * sum over OTHER returns that are live (this return's own rows are
 * excluded, so validating after insert no longer counts the line twice), and
 * lines of one return that point at the same receipt line are summed once.
 * The receipt line must carry the line's product (and variant, when the
 * client names one), belong to the return's goods receipt when one is named,
 * come from an ACCEPTED / COMPLETED / CLOSED receipt (only those quantities
 * are in stock) of the return's supplier, and the variant and the warehouse
 * the goods leave from are the receipt's, never the client's.
 */
@Injectable()
export class PurchaseReturnValidationService {
  async validateReturnLines(
    tx: Prisma.TransactionClient,
    shopId: string,
    lines: ReturnLineCheck[],
    options: ReturnCheckOptions = {},
  ): Promise<Map<string, ValidatedReturnLine>> {
    const byGrnLine = new Map<string, { productId: string; variantId: string | null | undefined; returning: Decimal }>();
    for (const line of lines) {
      if (!line.grnLineId) {
        throw new BadRequestException({ message: 'A purchase return line must reference the goods receipt line it returns.', code: 'PURCHASE_RETURN_LINE_UNLINKED' });
      }
      const returning = new Decimal(line.returnQuantity || 0);
      if (!returning.greaterThan(0)) throw new BadRequestException({ message: 'Return quantity must be greater than zero.', code: 'PURCHASE_RETURN_QTY_INVALID' });
      const current = byGrnLine.get(line.grnLineId);
      if (current && current.productId !== line.productId) {
        throw new BadRequestException({ message: 'Lines of one receipt line must carry the same product.', code: 'PURCHASE_RETURN_LINE_MISMATCH' });
      }
      byGrnLine.set(line.grnLineId, { productId: line.productId, variantId: line.variantId ?? current?.variantId, returning: (current?.returning ?? new Decimal(0)).plus(returning) });
    }

    const result = new Map<string, ValidatedReturnLine>();
    for (const [grnLineId, { productId, variantId, returning }] of byGrnLine) {
      const grnLine = await tx.goodsReceiptLine.findFirst({
        where: { id: grnLineId, shopId, isDeleted: false },
        select: { id: true, productId: true, variantId: true, goodsReceiptId: true, acceptedQuantity: true, unitPrice: true, goodsReceipt: { select: { status: true, supplierId: true, warehouseId: true, isDeleted: true } } },
      });
      if (!grnLine || grnLine.goodsReceipt?.isDeleted) throw new BadRequestException({ message: 'Matching goods receipt line not found for return validation', code: 'PURCHASE_RETURN_GRN_LINE_NOT_FOUND' });
      if (grnLine.productId !== productId) throw mismatch('The receipt line carries a different product.', { grnLineId });
      if (variantId && (grnLine.variantId ?? null) !== variantId) throw mismatch('The receipt line carries a different variant.', { grnLineId, variantId: grnLine.variantId });
      if (options.goodsReceiptId && grnLine.goodsReceiptId !== options.goodsReceiptId) throw mismatch('The receipt line belongs to a different goods receipt.', { grnLineId });
      const receipt = grnLine.goodsReceipt;
      if (receipt) {
        if (!(RETURNABLE_RECEIPT_STATUSES as readonly string[]).includes(receipt.status)) {
          throw new BadRequestException({ message: `Goods receipt is ${receipt.status}; only accepted goods can be returned.`, code: 'PURCHASE_RETURN_RECEIPT_NOT_ACCEPTED', details: { grnLineId, status: receipt.status } });
        }
        if (options.supplierId && receipt.supplierId !== options.supplierId) {
          throw new BadRequestException({ message: 'The receipt line belongs to a receipt of another supplier.', code: 'PURCHASE_RETURN_SUPPLIER_MISMATCH', details: { grnLineId } });
        }
        if (options.warehouseId && receipt.warehouseId !== options.warehouseId) {
          throw mismatch('The goods of this receipt line were received into another warehouse.', { grnLineId, warehouseId: receipt.warehouseId });
        }
      }

      const previous = await tx.purchaseReturnLine.aggregate({
        where: {
          grnLineId,
          shopId,
          isDeleted: false,
          purchaseReturn: { isDeleted: false, status: { in: [...COUNTED_RETURN_STATUSES] }, ...(options.excludeReturnId ? { id: { not: options.excludeReturnId } } : {}) },
        },
        _sum: { returnQuantity: true },
      });
      const previouslyReturned = new Decimal(previous._sum.returnQuantity?.toString() ?? 0);
      const accepted = new Decimal(grnLine.acceptedQuantity.toString());
      if (returning.plus(previouslyReturned).greaterThan(accepted)) {
        throw new BadRequestException({
          message: `Over-return: ${returning.toString()} requested with ${previouslyReturned.toString()} already returned exceeds the accepted quantity ${accepted.toString()}.`,
          code: 'PURCHASE_RETURN_OVER_RETURN',
          details: { grnLineId, accepted: accepted.toNumber(), previouslyReturned: previouslyReturned.toNumber(), requested: returning.toNumber() },
        });
      }
      result.set(grnLineId, {
        grnLineId,
        unitPrice: grnLine.unitPrice,
        accepted: grnLine.acceptedQuantity,
        previouslyReturned: new Prisma.Decimal(previouslyReturned.toString()),
        variantId: grnLine.variantId ?? null,
        warehouseId: receipt?.warehouseId ?? '',
        goodsReceiptId: grnLine.goodsReceiptId,
      });
    }
    return result;
  }
}
