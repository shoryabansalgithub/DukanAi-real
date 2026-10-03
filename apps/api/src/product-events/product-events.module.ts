import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BullModule } from '@nestjs/bullmq';
import { ProductEventPublisher } from './services/product-event-publisher.service';
import { EventRouterService } from './services/event-router.service';
import { ProductWebhookDispatcherService } from './services/webhook-dispatcher.service';
import { ProductEventReplayService } from './services/event-replay.service';
import { OutboxProcessorWorker } from './workers/outbox.worker';
import { WebhookDeliveryWorker } from './workers/webhook.worker';
import { ProductEventsController } from './controllers/product-events/product-events.controller';
import { WebhookController } from './controllers/webhook/webhook.controller';
import { OutboxModule } from '../common/outbox/outbox.module';
import { defaultOutboundResolver, OUTBOUND_RESOLVER, OutboundUrlGuard } from '../common/net/outbound-url-guard';
import { WebhookHttpClient } from './services/webhook-http-client';

@Module({
  imports: [
    PrismaModule,
    OutboxModule,
    // `internal-events` had no consumer (roadmap 4.6): its jobs only piled up in Redis.
    BullModule.registerQueue({ name: 'webhook-delivery' })
  ],
  controllers: [ProductEventsController, WebhookController],
  providers: [
    ProductEventPublisher,
    EventRouterService,
    ProductWebhookDispatcherService,
    // Registered as a provider so an integration test can override the resolver.
    { provide: OUTBOUND_RESOLVER, useValue: defaultOutboundResolver },
    OutboundUrlGuard,
    WebhookHttpClient,
    ProductEventReplayService,
    OutboxProcessorWorker,
    WebhookDeliveryWorker
  ],
  exports: [ProductEventPublisher]
})
export class ProductEventsModule {}
