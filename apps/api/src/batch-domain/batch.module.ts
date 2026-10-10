import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryDomainModule } from '../inventory-domain/inventory-domain.module';
import { BatchService } from './services/batch.service';
import { BatchAllocationService } from './services/batch-allocation.service';
import { ExpiryService } from './services/expiry.service';
import { BatchExpirySweepScheduler } from './services/batch-expiry-sweep.scheduler';
import { RecallService } from './services/recall.service';
import { BatchController } from './batch.controller';

@Module({
  imports: [PrismaModule, InventoryDomainModule],
  controllers: [BatchController],
  providers: [
    BatchService,
    BatchAllocationService,
    ExpiryService,
    BatchExpirySweepScheduler,
    RecallService
  ],
  exports: [
    BatchService,
    BatchAllocationService
  ]
})
export class BatchModule {}
