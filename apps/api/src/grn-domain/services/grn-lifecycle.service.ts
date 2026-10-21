import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { GoodsReceiptStatus, Prisma } from '@prisma/client';

@Injectable()
export class GrnLifecycleService {
  /**
   * Roadmap 4.2: receiving may be recorded in several rounds (RECEIVING ->
   * RECEIVING), inspection may be repeated, and a receipt is COMPLETED by an
   * approver other than its creator after the goods were accepted. Until the
   * goods are accepted nothing is in stock, so a receipt may still be
   * cancelled (by its own side) or rejected (the delivery refused by another
   * manager); release audit S24.
   */
  static readonly TRANSITIONS: Record<GoodsReceiptStatus, GoodsReceiptStatus[]> = {
    DRAFT: ['RECEIVING', 'CANCELLED'],
    RECEIVING: ['RECEIVING', 'PARTIALLY_RECEIVED', 'QUALITY_INSPECTION', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
    PARTIALLY_RECEIVED: ['RECEIVING', 'QUALITY_INSPECTION', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
    QUALITY_INSPECTION: ['QUALITY_INSPECTION', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
    ACCEPTED: ['COMPLETED'],
    COMPLETED: ['CLOSED'],
    CLOSED: ['ARCHIVED'],
    REJECTED: ['ARCHIVED'],
    CANCELLED: ['ARCHIVED'],
    ARCHIVED: [],
  };

  validateTransition(current: GoodsReceiptStatus, target: GoodsReceiptStatus) {
    if (!GrnLifecycleService.TRANSITIONS[current]?.includes(target)) {
      throw new BadRequestException({ message: `Invalid GRN transition from ${current} to ${target}`, code: 'GRN_TRANSITION_INVALID', details: { from: current, to: target } });
    }
  }

  /**
   * Compare-and-set transition (release audit S14): the row moves only while
   * it is still `currentStatus`, so of two concurrent actors one wins and the
   * other gets 409 GRN_STATE_CONFLICT instead of overwriting it.
   */
  async transitionStatus(
    tx: Prisma.TransactionClient,
    id: string,
    shopId: string,
    currentStatus: GoodsReceiptStatus,
    targetStatus: GoodsReceiptStatus,
    actorId: string,
    notes?: string
  ) {
    this.validateTransition(currentStatus, targetStatus);

    const moved = await tx.goodsReceipt.updateMany({ where: { id, shopId, status: currentStatus }, data: { status: targetStatus } });
    if (moved.count === 0) {
      throw new ConflictException({ message: 'The goods receipt changed state concurrently; reload and retry.', code: 'GRN_STATE_CONFLICT', details: { expected: currentStatus, target: targetStatus } });
    }

    await tx.goodsReceiptStatusHistory.create({
      data: {
        goodsReceiptId: id,
        shopId,
        status: targetStatus,
        actorId,
        notes
      }
    });
  }
}
