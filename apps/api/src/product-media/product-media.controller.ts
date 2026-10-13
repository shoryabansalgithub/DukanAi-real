import { Controller, Post, Get, Body, Param, UseInterceptors, UploadedFile, BadRequestException, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { ListQueryDto, PagedList } from '../common/pagination';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadCleanupInterceptor } from '../common/upload/upload-cleanup.interceptor';
import { ProductMediaService } from './product-media.service';
import { CurrentShop, CurrentUser } from '../iam/decorators';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { MediaFileQueryDto, ReorderMediaDto, TagMediaDto, UploadMediaDto } from './dto/tag-media.dto';
import { FeatureGate } from '../common/features/feature-gate';

/**
 * Product media (roadmap 4.1). The shop and the user come from the verified
 * session (`@CurrentShop`, `@CurrentUser`); `req.shop` was never set. The
 * former `bulk` and `search` stubs, which answered success without doing
 * anything, are gone; `tag` and `order` now do what they claim.
 */
@FeatureGate('media')
@Controller('media')
export class ProductMediaController {
  constructor(private readonly productMediaService: ProductMediaService) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post('upload/product/:id')
  @UseInterceptors(UploadCleanupInterceptor, FileInterceptor('file'))
  async uploadProductMedia(
    @Param('id') productId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadMediaDto,
    @CurrentShop() shopId: string,
    @CurrentUser('id') userId: string,
  ) {
    if (!file) throw new BadRequestException('File is required');
    return this.productMediaService.uploadMedia(shopId, userId, file, productId, undefined, body.isPrimary === 'true');
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('upload/variant/:id')
  @UseInterceptors(UploadCleanupInterceptor, FileInterceptor('file'))
  async uploadVariantMedia(
    @Param('id') variantId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadMediaDto,
    @CurrentShop() shopId: string,
    @CurrentUser('id') userId: string,
  ) {
    if (!file) throw new BadRequestException('File is required');
    return this.productMediaService.uploadMedia(shopId, userId, file, undefined, variantId, body.isPrimary === 'true');
  }

  @Get('product/:id')
  @PagedList()
  async getProductGallery(@Param('id') productId: string, @CurrentShop() shopId: string, @Query() query: ListQueryDto) {
    return this.productMediaService.getGallery(shopId, productId, undefined, query);
  }

  @Get('variant/:id')
  @PagedList()
  async getVariantGallery(@Param('id') variantId: string, @CurrentShop() shopId: string, @Query() query: ListQueryDto) {
    return this.productMediaService.getGallery(shopId, undefined, variantId, query);
  }

  /**
   * The file of one of the shop's media assets (audit P3): the `cdnUrl` of
   * an asset and its thumbnails names this route. Any signed-in member of
   * the shop may read it; an unknown or foreign asset is 404. The answer is
   * the stored bytes under their verified type, never sniffed by the browser
   * and sandboxed, so a document cannot run as a page of the API's origin.
   */
  @Get('assets/:id/file')
  async getAssetFile(
    @Param('id') assetId: string,
    @Query() query: MediaFileQueryDto,
    @CurrentShop() shopId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.productMediaService.openAssetFile(shopId, assetId, query.size);
    const inline = file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${file.fileName}"`);
    return new StreamableFile(createReadStream(file.path));
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('tag')
  async tagMedia(@Body() body: TagMediaDto, @CurrentShop() shopId: string) {
    return this.productMediaService.tagAsset(shopId, body.assetId, body.tag);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('order')
  async updateOrder(@Body() body: ReorderMediaDto, @CurrentShop() shopId: string) {
    return this.productMediaService.reorderReferences(shopId, body);
  }
}
