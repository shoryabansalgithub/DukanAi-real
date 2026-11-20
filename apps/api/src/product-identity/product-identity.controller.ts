import { Controller, Post, Get, Body, Param, Query, Res } from '@nestjs/common';
import { ListQueryDto, PagedList, pageArgs } from '../common/pagination';
import { ProductIdentityService } from './product-identity.service';
import { BarcodeGeneratorService } from './barcode-generator.service';
import { IdentityAuditService } from './identity-audit.service';
import { CurrentShop, CurrentUser } from '../iam/decorators';
import type { Response } from 'express';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { AssignBarcodeDto } from './dto/assign-barcode.dto';
import { RenderBarcodeQueryDto } from './dto/render-barcode.dto';
import { SearchIdentityQueryDto } from './dto/search-identity-query.dto';

/** Barcodes and SKU identities (roadmap 4.1): shop and user from the verified session. */
@Controller('product-identity')
export class ProductIdentityController {
  constructor(
    private readonly productIdentityService: ProductIdentityService,
    private readonly barcodeGenerator: BarcodeGeneratorService,
    private readonly identityAudit: IdentityAuditService,
  ) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post('products/:id/barcode')
  async assignBarcodeToProduct(@Param('id') productId: string, @Body() body: AssignBarcodeDto, @CurrentShop() shopId: string, @CurrentUser('id') userId: string) {
    return this.productIdentityService.generateBarcode({ shopId, code: body.code, format: body.format, productId, userId });
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('variants/:id/barcode')
  async assignBarcodeToVariant(@Param('id') variantId: string, @Body() body: AssignBarcodeDto, @CurrentShop() shopId: string, @CurrentUser('id') userId: string) {
    return this.productIdentityService.generateBarcode({ shopId, code: body.code, format: body.format, variantId, userId });
  }

  @Get('barcode/search')
  async searchBarcode(@Query() query: SearchIdentityQueryDto, @CurrentShop() shopId: string) {
    return this.productIdentityService.searchIdentity(shopId, query.q);
  }

  /** Change history of a barcode; a SKU (variant identity) has no barcode history and answers an empty list. */
  @Get('barcode/:code/history')
  @PagedList()
  async getBarcodeHistory(@Param('code') code: string, @CurrentShop() shopId: string, @Query() query: ListQueryDto) {
    const identity = await this.productIdentityService.searchIdentity(shopId, code);
    if (!('code' in identity)) return { items: [], total: 0, ...pageArgs(query) };
    return this.identityAudit.getBarcodeHistory(shopId, identity.id, query);
  }

  @Get('barcode/:code/render')
  async renderBarcode(@Param('code') code: string, @Query() query: RenderBarcodeQueryDto, @Res() res: Response) {
    try {
      const buffer = await this.barcodeGenerator.generateBuffer(code, query.format ?? 'CODE128');
      res.set('Content-Type', 'image/png');
      res.send(buffer);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  }
}
