import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertOwned, assertOwnedMany } from '../prisma/tenant-ownership';
import { ValidationPipeline } from './validation-pipeline';
import { QualityScoreEngine } from './quality-score.engine';
import { DuplicateDetectionEngine } from './duplicate-detection.engine';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MAX_LIST_TAKE } from '../common/pagination';

@Injectable()
export class ProductValidationService {
  private readonly logger = new Logger(ProductValidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: ValidationPipeline,
    private readonly qualityEngine: QualityScoreEngine,
    private readonly duplicateEngine: DuplicateDetectionEngine,
    @InjectQueue('product-validation') private readonly validationQueue: Queue,
  ) {}

  /**
   * Dispatches validation job to background (used heavily in imports/syncs).
   */
  async queueValidation(shopId: string, productId: string) {
    await this.validationQueue.add('validate-product', { shopId, productId });
  }

  /** Queues the shop's own products only; ids of other shops (or deleted products) are refused with 404. */
  async queueValidationMany(shopId: string, productIds: string[]): Promise<number> {
    const ids = [...new Set(productIds)];
    await assertOwnedMany(this.prisma, 'product', ids, shopId, { isDeleted: false });
    for (const productId of ids) await this.queueValidation(shopId, productId);
    return ids.length;
  }

  /**
   * Fully executes the validation pipeline for a product synchronously.
   * Calculates quality score, runs duplicate checks, and persists issues.
   */
  async executeValidation(shopId: string, productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId, shopId },
      include: { variants: true, mediaReferences: true }
    });

    if (!product) throw new NotFoundException('Product not found');

    this.logger.debug(`Executing validation pipeline for ${productId}`);

    // 1. Calculate Quality Score
    const quality = this.qualityEngine.calculateScore({ product });
    
    // Every state row is written and read by shop (roadmap 4.1): the tenant
    // extension scopes the HTTP path, but the worker path must be explicit too.
    await this.prisma.productQualityScore.upsert({
      where: { productId, shopId },
      update: {
        score: quality.score,
        missingFields: JSON.stringify(quality.missingFields),
        suggestions: JSON.stringify(quality.suggestions),
        calculatedAt: new Date()
      },
      create: {
        shopId,
        productId,
        score: quality.score,
        missingFields: JSON.stringify(quality.missingFields),
        suggestions: JSON.stringify(quality.suggestions),
      }
    });

    // 2. Execute Rules Pipeline
    const result = await this.pipeline.execute(shopId, product);

    // Persist issues
    await this.prisma.productValidationIssue.deleteMany({ where: { productId, shopId } });
    if (result.issues.length > 0) {
      await this.prisma.productValidationIssue.createMany({
        data: result.issues.map(issue => ({
          shopId,
          productId,
          stage: issue.stage,
          field: issue.field,
          message: issue.message,
          severity: issue.severity,
        }))
      });
    }

    // 3. Duplicate Detection
    await this.duplicateEngine.scanForDuplicates(shopId, { product });

    // Optional: Emit WebSockets event here via an injected Gateway

    return {
      qualityScore: quality.score,
      isBlocked: result.isBlocked,
      issues: result.issues
    };
  }

  async getValidationState(shopId: string, productId: string) {
    await assertOwned(this.prisma, 'product', productId, shopId);
    const score = await this.prisma.productQualityScore.findFirst({ where: { productId, shopId } });
    // Issues are bounded by the rule set; duplicate candidates grow with the catalogue, so they are capped (roadmap 5.6).
    const issues = await this.prisma.productValidationIssue.findMany({ where: { productId, shopId }, take: MAX_LIST_TAKE });
    const duplicates = await this.prisma.duplicateCandidate.findMany({
      where: { shopId, sourceId: productId },
      orderBy: [{ score: 'desc' }, { id: 'asc' }],
      take: MAX_LIST_TAKE,
    });

    return {
      score,
      issues,
      duplicates
    };
  }
}

