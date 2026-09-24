import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventPublisherService } from './services/event-publisher.service';
import { WebhookDispatcherService } from './services/webhook-dispatcher.service';
import { EventBusService } from './services/event-bus.service';
import { EventReplayService } from './services/event-replay.service';
import { IdempotencyService } from './services/idempotency.service';
import { WebhookManagementService } from './services/webhook-management.service';
import { InventoryProjectionService } from './services/inventory-projection.service';
import { InventoryEventConsumer } from './workers/inventory-event.consumer';
import { EventsController } from './events.controller';

@Module({
  imports: [PrismaModule],
  controllers: [EventsController],
  providers: [
    EventPublisherService,
    WebhookDispatcherService,
    WebhookManagementService,
    EventBusService,
    EventReplayService,
    IdempotencyService,
    InventoryProjectionService,
    InventoryEventConsumer
  ],
  exports: [
    EventPublisherService
  ]
})
export class EventsModule {}
