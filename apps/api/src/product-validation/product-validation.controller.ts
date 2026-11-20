import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { ProductValidationService } from './product-validation.service';
import { ValidationRuleEngine } from './validation-rule.engine';
import { CurrentShop } from '../iam/decorators';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { BulkValidationDto } from './dto/bulk-validation.dto';

/** Product quality validation (roadmap 4.1): the shop comes from the verified session. */
@Controller('products')
export class ProductValidationController {
  constructor(
    private readonly validationService: ProductValidationService,
    private readonly ruleEngine: ValidationRuleEngine,
  ) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/validate')
  async validateProduct(@Param('id') productId: string, @CurrentShop() shopId: string) {
    // Synchronous execution for immediate feedback
    return this.validationService.executeValidation(shopId, productId);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('bulk-validation')
  async bulkValidate(@Body() body: BulkValidationDto, @CurrentShop() shopId: string) {
    const queued = await this.validationService.queueValidationMany(shopId, body.productIds);
    return { message: `Validation queued for ${queued} products`, queued };
  }

  @Get(':id/quality')
  async getQualityScore(@Param('id') productId: string, @CurrentShop() shopId: string) {
    const state = await this.validationService.getValidationState(shopId, productId);
    return state.score || { score: 0, missingFields: [], suggestions: [] };
  }

  @Get(':id/issues')
  async getValidationIssues(@Param('id') productId: string, @CurrentShop() shopId: string) {
    const state = await this.validationService.getValidationState(shopId, productId);
    return state.issues;
  }

  @Get('validation/rules')
  async getRules(@CurrentShop() shopId: string) {
    return this.ruleEngine.getActiveRules(shopId);
  }
}
