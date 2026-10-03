import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { assertOwned } from '../prisma/tenant-ownership';
import { PrismaService } from '../prisma/prisma.service';
import { UploadEngineService, UploadedFile } from './upload-engine.service';
import { DeduplicationService } from './deduplication.service';
import { CdnManagerService } from './cdn-manager.service';
import { CompressionEngineService } from './compression-engine.service';
import * as fs from 'fs';
import * as path from 'path';
import { ListQueryDto, MAX_LIST_TAKE, pageArgs } from '../common/pagination';

@Injectable()
export class ProductMediaService {
  private readonly logger = new Logger(ProductMediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadEngine: UploadEngineService,
    private readonly dedup: DeduplicationService,
    private readonly cdn: CdnManagerService,
    private readonly compression: CompressionEngineService,
  ) {}

  /**
   * Main entry point for uploading a new media asset.
   */
  async uploadMedia(
    shopId: string, 
    userId: string,
    file: UploadedFile, 
    productId?: string, 
    variantId?: string,
    isPrimary: boolean = false
  ) {
    // 0. The product / variant the media is attached to must belong to the shop
    //    (roadmap 4.1): a foreign key in the URL is never checked by the tenant extension.
    if (!productId && !variantId) throw new BadRequestException('Media must be attached to a product or a variant.');
    await assertOwned(this.prisma, 'product', productId, shopId, { isDeleted: false });
    await assertOwned(this.prisma, 'productVariant', variantId, shopId, { isDeleted: false });

    // 1. Validate constraints (size, declared type, magic bytes); a rejected file is discarded.
    await this.uploadEngine.validateFile(file);

    // 2. The upload is on disk (multer temp storage); a memory upload is written there.
    const tempPath = await this.uploadEngine.storeLocalTemporarily(file);
    try {
      return await this.persistUpload(shopId, userId, file, tempPath, productId, variantId, isPrimary);
    } finally {
      // Whatever happened, the temp file never outlives the request (the CDN move renames it away on success).
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
  }

  private async persistUpload(shopId: string, userId: string, file: UploadedFile, tempPath: string, productId: string | undefined, variantId: string | undefined, isPrimary: boolean) {
    // 3. Calculate Deduplication Hash
    const hash = await this.dedup.calculateFileHash(tempPath);

    // 4. Check for existing exact matches
    let asset = await this.dedup.findExistingAsset(shopId, hash);

    if (!asset) {
      // 5. Move to permanent CDN/Storage
      const extension = path.extname(file.originalname).slice(1) || 'bin';
      const finalPath = await this.cdn.persistLocal(tempPath, hash, extension);
      const cdnUrl = this.cdn.generateCdnUrl(finalPath);
      
      // Determine MediaType
      const mediaType = file.mimetype.startsWith('video/') ? 'VIDEO' : 
                        file.mimetype.startsWith('image/') ? 'IMAGE' : 'DOCUMENT';

      // 6. Create Asset Record
      asset = await this.prisma.mediaAsset.create({
        data: {
          shopId,
          hash,
          mimeType: file.mimetype,
          extension,
          sizeBytes: file.size,
          originalName: file.originalname,
          status: 'PUBLISHED',
        },
      });

      // 7. Store Storage Reference
      await this.prisma.mediaStorage.create({
        data: {
          shopId,
          assetId: asset.id,
          provider: 'LOCAL',
          path: finalPath,
          cdnUrl,
        },
      });

      // 8. Queue Background Processing (Thumbnails / Video extraction)
      if (mediaType === 'IMAGE') {
        await this.compression.queueImageProcessing(asset.id, shopId, finalPath);
      } else if (mediaType === 'VIDEO') {
        await this.compression.queueVideoProcessing(asset.id, shopId, finalPath);
      }
    } else {
      this.logger.log(`Asset ${hash} deduplicated. Proceeding to create references.`);
    }

    // 9. Bind Reference if applicable
    if (productId || variantId) {
      await this.prisma.mediaReference.create({
        data: {
          shopId,
          assetId: asset.id,
          productId,
          variantId,
          isPrimary,
        },
      });
    }

    // 10. Audit log
    await this.prisma.mediaAudit.create({
      data: {
        shopId,
        assetId: asset.id,
        userId,
        action: 'UPLOAD',
      },
    });

    return asset;
  }

  /**
   * Retrieves full gallery for a given product/variant.
   */
  async getGallery(shopId: string, productId?: string, variantId?: string, query?: ListQueryDto) {
    if (!productId && !variantId) throw new NotFoundException('Must provide productId or variantId');
    const { skip, take } = pageArgs(query);
    const where = { shopId, productId, variantId };
    const [items, total] = await Promise.all([
      this.prisma.mediaReference.findMany({
        where,
        include: {
          asset: {
            include: {
              metadata: true,
              storage: true,
              thumbanils: { take: MAX_LIST_TAKE }, // Note spelling
              tags: { take: MAX_LIST_TAKE },
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.mediaReference.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  /** Attaches a named tag (created on first use, unique per shop) to one of the shop's assets. */
  async tagAsset(shopId: string, assetId: string, name: string) {
    const tag = name.trim();
    if (!tag) throw new BadRequestException('Tag name is required.');
    await assertOwned(this.prisma, 'mediaAsset', assetId, shopId, { isDeleted: false });
    const mediaTag = await this.prisma.mediaTag.upsert({
      where: { shopId_name: { shopId, name: tag } },
      update: {},
      create: { shopId, name: tag },
      select: { id: true, name: true },
    });
    await this.prisma.mediaAsset.update({ where: { id: assetId }, data: { tags: { connect: { id: mediaTag.id } } }, select: { id: true } });
    return { assetId, tag: mediaTag };
  }

  /** Rewrites `sortOrder` for the references of one product or variant, in the order given. */
  async reorderReferences(shopId: string, dto: { productId?: string; variantId?: string; referenceIds: string[] }) {
    if (!dto.productId === !dto.variantId) throw new BadRequestException('Give exactly one of productId or variantId.');
    const owner = dto.productId ? { productId: dto.productId } : { variantId: dto.variantId };
    const references = await this.prisma.mediaReference.findMany({ where: { shopId, ...owner }, select: { id: true } });
    const known = new Set(references.map((r) => r.id));
    const unknown = dto.referenceIds.filter((id) => !known.has(id));
    if (unknown.length) throw new NotFoundException(`Media reference ${unknown.join(', ')} not found`);
    await this.prisma.$transaction(dto.referenceIds.map((id, index) => this.prisma.mediaReference.update({ where: { id }, data: { sortOrder: index }, select: { id: true } })));
    return this.getGallery(shopId, dto.productId, dto.variantId);
  }
}
