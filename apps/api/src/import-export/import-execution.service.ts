import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ImportJob, ImportKind, ImportMode, JobStatus, Prisma } from '@prisma/client';
import { invalidateAnalyticsCache } from '../common/cache/analytics-cache-keys';
import { PrismaService } from '../prisma/prisma.service';
import { ParsingEngineService } from './parsing-engine.service';
import { RowIssue, shapeRows } from './import-rows';
import { failureMessage, ImportActor, Importer, PlannedRow, RowAction } from './importers/import-plan';
import { ProductImporter } from './importers/product-importer';
import { CustomerImporter } from './importers/customer-importer';
import { OpeningStockImporter } from './importers/opening-stock-importer';

/** Report rows written per statement while a run progresses (and the job's counters refreshed with them). */
const REPORT_BATCH = 250;

const FINISHED: ReadonlySet<JobStatus> = new Set<JobStatus>([JobStatus.COMPLETED, JobStatus.PARTIAL_SUCCESS, JobStatus.FAILED, JobStatus.CANCELLED]);

/** `actionTaken` of a report row: what was done, or in a dry run what would be. */
const ACTION_TAKEN: Record<RowAction, { applied: string; planned: string }> = {
  CREATE: { applied: 'CREATED', planned: 'WOULD_CREATE' },
  UPDATE: { applied: 'UPDATED', planned: 'WOULD_UPDATE' },
  UNCHANGED: { applied: 'UNCHANGED', planned: 'UNCHANGED' },
  SKIP: { applied: 'SKIPPED', planned: 'SKIPPED' },
};

interface Counts {
  totalRows: number;
  validRows: number;
  errorRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
}

/**
 * Runs one onboarding import (roadmap 9.20): parse the stored file, map its
 * columns, validate and plan every row against the shop's data, then either
 * stop there (a dry run: the per-row report is the result) or apply the
 * CREATE and UPDATE rows one by one through the domain services. A row that
 * fails is reported with the API's own message and the run goes on; nothing
 * is half-written because every row is one service call (or two sequenced,
 * idempotent ones). The report is `ImportJobRow` (row 0 is the file itself)
 * and the counters on `ImportJob`.
 *
 * Re-running is safe at every level: a redelivered job resumes after the rows
 * it already reported, and a second job with the same file finds every row
 * UNCHANGED, because products match by SKU, customers by phone, and each
 * opening balance and opening stock is keyed once per customer / item.
 */
@Injectable()
export class ImportExecutionService {
  private readonly logger = new Logger(ImportExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parsingEngine: ParsingEngineService,
    private readonly productImporter: ProductImporter,
    private readonly customerImporter: CustomerImporter,
    private readonly openingStockImporter: OpeningStockImporter,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async processJob(jobId: string, actor: Omit<ImportActor, 'jobId'>): Promise<void> {
    const job = await this.prisma.importJob.findFirst({ where: { id: jobId, shopId: actor.shopId } });
    if (!job) return;
    if (FINISHED.has(job.status)) {
      this.logger.log(`Import job ${jobId} already finished (${job.status}); nothing to do.`);
      return;
    }
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status: JobStatus.PROCESSING, startedAt: job.startedAt ?? new Date() } });

    try {
      await this.run(job, { ...actor, jobId });
    } catch (error) {
      // An invariant broke (database down, a bug): the job says so instead of staying PROCESSING.
      this.logger.error(`Import job ${jobId} failed: ${(error as Error).message}`);
      await this.writeFileRow(jobId, [{ message: `The import stopped: ${failureMessage(error).message}`, severity: 'error' }]);
      await this.prisma.importJob.update({ where: { id: jobId }, data: { status: JobStatus.FAILED, completedAt: new Date() } });
    }
  }

  private async run(job: ImportJob, actor: ImportActor): Promise<void> {
    let records: Array<Record<string, unknown>>;
    try {
      records = await this.parsingEngine.parseFile(job.fileUrl, job.format);
    } catch (error) {
      await this.finishWithFileError(job, [{ message: `The file could not be read: ${failureMessage(error).message}`, severity: 'error' }], 0);
      return;
    }
    // A spreadsheet's first data line is line 2 (the header is line 1); a JSON array counts from 1.
    const shaped = shapeRows(job.kind, records, job.format === 'CSV' ? 2 : 1);
    if (shaped.issues.some((i) => i.severity === 'error')) {
      await this.finishWithFileError(job, shaped.issues, shaped.rows.length);
      return;
    }

    const planned = (await this.importerFor(job.kind).plan(shaped.rows, actor)).sort((a, b) => a.rowNumber - b.rowNumber);
    for (const row of planned) applyMode(row, job.mode);

    // A redelivered job (worker restart) resumes after the rows it already reported.
    const reported = await this.prisma.importJobRow.findMany({ where: { importJobId: job.id, rowNumber: { gt: 0 } }, select: { rowNumber: true, status: true, actionTaken: true } });
    const done = new Map(reported.map((r) => [r.rowNumber, r]));
    if (shaped.issues.length > 0 && !(await this.prisma.importJobRow.count({ where: { importJobId: job.id, rowNumber: 0 } }))) {
      await this.writeFileRow(job.id, shaped.issues);
    }

    const counts: Counts = { totalRows: planned.length, validRows: 0, errorRows: 0, createdCount: 0, updatedCount: 0, unchangedCount: 0, skippedCount: 0 };
    await this.prisma.importJob.update({ where: { id: job.id }, data: { totalRows: planned.length } });
    let pending: Prisma.ImportJobRowCreateManyInput[] = [];
    const flush = async () => {
      if (pending.length > 0) await this.prisma.importJobRow.createMany({ data: pending });
      pending = [];
      await this.prisma.importJob.update({ where: { id: job.id }, data: { ...counts, totalRows: planned.length } });
    };

    for (const row of planned) {
      const previous = done.get(row.rowNumber);
      if (previous) {
        count(counts, previous.status === 'ERROR' ? undefined : actionOf(previous.actionTaken));
        continue;
      }
      let action = row.action;
      let issues = row.issues;
      if (!job.dryRun && row.apply) {
        try {
          action = await row.apply();
        } catch (error) {
          const failure = failureMessage(error);
          action = undefined;
          issues = [...issues, { message: failure.code ? `${failure.message} (${failure.code})` : failure.message, severity: 'error' }];
        }
      }
      count(counts, action);
      pending.push({
        importJobId: job.id,
        rowNumber: row.rowNumber,
        rawData: row.raw,
        status: action === undefined ? 'ERROR' : action === 'SKIP' ? 'SKIPPED' : 'SUCCESS',
        actionTaken: action === undefined ? null : job.dryRun ? ACTION_TAKEN[action].planned : ACTION_TAKEN[action].applied,
        errors: issues.length > 0 ? (issues as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        changes: row.changes.length > 0 && action !== undefined && action !== 'UNCHANGED' ? row.changes : Prisma.DbNull,
      });
      if (pending.length >= REPORT_BATCH) await flush();
    }
    await flush();

    const status = counts.errorRows === 0 ? JobStatus.COMPLETED : counts.validRows > 0 ? JobStatus.PARTIAL_SUCCESS : JobStatus.FAILED;
    await this.prisma.importJob.update({ where: { id: job.id }, data: { ...counts, status, completedAt: new Date() } });

    if (!job.dryRun) {
      await this.prisma.auditLog.create({
        data: {
          shopId: actor.shopId,
          userId: actor.userId,
          action: 'IMPORT_APPLIED',
          entity: 'ImportJob',
          entityId: job.id,
          afterData: { kind: job.kind, fileName: job.fileName, status, ...counts },
        },
      });
      // Products, stock and udhar feed the dashboard tiles: drop the cached figures now.
      if (counts.createdCount + counts.updatedCount > 0) {
        await invalidateAnalyticsCache(this.cache, actor.shopId).catch((e: Error) => this.logger.warn(`Analytics cache invalidation failed: ${e.message}`));
      }
    }
    this.logger.log(`Import job ${job.id} (${job.kind}${job.dryRun ? ', dry run' : ''}) ${status}: ${JSON.stringify(counts)}`);
  }

  private importerFor(kind: ImportKind): Importer {
    switch (kind) {
      case ImportKind.PRODUCTS:
        return this.productImporter;
      case ImportKind.CUSTOMERS:
        return this.customerImporter;
      case ImportKind.OPENING_STOCK:
        return this.openingStockImporter;
    }
  }

  private async finishWithFileError(job: ImportJob, issues: RowIssue[], rows: number): Promise<void> {
    await this.writeFileRow(job.id, issues);
    await this.prisma.importJob.update({ where: { id: job.id }, data: { status: JobStatus.FAILED, totalRows: rows, completedAt: new Date() } });
  }

  /** Row 0 of the report: what is wrong with the file as a whole (a missing column, an unreadable file). */
  private async writeFileRow(jobId: string, issues: RowIssue[]): Promise<void> {
    await this.prisma.importJobRow.create({
      data: {
        importJobId: jobId,
        rowNumber: 0,
        rawData: {},
        status: issues.some((i) => i.severity === 'error') ? 'ERROR' : 'SUCCESS',
        actionTaken: 'FILE',
        errors: issues as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

/** CREATE_ONLY leaves existing rows alone and UPDATE_ONLY creates nothing: those rows are skipped, not errors. */
function applyMode(row: PlannedRow, mode: ImportMode): void {
  if (mode === ImportMode.CREATE_ONLY && row.action === 'UPDATE') {
    row.action = 'SKIP';
    row.apply = undefined;
    row.issues = [...row.issues, { message: 'Already in the shop; CREATE_ONLY does not update it.', severity: 'warning' }];
  } else if (mode === ImportMode.UPDATE_ONLY && row.action === 'CREATE') {
    row.action = 'SKIP';
    row.apply = undefined;
    row.issues = [...row.issues, { message: 'Not in the shop; UPDATE_ONLY does not create it.', severity: 'warning' }];
  }
}

function count(counts: Counts, action: RowAction | undefined): void {
  if (action === undefined) {
    counts.errorRows++;
    return;
  }
  counts.validRows++;
  if (action === 'CREATE') counts.createdCount++;
  else if (action === 'UPDATE') counts.updatedCount++;
  else if (action === 'UNCHANGED') counts.unchangedCount++;
  else counts.skippedCount++;
}

/** The action behind a stored `actionTaken`, for a resumed run's counters. */
function actionOf(actionTaken: string | null): RowAction | undefined {
  for (const [action, names] of Object.entries(ACTION_TAKEN) as Array<[RowAction, { applied: string; planned: string }]>) {
    if (actionTaken === names.applied || actionTaken === names.planned) return action;
  }
  return undefined;
}
