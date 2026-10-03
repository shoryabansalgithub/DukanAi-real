import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AdjustmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAdjustmentRequestDto } from '../dto/stock-count.dto';
import { AdjustmentPostingService } from './adjustment-posting.service';
import { assertOwned } from '../../prisma/tenant-ownership';

/**
 * Stock-count adjustments (roadmap 3.9, audit P0-2). Every request waits for
 * a manager: there is no auto-approval threshold, the approver can never be
 * the requester, and approval and posting happen in one transaction with
 * status-guarded transitions (PENDING_APPROVAL -> APPROVED -> POSTED), so two
 * concurrent approvals cannot both move stock. A request raised from a count
 * item takes its delta from the recorded variance, never from the caller.
 */
@Injectable()
export class AdjustmentApprovalService {
  private readonly logger = new Logger(AdjustmentApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postingService: AdjustmentPostingService,
  ) {}

  async requestAdjustment(shopId: string, requestedByUserId: string, dto: CreateAdjustmentRequestDto) {
    await assertOwned(this.prisma, 'inventoryItem', dto.inventoryItemId, shopId);
    await assertOwned(this.prisma, 'stockCountItem', dto.countItemId, shopId);

    let delta: Prisma.Decimal;
    if (dto.countItemId) {
      const countItem = await this.prisma.stockCountItem.findFirst({
        where: { id: dto.countItemId, shopId },
        select: { inventoryItemId: true, variance: true, countedQuantity: true },
      });
      if (!countItem) throw new NotFoundException('Count item not found');
      if (countItem.inventoryItemId !== dto.inventoryItemId) {
        throw new BadRequestException({ message: 'The count item belongs to a different inventory item.', code: 'COUNT_ITEM_MISMATCH' });
      }
      if (countItem.variance === null || countItem.countedQuantity === null) {
        throw new BadRequestException({ message: 'The count item has not been counted yet.', code: 'COUNT_ITEM_NOT_COUNTED' });
      }
      delta = countItem.variance;
      if (dto.requestedQuantityDelta !== undefined && !delta.equals(new Prisma.Decimal(dto.requestedQuantityDelta))) {
        throw new BadRequestException({ message: 'The requested delta must equal the recorded variance.', code: 'ADJUSTMENT_DELTA_MISMATCH', details: { variance: delta.toNumber() } });
      }
    } else {
      if (dto.requestedQuantityDelta === undefined) {
        throw new BadRequestException({ message: 'requestedQuantityDelta is required without a count item.', code: 'ADJUSTMENT_DELTA_REQUIRED' });
      }
      delta = new Prisma.Decimal(dto.requestedQuantityDelta);
    }
    if (delta.isZero()) throw new BadRequestException({ message: 'An adjustment needs a non-zero delta.', code: 'ADJUSTMENT_DELTA_ZERO' });

    const request = await this.prisma.adjustmentRequest.create({
      data: {
        shopId,
        inventoryItemId: dto.inventoryItemId,
        countItemId: dto.countItemId,
        reason: dto.reason,
        requestedQuantityDelta: delta,
        requestedById: requestedByUserId,
        status: AdjustmentStatus.PENDING_APPROVAL,
      },
    });
    this.logger.log(`Adjustment ${request.id} awaits approval (delta ${delta.toString()}).`);
    return request;
  }

  /** A manager other than the requester approves and posts the request in one transaction. */
  async approveAdjustment(shopId: string, adjustmentId: string, managerUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.adjustmentRequest.findFirst({
        where: { id: adjustmentId, shopId, status: AdjustmentStatus.PENDING_APPROVAL },
        select: { requestedById: true },
      });
      if (!request) throw new NotFoundException('Pending adjustment request not found');
      // Separation of duties: the requester of a stock adjustment cannot approve it.
      if (request.requestedById === managerUserId) throw new ForbiddenException('The person who requested a stock adjustment cannot approve it.');

      const approved = await tx.adjustmentRequest.updateMany({
        where: { id: adjustmentId, shopId, status: AdjustmentStatus.PENDING_APPROVAL },
        data: { status: AdjustmentStatus.APPROVED, approvedById: managerUserId, approvedAt: new Date() },
      });
      if (approved.count === 0) throw new ConflictException({ message: 'The request was approved concurrently.', code: 'ADJUSTMENT_ALREADY_APPROVED' });

      return this.postingService.postApprovedAdjustment(shopId, adjustmentId, managerUserId, tx);
    });
  }
}
