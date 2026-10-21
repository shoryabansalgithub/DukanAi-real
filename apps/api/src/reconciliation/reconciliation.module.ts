import { Module } from '@nestjs/common';
import { AnalyticsDomainModule } from '../analytics-domain/analytics-domain.module';
import { CronLockModule } from '../common/cron-lock/cron-lock.module';
import { ReconciliationCheckpoints } from './reconciliation-checkpoints';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

/** Financial reconciliation to the paisa (roadmap 9.5): nightly per shop, on demand, and readable by the owner. */
@Module({
  imports: [CronLockModule, AnalyticsDomainModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationCheckpoints],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
