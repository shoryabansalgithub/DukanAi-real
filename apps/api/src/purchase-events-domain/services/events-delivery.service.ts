import { Injectable, Logger } from '@nestjs/common';
import { EventsRepository } from '../repositories/events.repository';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class EventsDeliveryService {
  private readonly logger = new Logger(EventsDeliveryService.name);

  constructor(
    private readonly repository: EventsRepository,
    private readonly eventEmitter: EventEmitter2
  ) {}

  /**
   * Internal Delivery Router.
   * Maps an OutboxEvent payload to NestJS local EventEmitter channels,
   * triggering decoupled listeners across the Monolith.
   */
  async routeInternalEvent(shopId: string, outboxEventId: string, type: string, payload: any, aggregateId?: string | null, correlationId?: string | null) {
    this.logger.debug(`Routing internal event ${type} [${outboxEventId}]`);

    try {
      // One envelope for every listener (roadmap 4.2): the workflow and
      // analytics listeners read `aggregateId` and `payload`, so the stored
      // payload is no longer spread over the envelope where they could not find it.
      await this.eventEmitter.emitAsync(type, {
        shopId,
        outboxEventId,
        aggregateId: aggregateId ?? (payload && typeof payload === 'object' ? (payload as { id?: string }).id ?? null : null),
        correlationId: correlationId ?? undefined,
        payload,
      });
      
      await this.repository.logDeliverySuccess(shopId, outboxEventId, 'INTERNAL_ROUTER', 0);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to route event ${type}`, error.stack);
      await this.repository.logDeliveryFailure(shopId, outboxEventId, 'INTERNAL_ROUTER', error.message);
      throw error; // Will be caught by BullMQ processor for Retry/DLQ
    }
  }
}
