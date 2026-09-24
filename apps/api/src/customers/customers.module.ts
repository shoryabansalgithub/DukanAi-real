import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomerRepository } from './repositories/customer.repository';
import { CustomerAuditService } from './services/customer-audit.service';
import { CustomerLifecycleService } from './services/customer-lifecycle.service';
import { CustomerSearchService } from './services/customer-search.service';
import { EventsModule } from '../events-domain/events.module';
import { CustomerWorker } from './workers/customer.worker';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [
    PrismaModule, 
    EventsModule,
    BillingModule,
    BullModule.registerQueue({
      name: 'customer-queue',
    })
  ],
  controllers: [CustomersController],
  providers: [
    CustomersService,
    CustomerRepository,
    CustomerAuditService,
    CustomerLifecycleService,
    CustomerSearchService,
    CustomerWorker
  ],
  exports: [CustomersService, CustomerSearchService],
})
export class CustomersModule {}


