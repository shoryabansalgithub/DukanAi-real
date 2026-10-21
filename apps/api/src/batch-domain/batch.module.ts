import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryDomainModule } from '../inventory-domain/inventory-domain.module';
import { BatchService } from './services/batch.service';
import { ExpiryService } from './services/expiry.service';
import { BatchExpirySweepScheduler } from './services/batch-expiry-sweep.scheduler';
import { RecallService } from './services/recall.service';
import { BatchController } from './batch.controller';

@Module({
  imports: [PrismaModule, InventoryDomainModule],
  controllers: [BatchController],
  providers: [
    BatchService,
    ExpiryService,
    BatchExpirySweepScheduler,
    RecallService
  ],
  exports: [
    BatchService
  ]
})
export class BatchModule {}
