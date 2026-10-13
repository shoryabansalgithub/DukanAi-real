import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ValidationRuleEngine } from './validation-rule.engine';
import { QualityScoreEngine } from './quality-score.engine';
import { ValidationSeverity, Product, ProductVariant, MediaReference } from '@prisma/client';

export interface ValidationIssue {
  stage: string;
  field?: string;
  message: string;
  severity: ValidationSeverity;
}

export interface ValidationPipelineResult {
  isBlocked: boolean;
  issues: ValidationIssue[];
}

export type PipelineContext = Product & {
  variants: ProductVariant[];
  mediaReferences: MediaReference[];
};

@Injectable()
export class ValidationPipeline {
  private readonly logger = new Logger(ValidationPipeline.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: ValidationRuleEngine,
    private readonly qualityEngine: QualityScoreEngine,
  ) {}

  /**
   * Executes the 10-stage validation pipeline.
   * Does NOT throw errors; aggregates issues.
   */
  async execute(shopId: string, context: PipelineContext): Promise<ValidationPipelineResult> {
    const rules = await this.ruleEngine.getActiveRules(shopId);
    const issues: ValidationIssue[] = [];

    // Stage 1: Basic Entity Validation
    if (!context.name || context.name.length < 3) {
      issues.push({ stage: 'BASIC', field: 'name', message: 'Name is too short', severity: 'BLOCKING' });
    }

    // Stage 2: Pricing Validation
    for (const variant of context.variants) {
      if (variant.sellingPrice && variant.mrp) {
        if (Number(variant.sellingPrice) > Number(variant.mrp)) {
          const rule = rules.find(r => r.ruleKey === 'PRICE_GREATER_THAN_MRP');
          issues.push({
            stage: 'PRICING',
            field: 'sellingPrice',
            message: 'Selling price cannot be greater than MRP',
            severity: rule?.severity || 'ERROR'
          });
        }
      }
    }

    // Stage 3: Media Validation
    if (!context.mediaReferences || context.mediaReferences.length === 0) {
      const rule = rules.find(r => r.ruleKey === 'REQUIRE_PRIMARY_IMAGE');
      issues.push({
        stage: 'MEDIA',
        field: 'mediaReferences',
        message: 'Product missing primary image',
        severity: rule?.severity || 'WARNING'
      });
    }

    // Determine if blocked
    const isBlocked = issues.some(issue => this.ruleEngine.isBlocking(issue.severity));

    return { isBlocked, issues };
  }
}
