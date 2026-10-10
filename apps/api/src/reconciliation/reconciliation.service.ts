import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Prisma, ReconciliationRun, ReconciliationRunStatus, ReconciliationTrigger } from '@prisma/client';
import { CronJob } from 'cron';
import { ShopTimezoneService } from '../analytics-domain/services/shop-timezone.service';
import { CronLockService } from '../common/cron-lock/cron-lock.service';
import { reconciliationDriftTotal, reconciliationRunsTotal } from '../common/observability/metrics';
import { ListQueryDto, PagedResult, pageArgs } from '../common/pagination';
import { sweepEveryShop, SweepSummary } from '../common/sweeps/per-shop-sweep';
import { businessDateString, parseBusinessDate } from '../common/time/business-day';
import { Clock } from '../common/time/clock';
import { CronConfig } from '../config/domains/cron.config';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { previousBusinessDate, reconcileBusinessDay, ReconciliationCheck, ReconciliationReport, ReconciliationSummary } from './reconciliation-engine';

/** A run of every shop should finish well inside this; the lock is released when the sweep returns. */
const LOCK_TTL_MS = 30 * 60_000;
const JOB_NAME = 'Reconciliation';

export interface ReconciliationRunView {
  id: string;
  businessDate: string;
  timeZone: string;
  trigger: ReconciliationTrigger;
  status: ReconciliationRunStatus;
  driftCount: number;
  startedAt: Date;
  finishedAt: Date | null;
  checks: ReconciliationCheck[];
  summary: ReconciliationSummary | null;
  error: string | null;
}

/**
 * Financial reconciliation (roadmap 9.5): runs the engine for a shop and a
 * business day, records the outcome as a `ReconciliationRun` row (every run,
 * clean or not, so the history answers "when were the books last proven"),
 * counts it for the alerts, and does so nightly for every shop under the
 * `cron:reconciliation` lock. Nothing is corrected; a drift is for a person.
 */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronConfig: CronConfig,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cronLock: CronLockService,
    private readonly tenantContext: TenantContextService,
    private readonly shopTimezone: ShopTimezoneService,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cronConfig.enabled) {
      this.logger.warn(`${JOB_NAME} schedule not registered: CRON_ENABLED=false`);
      return;
    }
    const job = new CronJob(this.cronConfig.reconciliationCron, () => {
      void this.sweep().catch((error: unknown) => this.logger.error(`${JOB_NAME} sweep crashed: ${(error as Error).message}`));
    });
    this.schedulerRegistry.addCronJob(JOB_NAME, job);
    job.start();
  }

  /**
   * The nightly run: every shop's previous business day (in the shop's own
   * timezone, so the day is complete whatever the server's zone), one shop
   * at a time under the cluster lock; `null` when another instance holds it.
   * The sweep summary counts drifts as "affected".
   */
  sweep(now: Date = this.clock.now()): Promise<SweepSummary | null> {
    return this.cronLock.withLock('cron:reconciliation', LOCK_TTL_MS, () =>
      sweepEveryShop(this.prisma, this.tenantContext, this.logger, JOB_NAME, async (shopId) => {
        const timeZone = await this.shopTimezone.resolve(shopId);
        const run = await this.runForShop(shopId, { trigger: ReconciliationTrigger.CRON, date: previousBusinessDate(now, timeZone), timeZone });
        return run.driftCount;
      }),
    );
  }

  /**
   * Reconciles one business day of a shop and records the run. A date in the
   * future is refused (400); an unparsable one too. A run that throws is
   * recorded as FAILED with the error, then rethrown.
   */
  async runForShop(shopId: string, options: { trigger: ReconciliationTrigger; date?: string; timeZone?: string } = { trigger: ReconciliationTrigger.MANUAL }): Promise<ReconciliationRunView> {
    const timeZone = options.timeZone ?? (await this.shopTimezone.resolve(shopId));
    const now = this.clock.now();
    const businessDate = options.date ?? businessDateString(now, timeZone);
    const start = parseBusinessDate(businessDate, timeZone);
    if (!start) throw new BadRequestException({ message: 'date must be a calendar day as YYYY-MM-DD.', code: 'RECONCILIATION_INVALID_DATE' });
    if (start > now) throw new BadRequestException({ message: `${businessDate} has not started in ${timeZone}.`, code: 'RECONCILIATION_FUTURE_DATE' });

    let report: ReconciliationReport;
    try {
      report = await reconcileBusinessDay(this.prisma, { shopId, timeZone, businessDate, now });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.logger.error(`${JOB_NAME} of ${businessDate} failed for shop ${shopId}: ${message}`);
      reconciliationRunsTotal.inc({ status: 'failed' });
      await this.prisma.reconciliationRun.create({
        data: {
          shopId,
          businessDate,
          timeZone,
          trigger: options.trigger,
          status: ReconciliationRunStatus.FAILED,
          driftCount: 0,
          checks: [],
          error: message.slice(0, 4000),
          startedAt: now,
          finishedAt: this.clock.now(),
        },
      });
      throw error;
    }

    const status = report.status === 'DRIFT' ? ReconciliationRunStatus.DRIFT : ReconciliationRunStatus.CLEAN;
    reconciliationRunsTotal.inc({ status: status.toLowerCase() });
    for (const check of report.checks) {
      if (check.drifts.length > 0) reconciliationDriftTotal.inc({ check: check.name }, check.drifts.length);
    }
    const row = await this.prisma.reconciliationRun.create({
      data: {
        shopId,
        businessDate,
        timeZone,
        trigger: options.trigger,
        status,
        driftCount: report.driftCount,
        checks: report.checks as unknown as Prisma.InputJsonValue,
        summary: report.summary as unknown as Prisma.InputJsonValue,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
      },
    });
    if (status === ReconciliationRunStatus.DRIFT) {
      const where = report.checks.filter((c) => c.drifts.length > 0).map((c) => `${c.name}=${c.drifts.length}`).join(' ');
      this.logger.error(`${JOB_NAME} of ${businessDate} for shop ${shopId}: ${report.driftCount} drift(s) (${where}); run ${row.id}`);
    } else {
      this.logger.log(`${JOB_NAME} of ${businessDate} for shop ${shopId}: clean (${report.summary.sales.count} sales, ${report.summary.returns.count} returns, ${report.summary.cancellations.count} cancellations, ${report.summary.repayments.count} repayments); run ${row.id}`);
    }
    return this.view(row);
  }

  /** The newest run of the shop, or 404 `RECONCILIATION_NOT_RUN`. */
  async latest(shopId: string): Promise<ReconciliationRunView> {
    const row = await this.prisma.reconciliationRun.findFirst({ where: { shopId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] });
    if (!row) throw new NotFoundException({ message: 'No reconciliation has run for this shop yet.', code: 'RECONCILIATION_NOT_RUN' });
    return this.view(row);
  }

  async get(shopId: string, id: string): Promise<ReconciliationRunView> {
    const row = await this.prisma.reconciliationRun.findFirst({ where: { shopId, id } });
    if (!row) throw new NotFoundException({ message: 'Reconciliation run not found.', code: 'RECONCILIATION_RUN_NOT_FOUND' });
    return this.view(row);
  }

  /** Newest first, as a capped page (roadmap 5.6); the checks are omitted from the list, `get` has them. */
  async list(shopId: string, query: ListQueryDto): Promise<PagedResult<Omit<ReconciliationRunView, 'checks' | 'summary'>>> {
    const { skip, take } = pageArgs(query);
    const where = { shopId };
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: { id: true, businessDate: true, timeZone: true, trigger: true, status: true, driftCount: true, startedAt: true, finishedAt: true, error: true },
      }),
      this.prisma.reconciliationRun.count({ where }),
    ]);
    return { items: rows, total, skip, take };
  }

  private view(row: ReconciliationRun): ReconciliationRunView {
    return {
      id: row.id,
      businessDate: row.businessDate,
      timeZone: row.timeZone,
      trigger: row.trigger,
      status: row.status,
      driftCount: row.driftCount,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      checks: (row.checks as unknown as ReconciliationCheck[]) ?? [],
      summary: (row.summary as unknown as ReconciliationSummary | null) ?? null,
      error: row.error,
    };
  }
}
