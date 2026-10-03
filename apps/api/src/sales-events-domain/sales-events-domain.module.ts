import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesEventPublisher } from './services/sales-event-publisher.service';
import { SalesEventsController } from './sales-events.controller';
import { OutboxModule } from '../common/outbox/outbox.module';

/**
 * The transactional outbox publisher the procurement domains stage their
 * events with, plus the operator routes over a shop's outbox rows. The former
 * sales relay, router and webhook worker (`sales-events`, `sales-webhooks`)
 * are gone (roadmap 4.7): the Order* / Invoice* / Payment* / Return* /
 * Exchange* types they looked for were staged only by the stacks removed in
 * 4.5, and every remaining family has its own relay.
 */
@Module({
  imports: [PrismaModule, OutboxModule],
  controllers: [SalesEventsController],
  providers: [SalesEventPublisher],
  exports: [SalesEventPublisher],
})
export class SalesEventsDomainModule {}
