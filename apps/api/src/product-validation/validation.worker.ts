import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { ProductValidationService } from './product-validation.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { jobContext, requireJobShop } from '../iam/tenant-context/job-context';

interface ValidateProductJob { shopId: string; productId: string }
interface BulkValidateJob { shopId: string; productIds: string[] }

/** Runs every validation inside the job's shop context (roadmap 4.1, audit P2-5). */
@Processor('product-validation')
@Injectable()
export class ValidationWorker extends WorkerHost {
  private readonly logger = new Logger(ValidationWorker.name);

  constructor(
    private readonly validationService: ProductValidationService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<ValidateProductJob | BulkValidateJob, unknown, string>): Promise<void> {
    if (job.name !== 'validate-product' && job.name !== 'bulk-validate') {
      this.logger.warn(`Unknown job name: ${job.name}`);
      return;
    }
    const shopId = requireJobShop(job.data, job.name);
    await this.tenantContext.runWithContext(jobContext(shopId, job.id), async () => {
      if (job.name === 'validate-product') await this.handleValidateProduct(job.data as ValidateProductJob);
      else await this.handleBulkValidate(job.data as BulkValidateJob);
    });
  }

  private async handleValidateProduct(data: ValidateProductJob) {
    this.logger.log(`Background validation for product ${data.productId}`);
    await this.validationService.executeValidation(data.shopId, data.productId);
  }

  private async handleBulkValidate(data: BulkValidateJob) {
    this.logger.log(`Bulk validation for ${data.productIds.length} products`);
    for (const id of data.productIds) {
      try {
        await this.validationService.executeValidation(data.shopId, id);
      } catch (err) {
        this.logger.error(`Failed bulk validation for ${id}: ${(err as Error).message}`);
      }
    }
  }
}
