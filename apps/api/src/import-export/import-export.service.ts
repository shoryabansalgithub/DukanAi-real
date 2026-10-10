import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ImportJob, ImportKind, ImportMode, JobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListQueryDto, PagedResult, pageArgs } from '../common/pagination';
import { FileStorageService } from './file-storage.service';
import { csvCell, IMPORT_COLUMNS, IMPORT_KIND_SLUGS } from './import-columns';
import { importFormatOf } from './import-upload';
import { IMPORT_JOB_QUEUE, ImportJobData, PROCESS_IMPORT_JOB } from './import.worker';
import { ImportRowsQueryDto } from './dto/upload-import.dto';
import type { RowIssue } from './import-rows';

const JOB_LIST_SELECT = {
  id: true,
  kind: true,
  fileName: true,
  format: true,
  mode: true,
  dryRun: true,
  status: true,
  totalRows: true,
  validRows: true,
  errorRows: true,
  createdCount: true,
  updatedCount: true,
  unchangedCount: true,
  skippedCount: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.ImportJobSelect;

const DRY_RUN_APPLICABLE: ReadonlySet<JobStatus> = new Set<JobStatus>([JobStatus.COMPLETED, JobStatus.PARTIAL_SUCCESS]);

/**
 * The onboarding import jobs of a shop (roadmap 9.20): queue an upload (a
 * dry run or a real run), list the jobs, page through a job's per-row
 * report, download it as CSV, and apply a finished dry run (a new job on
 * the same stored file, so the dry run's report stays as it was).
 */
@Injectable()
export class ImportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
    @InjectQueue(IMPORT_JOB_QUEUE) private readonly importQueue: Queue<ImportJobData>,
  ) {}

  /** Stores the uploaded file and queues its import; the worker runs it as `userId` in `shopId`. */
  async queueUpload(kind: ImportKind, file: Express.Multer.File, options: { mode: ImportMode; dryRun: boolean }, shopId: string, userId: string) {
    const fileUrl = await this.storage.saveImportFile(shopId, file);
    const job = await this.prisma.importJob.create({
      data: {
        shopId,
        kind,
        fileName: file.originalname,
        fileSize: file.size,
        fileUrl,
        format: importFormatOf(file.originalname),
        mode: options.mode,
        dryRun: options.dryRun,
        status: JobStatus.PENDING,
        createdById: userId,
      },
    });
    await this.importQueue.add(PROCESS_IMPORT_JOB, { jobId: job.id, shopId });
    return { message: options.dryRun ? 'Dry run queued' : 'Import queued successfully', jobId: job.id, kind, dryRun: options.dryRun };
  }

  /** The shop's import jobs, newest first. */
  async list(shopId: string, query: ListQueryDto): Promise<PagedResult<Prisma.ImportJobGetPayload<{ select: typeof JOB_LIST_SELECT }>>> {
    const { skip, take } = pageArgs(query);
    const where = { shopId };
    const [items, total] = await Promise.all([
      this.prisma.importJob.findMany({ where, select: JOB_LIST_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take }),
      this.prisma.importJob.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async get(shopId: string, id: string): Promise<ImportJob> {
    const job = await this.prisma.importJob.findFirst({ where: { id, shopId } });
    if (!job) throw new NotFoundException({ message: 'Import job not found', code: 'IMPORT_JOB_NOT_FOUND' });
    return job;
  }

  /** One page of a job's report, in file order (row 0 is the file itself). */
  async rows(shopId: string, id: string, query: ImportRowsQueryDto) {
    await this.get(shopId, id);
    const { skip, take } = pageArgs(query);
    const where: Prisma.ImportJobRowWhereInput = { importJobId: id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.importJobRow.findMany({ where, orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }], skip, take }),
      this.prisma.importJobRow.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async errors(shopId: string, id: string, limit: number) {
    await this.get(shopId, id);
    return this.prisma.importJobRow.findMany({ where: { importJobId: id, status: 'ERROR' }, orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }], take: limit });
  }

  /**
   * The whole report as CSV, for a spreadsheet: row, result, what changes,
   * the problems, then the row's own cells under the template headers, so a
   * shop can fix the refused rows in place and import them again.
   */
  async reportCsv(shopId: string, id: string): Promise<{ fileName: string; csv: string }> {
    const job = await this.get(shopId, id);
    const columns = IMPORT_COLUMNS[job.kind];
    const lines = [['row', 'status', 'action', 'changes', 'problems', ...columns.map((c) => c.header)]];
    const PAGE = 1000;
    for (let skip = 0; ; skip += PAGE) {
      const rows = await this.prisma.importJobRow.findMany({ where: { importJobId: id }, orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }], skip, take: PAGE });
      for (const row of rows) {
        const raw = (row.rawData ?? {}) as Record<string, unknown>;
        const issues = Array.isArray(row.errors) ? (row.errors as unknown as RowIssue[]) : [];
        const changes = Array.isArray(row.changes) ? (row.changes as string[]) : [];
        lines.push([
          row.rowNumber === 0 ? 'file' : String(row.rowNumber),
          row.status,
          row.actionTaken ?? '',
          changes.join('; '),
          issues.map((i) => `${i.severity === 'warning' ? 'warning: ' : ''}${i.field ? `${i.field}: ` : ''}${i.message}`).join('; '),
          ...columns.map((c) => (raw[c.key] === undefined || raw[c.key] === null ? '' : String(raw[c.key]))),
        ]);
      }
      if (rows.length < PAGE) break;
    }
    const csv = `${lines.map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`;
    return { fileName: `import-${IMPORT_KIND_SLUGS[job.kind]}-${job.id}-report.csv`, csv };
  }

  /**
   * Applies a finished dry run: a new job on the same stored file, kind and
   * mode, run for real by the user who asks. The file is planned again when
   * the job runs, so a change in the shop since the dry run is seen.
   */
  async applyDryRun(shopId: string, id: string, userId: string) {
    const dryRun = await this.get(shopId, id);
    if (!dryRun.dryRun) throw new ConflictException({ message: 'This import was not a dry run; it has already been applied.', code: 'IMPORT_NOT_A_DRY_RUN' });
    if (!DRY_RUN_APPLICABLE.has(dryRun.status)) {
      throw new ConflictException({ message: `The dry run is ${dryRun.status}; only a finished dry run with rows to import can be applied.`, code: 'IMPORT_DRY_RUN_NOT_APPLICABLE', details: { status: dryRun.status } });
    }
    const job = await this.prisma.importJob.create({
      data: {
        shopId,
        kind: dryRun.kind,
        fileName: dryRun.fileName,
        fileSize: dryRun.fileSize,
        fileUrl: dryRun.fileUrl,
        format: dryRun.format,
        mode: dryRun.mode,
        dryRun: false,
        status: JobStatus.PENDING,
        createdById: userId,
      },
    });
    await this.importQueue.add(PROCESS_IMPORT_JOB, { jobId: job.id, shopId });
    return { message: 'Import queued successfully', jobId: job.id, kind: job.kind, dryRun: false, fromDryRun: dryRun.id };
  }
}
