import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { ImportExecutionService } from './import-execution.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { jobContext, runInShopOf } from '../iam/tenant-context/job-context';

export const IMPORT_JOB_QUEUE = 'import-job';
export const PROCESS_IMPORT_JOB = 'process-import';

export interface ImportJobData {
  jobId: string;
  /** Set by the controller; older jobs without it resolve the shop from the ImportJob row. */
  shopId?: string;
}

/** Runs each import inside its shop's tenant context (roadmap 4.1, audit P2-5). */
@Processor(IMPORT_JOB_QUEUE)
@Injectable()
export class ImportWorker extends WorkerHost {
  private readonly logger = new Logger(ImportWorker.name);

  constructor(
    private readonly importExecution: ImportExecutionService,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<ImportJobData, unknown, string>): Promise<void> {
    if (job.name !== PROCESS_IMPORT_JOB) {
      this.logger.warn(`Unknown import job name: ${job.name}`);
      return;
    }
    this.logger.log(`Starting background import job ${job.data.jobId}`);
    if (job.data.shopId) {
      await this.tenantContext.runWithContext(jobContext(job.data.shopId, job.id), () => this.importExecution.processJob(job.data.jobId));
      return;
    }
    const ran = await runInShopOf(this.tenantContext, this.prisma as unknown as Record<string, unknown>, 'importJob', job.data.jobId, job.id, () => this.importExecution.processJob(job.data.jobId).then(() => true));
    if (!ran) this.logger.warn(`Import job ${job.data.jobId} no longer exists; nothing to do.`);
  }
}
