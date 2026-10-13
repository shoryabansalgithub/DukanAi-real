import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { createCronJob } from '../../common/cron/cron-job';
import { CronLockService } from '../../common/cron-lock/cron-lock.service';
import { sweepEveryShop, SweepSummary } from '../../common/sweeps/per-shop-sweep';
import { CronConfig } from '../../config/domains/cron.config';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReservationExpiryService } from './reservation-expiry.service';

export const RESERVATION_EXPIRY_SWEEP_JOB = 'ReservationExpirySweep';
// How long a crashed holder keeps the other instances out; a live run keeps
// the lock for as long as it takes (CronLockService extends it), so a slow
// run is never joined by the next minute's.
const LOCK_TTL_MS = 55_000;

/**
 * Global reservation-expiry sweep: one pod at a time (cron lock), every shop
 * in its own tenant context, each reservation in its own transaction.
 * `POST /reservations/sweep` stays available for a shop to sweep itself.
 */
@Injectable()
export class ReservationExpirySweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReservationExpirySweepScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expiryService: ReservationExpiryService,
    private readonly cronLock: CronLockService,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly tenantContext: TenantContextService,
  ) {}

  onApplicationBootstrap() {
    if (!this.cronConfig.enabled) {
      this.logger.warn(`${RESERVATION_EXPIRY_SWEEP_JOB} schedule not registered: CRON_ENABLED=false`);
      return;
    }
    const job = createCronJob(
      this.cronConfig.reservationExpirySweepCron,
      () => {
        this.handleCron().catch((error: unknown) => this.logger.error(`${RESERVATION_EXPIRY_SWEEP_JOB} crashed: ${(error as Error).message}`));
      },
      this.cronConfig,
    );
    this.schedulerRegistry.addCronJob(RESERVATION_EXPIRY_SWEEP_JOB, job);
    job.start();
  }

  handleCron(): Promise<SweepSummary | null> {
    return this.cronLock.withLock('cron:reservation-expiry-sweep', LOCK_TTL_MS, () => this.sweepAllShops());
  }

  sweepAllShops(): Promise<SweepSummary> {
    return sweepEveryShop(this.prisma, this.tenantContext, this.logger, RESERVATION_EXPIRY_SWEEP_JOB, (shopId) => this.expiryService.releaseExpiredReservations(shopId));
  }
}
