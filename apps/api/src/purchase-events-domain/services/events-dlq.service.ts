import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OutboxClaimService } from '../../common/outbox/outbox-claim.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class EventsDlqService {
  private readonly logger = new Logger(EventsDlqService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: OutboxClaimService,
  ) {}

  async moveToDeadLetter(shopId: string, outboxEventId: string, eventType: string, payload: any, error: string) {
    this.logger.warn(`Moving Event ${outboxEventId} to DLQ!`);

    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseDeadLetter.create({
        data: {
          shopId,
          outboxEventId,
          eventType,
          payload,
          failureReason: error,
          lastAttemptAt: new Date(),
        },
      });

      await tx.outboxEvent.update({
        where: { id: outboxEventId },
        data: { status: 'FAILED', error },
      });
    });
  }

  async getDeadLetters(shopId: string, limit: number, offset: number = 0) {
    return this.prisma.purchaseDeadLetter.findMany({
      where: { shopId, status: 'ACTIVE' },
      take: limit,
      skip: offset,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }

  /**
   * Hands a dead letter back to its relay: the FAILED outbox row goes back to
   * PENDING under a fresh job id (`OutboxClaimService.retryFailed`, the same
   * primitive as `POST /sales/events/retry`) and the letter is RESOLVED, in one
   * transaction. An unknown or foreign letter is 404, a letter that is not
   * ACTIVE or whose outbox row is no longer FAILED is 409. (This used to answer
   * success without touching anything: phase 4 gate.)
   */
  async retryDeadLetter(shopId: string, deadLetterId: string) {
    const letter = await this.prisma.purchaseDeadLetter.findFirst({ where: { id: deadLetterId, shopId } });
    if (!letter) throw new NotFoundException({ message: 'Dead letter not found', code: 'DEAD_LETTER_NOT_FOUND' });
    if (letter.status !== 'ACTIVE') {
      throw new ConflictException({ message: `Dead letter is ${letter.status}; only an ACTIVE one can be retried.`, code: 'DEAD_LETTER_NOT_ACTIVE', details: { status: letter.status } });
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const retried = await this.claims.retryFailed(shopId, letter.outboxEventId, tx);
      if (!retried) {
        throw new ConflictException({ message: 'The outbox row behind this dead letter is not FAILED; nothing to retry.', code: 'OUTBOX_EVENT_NOT_FAILED' });
      }
      await tx.purchaseDeadLetter.update({
        where: { id: letter.id },
        data: { status: 'RESOLVED', resolvedAt: now, lastAttemptAt: now, retryCount: { increment: 1 } },
      });
    });
    this.logger.log(`Dead letter ${letter.id} of shop ${shopId} re-queued outbox event ${letter.outboxEventId}`);
    return { success: true, message: 'Re-queued to Outbox', outboxEventId: letter.outboxEventId };
  }
}
