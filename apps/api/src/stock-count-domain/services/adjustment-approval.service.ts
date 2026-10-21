import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AdjustmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAdjustmentRequestDto } from '../dto/stock-count.dto';
import { AdjustmentPostingService } from './adjustment-posting.service';
import { assertOwned } from '../../prisma/tenant-ownership';
import { withSerializationRetry } from '../../common/db/serialization-retry';
import { countVariance } from './count-expectation';

/** Requests that hold a count item: a second one would post the same variance twice (release audit S6). */
export const LIVE_ADJUSTMENT_STATUSES = [AdjustmentStatus.PENDING_APPROVAL, AdjustmentStatus.APPROVED, AdjustmentStatus.POSTED] as const;

/**
 * Stock-count adjustments (roadmap 3.9, audit P0-2). Every request waits for
 * a manager: there is no auto-approval threshold, the approver can never be
 * the requester, and approval and posting happen in one transaction with
 * status-guarded transitions (PENDING_APPROVAL -> APPROVED -> POSTED), so two
 * concurrent approvals cannot both move stock. A request raised from a count
 * item takes its delta from the count (counted − expected at the count, see
 * `count-expectation.ts`), never from the caller, and a count item carries at
 * most one live request.
 */
@Injectable()
export class AdjustmentApprovalService {
  private readonly logger = new Logger(AdjustmentApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly postingService: AdjustmentPostingService,
  ) {}

  async requestAdjustment(shopId: string, requestedByUserId: string, dto: CreateAdjustmentRequestDto) {
    return withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          await assertOwned(tx, 'inventoryItem', dto.inventoryItemId, shopId);
          await assertOwned(tx, 'stockCountItem', dto.countItemId, shopId);

          let delta: Prisma.Decimal;
          if (dto.countItemId) {
            // One live request per count item (release audit S6): decided under the count item's lock.
            await tx.$queryRaw`SELECT id FROM StockCountItem WHERE id = ${dto.countItemId} AND shopId = ${shopId} FOR UPDATE`;
            const countItem = await tx.stockCountItem.findFirst({
              where: { id: dto.countItemId, shopId },
              include: { session: { select: { startedAt: true, createdAt: true } } },
            });
            if (!countItem) throw new NotFoundException({ message: 'Count item not found', code: 'COUNT_ITEM_NOT_FOUND' });
            if (countItem.inventoryItemId !== dto.inventoryItemId) {
              throw new BadRequestException({ message: 'The count item belongs to a different inventory item.', code: 'COUNT_ITEM_MISMATCH' });
            }
            if (countItem.variance === null || countItem.countedQuantity === null) {
              throw new BadRequestException({ message: 'The count item has not been counted yet.', code: 'COUNT_ITEM_NOT_COUNTED' });
            }
            const existing = await tx.adjustmentRequest.findFirst({
              where: { shopId, countItemId: dto.countItemId, status: { in: [...LIVE_ADJUSTMENT_STATUSES] } },
              select: { id: true, status: true },
            });
            if (existing) {
              throw new ConflictException({ message: 'An adjustment for this count item already exists.', code: 'ADJUSTMENT_ALREADY_REQUESTED', details: { adjustmentId: existing.id, status: existing.status } });
            }
            // The variance at the count: counted − (snapshot + movements up to the count), recomputed now.
            delta = (await countVariance(tx, countItem, countItem.session)) ?? countItem.variance;
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

          const request = await tx.adjustmentRequest.create({
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      ),
    );
  }

  /** A manager other than the requester approves and posts the request in one transaction. */
  async approveAdjustment(shopId: string, adjustmentId: string, managerUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.adjustmentRequest.findFirst({
        where: { id: adjustmentId, shopId, status: AdjustmentStatus.PENDING_APPROVAL },
        select: { requestedById: true },
      });
      if (!request) throw new NotFoundException({ message: 'Pending adjustment request not found', code: 'ADJUSTMENT_NOT_FOUND' });
      // Separation of duties: the requester of a stock adjustment cannot approve it.
      if (request.requestedById === managerUserId) throw new ForbiddenException({ message: 'The person who requested a stock adjustment cannot approve it.', code: 'SEPARATION_OF_DUTIES' });

      const approved = await tx.adjustmentRequest.updateMany({
        where: { id: adjustmentId, shopId, status: AdjustmentStatus.PENDING_APPROVAL },
        data: { status: AdjustmentStatus.APPROVED, approvedById: managerUserId, approvedAt: new Date() },
      });
      if (approved.count === 0) throw new ConflictException({ message: 'The request was approved concurrently.', code: 'ADJUSTMENT_ALREADY_APPROVED' });

      return this.postingService.postApprovedAdjustment(shopId, adjustmentId, managerUserId, tx);
    });
  }
}
