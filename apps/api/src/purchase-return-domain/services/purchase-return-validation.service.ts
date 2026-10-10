import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';

/** Return states that hold quantity against a receipt line; drafts, rejections and cancellations do not. */
export const COUNTED_RETURN_STATUSES = ['SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'SHIPPED', 'COMPLETED'] as const;

export interface ReturnLineCheck {
  grnLineId?: string | null;
  productId: string;
  returnQuantity: Decimal.Value;
}

export interface ValidatedReturnLine {
  grnLineId: string;
  /** The receipt line's own price: the return is valued at what the goods cost, never at a client figure. */
  unitPrice: Prisma.Decimal;
  accepted: Prisma.Decimal;
  previouslyReturned: Prisma.Decimal;
}

/**
 * Over-return guard (roadmap 4.2, audit "over-return double count"). For
 * every line the quantity already returned against the same receipt line is
 * the sum over OTHER returns that are live (this return's own rows are
 * excluded, so validating after insert no longer counts the line twice), and
 * lines of one return that point at the same receipt line are summed once.
 * The receipt line must belong to the return's goods receipt, when one is
 * named, and carry the line's product.
 */
@Injectable()
export class PurchaseReturnValidationService {
  async validateReturnLines(
    tx: Prisma.TransactionClient,
    shopId: string,
    lines: ReturnLineCheck[],
    options: { excludeReturnId?: string; goodsReceiptId?: string | null } = {},
  ): Promise<Map<string, ValidatedReturnLine>> {
    const byGrnLine = new Map<string, { productId: string; returning: Decimal }>();
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
      byGrnLine.set(line.grnLineId, { productId: line.productId, returning: (current?.returning ?? new Decimal(0)).plus(returning) });
    }

    const result = new Map<string, ValidatedReturnLine>();
    for (const [grnLineId, { productId, returning }] of byGrnLine) {
      const grnLine = await tx.goodsReceiptLine.findFirst({ where: { id: grnLineId, shopId, isDeleted: false }, select: { id: true, productId: true, goodsReceiptId: true, acceptedQuantity: true, unitPrice: true } });
      if (!grnLine) throw new BadRequestException({ message: 'Matching goods receipt line not found for return validation', code: 'PURCHASE_RETURN_GRN_LINE_NOT_FOUND' });
      if (grnLine.productId !== productId) throw new BadRequestException({ message: 'The receipt line carries a different product.', code: 'PURCHASE_RETURN_LINE_MISMATCH', details: { grnLineId } });
      if (options.goodsReceiptId && grnLine.goodsReceiptId !== options.goodsReceiptId) {
        throw new BadRequestException({ message: 'The receipt line belongs to a different goods receipt.', code: 'PURCHASE_RETURN_LINE_MISMATCH', details: { grnLineId } });
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
      result.set(grnLineId, { grnLineId, unitPrice: grnLine.unitPrice, accepted: grnLine.acceptedQuantity, previouslyReturned: new Prisma.Decimal(previouslyReturned.toString()) });
    }
    return result;
  }
}
