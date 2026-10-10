import { Controller, Post, Body, Param } from '@nestjs/common';
import { ProductVariantsService } from './product-variants.service';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';
import { GenerateVariantsDto } from './dto/generate-variants.dto';

@Controller('products/:productId/variants')
export class ProductVariantsController {
  constructor(private readonly variantsService: ProductVariantsService) {}

  @Post('generate')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  generateVariants(
      @Param('productId') productId: string, 
      @Body() dto: GenerateVariantsDto,
  ) {
    return this.variantsService.generateVariants(productId, dto.attributes);
  }
}
