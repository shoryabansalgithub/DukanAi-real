import { Module } from '@nestjs/common';
import { CronLockModule } from '../cron-lock/cron-lock.module';
import { RetentionSweepService } from './retention-sweep.service';

/** The nightly retention sweep (roadmap 7.8). */
@Module({
  imports: [CronLockModule],
  providers: [RetentionSweepService],
  exports: [RetentionSweepService],
})
export class RetentionModule {}
