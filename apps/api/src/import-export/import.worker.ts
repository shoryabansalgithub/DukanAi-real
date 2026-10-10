import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { JobStatus, Role } from '@prisma/client';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { ImportExecutionService } from './import-execution.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { jobContext } from '../iam/tenant-context/job-context';

export const IMPORT_JOB_QUEUE = 'import-job';
export const PROCESS_IMPORT_JOB = 'process-import';

export interface ImportJobData {
  jobId: string;
  /** Set by the controller; older jobs without it resolve the shop from the ImportJob row. */
  shopId?: string;
}

/**
 * Runs each import inside its shop's tenant context (roadmap 4.1, audit P2-5)
 * and as the user who started it (roadmap 9.20): products record their
 * creator, udhar rows their recorder, and the services' own authority rules
 * (credit limits and opening balances are MANAGER+) apply to that user, who
 * must still be an active manager of the shop when the job runs. A job from
 * before `createdById` existed runs as the shop owner.
 */
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
    // The job row names its shop and its user; read as the system tenant (the only unscoped read).
    // Awaited inside the scope: a Prisma promise is lazy and would run, unscoped, wherever it is awaited.
    const head = await this.tenantContext.runAsSuperAdmin(async () => await this.prisma.importJob.findUnique({ where: { id: job.data.jobId }, select: { shopId: true, createdById: true } }));
    if (!head) {
      this.logger.warn(`Import job ${job.data.jobId} no longer exists; nothing to do.`);
      return;
    }
    if (job.data.shopId && job.data.shopId !== head.shopId) throw new Error(`Import job ${job.data.jobId} belongs to another shop than its queue entry names.`);
    const shopId = head.shopId;

    const actor = await this.tenantContext.runAsSuperAdmin(() => this.actorFor(shopId, head.createdById));
    if (!actor) {
      await this.tenantContext.runWithContext(jobContext(shopId, job.id), () => this.refuse(job.data.jobId, shopId));
      return;
    }
    await this.tenantContext.runWithContext({ ...jobContext(shopId, job.id), userId: actor.userId, role: actor.role }, () =>
      this.importExecution.processJob(job.data.jobId, { shopId, userId: actor.userId, role: actor.role }),
    );
  }

  /** The user the import acts as, when they may still import into the shop. */
  private async actorFor(shopId: string, createdById: string | null): Promise<{ userId: string; role: Role } | null> {
    const userId = createdById ?? (await this.prisma.shop.findUnique({ where: { id: shopId }, select: { ownerId: true } }))?.ownerId;
    if (!userId) return null;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, shopId: true, role: true, isActive: true, isDeleted: true } });
    if (!user || user.shopId !== shopId || !user.isActive || user.isDeleted || !MANAGEMENT_ROLES.includes(user.role)) return null;
    return { userId: user.id, role: user.role };
  }

  private async refuse(jobId: string, shopId: string): Promise<void> {
    this.logger.warn(`Import job ${jobId}: its user can no longer import into the shop; not run.`);
    await this.prisma.importJobRow.create({
      data: {
        importJobId: jobId,
        rowNumber: 0,
        rawData: {},
        status: 'ERROR',
        actionTaken: 'FILE',
        errors: [{ message: 'The user who started this import is no longer an active manager of the shop; nothing was imported.', severity: 'error' }],
      },
    });
    await this.prisma.importJob.updateMany({ where: { id: jobId, shopId }, data: { status: JobStatus.FAILED, completedAt: new Date() } });
  }
}
