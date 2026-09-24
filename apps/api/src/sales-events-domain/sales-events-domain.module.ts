import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BullModule } from '@nestjs/bullmq';

import { SalesEventPublisher } from './services/sales-event-publisher.service';
import { SalesRedisBroadcaster } from './services/sales-redis-broadcaster.service';
import { SalesOutboxRelayCron } from './workers/sales-outbox-relay.cron';
import { SalesEventRouterWorker } from './workers/sales-event-router.worker';
import { SalesWebhookWorker } from './workers/sales-webhook.worker';
import { SalesEventsController } from './sales-events.controller';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: 'sales-events',
    }),
    BullModule.registerQueue({
      name: 'sales-webhooks',
    }),
    // 'sales-analytics' and 'sales-notifications' were registered here but never
    // consumed; the router no longer fans out to them.
  ],
  controllers: [SalesEventsController],
  providers: [
    SalesEventPublisher,
    SalesRedisBroadcaster,
    SalesOutboxRelayCron,
    SalesEventRouterWorker,
    SalesWebhookWorker
  ],
  exports: [SalesEventPublisher]
})
export class SalesEventsDomainModule {}
