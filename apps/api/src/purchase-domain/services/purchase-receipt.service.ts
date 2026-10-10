import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PurchaseLifecycleService } from './purchase-lifecycle.service';

export interface OrderedLine {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  unit: string | null;
  /** Accepted so far by other receipts of this order line. */
  acceptedElsewhere: Prisma.Decimal;
}

/**
 * The purchase order as the authority of a goods receipt (roadmap 4.2): the
 * order must be receivable, each receipt line fulfils one order line, the
 * ordered quantity and the price come from that line, and the sum of accepted
 * quantities over every receipt of the order never exceeds what was ordered.
 * After an acceptance the order moves to PARTIALLY_RECEIVED or RECEIVED.
 */
@Injectable()
export class PurchaseReceiptService {
  constructor(private readonly lifecycle: PurchaseLifecycleService) {}

  /** Locks the order row (FOR UPDATE) and returns its receivable lines with what other receipts already accepted. */
  async lockReceivableOrder(tx: Prisma.TransactionClient, shopId: string, purchaseOrderId: string, excludeReceiptId?: string): Promise<{ id: string; supplierId: string; status: string; lines: OrderedLine[] }> {
    const rows = await tx.$queryRaw<Array<{ id: string; supplierId: string; status: string }>>`
      SELECT id, supplierId, status FROM PurchaseOrder WHERE id = ${purchaseOrderId} AND shopId = ${shopId} AND isDeleted = false FOR UPDATE
    `;
    if (rows.length === 0) throw new NotFoundException({ message: 'Purchase order not found', code: 'PURCHASE_ORDER_NOT_FOUND' });
    const po = rows[0];
    if (!PurchaseLifecycleService.RECEIVABLE.includes(po.status as never)) {
      throw new BadRequestException({ message: `Goods cannot be received against a ${po.status} purchase order.`, code: 'PURCHASE_ORDER_NOT_RECEIVABLE', details: { status: po.status } });
    }
    const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId, shopId, isDeleted: false }, select: { id: true, productId: true, variantId: true, quantity: true, unitCost: true, unit: true } });
    const accepted = await tx.goodsReceiptLine.groupBy({
      by: ['purchaseOrderItemId'],
      where: { shopId, purchaseOrderItemId: { in: items.map((i) => i.id) }, isDeleted: false, goodsReceipt: { status: { in: ['ACCEPTED', 'COMPLETED', 'CLOSED'] }, isDeleted: false, ...(excludeReceiptId ? { id: { not: excludeReceiptId } } : {}) } },
      _sum: { acceptedQuantity: true },
    });
    const acceptedByItem = new Map(accepted.map((a) => [a.purchaseOrderItemId, a._sum.acceptedQuantity ?? new Prisma.Decimal(0)]));
    return {
      ...po,
      lines: items.map((i) => ({ ...i, acceptedElsewhere: acceptedByItem.get(i.id) ?? new Prisma.Decimal(0) })),
    };
  }

  /**
   * Resolves the order line a receipt line fulfils: by `purchaseOrderItemId`
   * when given, otherwise by product and variant. A product that is not on
   * the order is refused.
   */
  resolveOrderLine(lines: OrderedLine[], line: { purchaseOrderItemId?: string | null; productId: string; variantId?: string | null }): OrderedLine {
    const match = line.purchaseOrderItemId
      ? lines.find((l) => l.id === line.purchaseOrderItemId)
      : lines.find((l) => l.productId === line.productId && (l.variantId ?? null) === (line.variantId ?? null));
    if (!match || match.productId !== line.productId) {
      throw new BadRequestException({ message: 'The receipt line does not match a line of the purchase order.', code: 'GRN_LINE_NOT_ON_ORDER', details: { productId: line.productId, purchaseOrderItemId: line.purchaseOrderItemId ?? null } });
    }
    return match;
  }

  /** After an acceptance: PARTIALLY_RECEIVED while something is still outstanding, RECEIVED once every line is covered. */
  async recordAcceptance(tx: Prisma.TransactionClient, shopId: string, purchaseOrderId: string, actorId: string, receiptNumber: string): Promise<'PARTIALLY_RECEIVED' | 'RECEIVED'> {
    const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId, shopId, isDeleted: false }, select: { id: true, quantity: true } });
    const accepted = await tx.goodsReceiptLine.groupBy({
      by: ['purchaseOrderItemId'],
      where: { shopId, purchaseOrderItemId: { in: items.map((i) => i.id) }, isDeleted: false, goodsReceipt: { status: { in: ['ACCEPTED', 'COMPLETED', 'CLOSED'] }, isDeleted: false } },
      _sum: { acceptedQuantity: true },
    });
    const acceptedByItem = new Map(accepted.map((a) => [a.purchaseOrderItemId, a._sum.acceptedQuantity ?? new Prisma.Decimal(0)]));
    const complete = items.every((i) => (acceptedByItem.get(i.id) ?? new Prisma.Decimal(0)).greaterThanOrEqualTo(i.quantity));
    const target = complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    const po = await tx.purchaseOrder.findFirstOrThrow({ where: { id: purchaseOrderId, shopId }, select: { status: true } });
    if (po.status !== target) await this.lifecycle.transitionStatus(tx, purchaseOrderId, shopId, po.status, target, actorId, `Goods accepted on ${receiptNumber}`);
    return target;
  }
}
