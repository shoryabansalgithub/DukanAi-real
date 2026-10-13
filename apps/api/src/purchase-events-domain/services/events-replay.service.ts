import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class EventsReplayService {
  private readonly logger = new Logger(EventsReplayService.name);

  constructor(private readonly prisma: PrismaService) {}

  async scheduleReplay(shopId: string, aggregateId: string, actorId: string) {
    // Only a document this shop has events for can be replayed (cross-shop audit 2026-10-12):
    // another shop's document id answers exactly like an id of nothing, and no request row of
    // this shop ever names it.
    const known = await this.prisma.outboxEvent.findFirst({ where: { shopId, entityId: aggregateId }, select: { id: true } });
    if (!known) throw new NotFoundException({ message: 'This shop has no event for that document', code: 'PURCHASE_AGGREGATE_NOT_FOUND' });

    this.logger.log(`Scheduling replay for aggregate ${aggregateId}`);

    const replay = await this.prisma.purchaseEventReplay.create({
      data: {
        shopId,
        targetAggregateId: aggregateId,
        requestedById: actorId,
        status: 'PENDING'
      }
    });

    // In a full implementation, a BullMQ job scans OutboxEvents for this aggregate and resets their status to PENDING
    return replay;
  }
}
