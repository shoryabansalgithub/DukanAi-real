import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { assertOwned } from '../prisma/tenant-ownership';
import { PrismaService } from '../prisma/prisma.service';
import { UploadEngineService, UploadedFile } from './upload-engine.service';
import { DeduplicationService } from './deduplication.service';
import { CdnManagerService, mediaFileUrl } from './cdn-manager.service';
import { CompressionEngineService } from './compression-engine.service';
import * as fs from 'fs';
import * as path from 'path';
import { ListQueryDto, MAX_LIST_TAKE, pageArgs } from '../common/pagination';
import { discardUpload, fileNameTooLong } from '../common/upload/upload-options';

/** What `GET /media/assets/:id/file` streams. */
export interface MediaFile {
  path: string;
  mimeType: string;
  size: number;
  fileName: string;
}

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
    // The interceptor's filter refuses a long name before storing it; a direct caller is held to the same rule (audit P3).
    const tooLong = fileNameTooLong(file?.originalname);
    if (tooLong) {
      await discardUpload(file);
      throw tooLong;
    }
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

      // 7. Store Storage Reference. The file is served by the authenticated,
      //    tenant-checked route (audit P3): nothing serves a static path.
      await this.prisma.mediaStorage.create({
        data: {
          shopId,
          assetId: asset.id,
          provider: 'LOCAL',
          path: finalPath,
          cdnUrl: mediaFileUrl(asset.id),
        },
      });

      // 8. Queue Background Processing (Thumbnails / Video extraction). Best
      //    effort (audit R5): the asset is stored and usable without
      //    thumbnails, so a queue outage is logged rather than failing an
      //    upload whose retry would only add a second reference.
      try {
        if (mediaType === 'IMAGE') {
          await this.compression.queueImageProcessing(asset.id, shopId, finalPath);
        } else if (mediaType === 'VIDEO') {
          await this.compression.queueVideoProcessing(asset.id, shopId, finalPath);
        }
      } catch (error) {
        this.logger.warn(`Media ${asset.id}: processing not queued (${(error as Error).message}); the original is stored without thumbnails`);
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
    // The gallery of an unknown or foreign product is 404, not an empty page (phase 4 gate).
    await assertOwned(this.prisma, 'product', productId, shopId);
    await assertOwned(this.prisma, 'productVariant', variantId, shopId);
    const { skip, take } = pageArgs(query);
    const where = { shopId, productId, variantId };
    const [rows, total] = await Promise.all([
      this.prisma.mediaReference.findMany({
        where,
        include: {
          asset: {
            include: {
              metadata: true,
              storage: true,
              thumbanils: { take: MAX_LIST_TAKE }, // Note spelling
              // Explicit join rows (roadmap 8.1); the response keeps the tag objects.
              tags: { take: MAX_LIST_TAKE, select: { tag: { select: { id: true, shopId: true, name: true } } } },
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.mediaReference.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        ...row,
        asset: {
          ...row.asset,
          tags: row.asset.tags.map((t) => t.tag),
          // Never the server's absolute path (audit P3): the store-relative path and the route that serves the file.
          storage: row.asset.storage ? { ...row.asset.storage, path: this.cdn.publicPath(row.asset.storage.path), cdnUrl: mediaFileUrl(row.asset.id) } : null,
          thumbanils: row.asset.thumbanils.map((t) => ({ ...t, path: this.cdn.publicPath(t.path), cdnUrl: mediaFileUrl(row.asset.id, t.sizeKey) })),
        },
      })),
      total,
      skip,
      take,
    };
  }

  /**
   * The file of one of the shop's assets (or one of its thumbnails) for
   * `GET /media/assets/:id/file`: 404 for an unknown or foreign asset, an
   * unknown size, or a file that is gone from disk; never a path outside the
   * media store.
   */
  async openAssetFile(shopId: string, assetId: string, sizeKey?: string): Promise<MediaFile> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, shopId, isDeleted: false },
      select: { id: true, hash: true, extension: true, mimeType: true, storage: { select: { path: true } }, thumbanils: { where: { sizeKey: sizeKey ?? '' }, select: { path: true, mimeType: true } } },
    });
    if (!asset) throw new NotFoundException({ message: 'Media asset not found', code: 'MEDIA_NOT_FOUND' });
    const stored = sizeKey ? asset.thumbanils[0] : asset.storage ? { path: asset.storage.path, mimeType: asset.mimeType } : undefined;
    if (!stored) throw new NotFoundException({ message: sizeKey ? `No ${sizeKey} rendition of this media asset` : 'Media asset has no stored file', code: 'MEDIA_FILE_NOT_FOUND' });
    const absolute = this.cdn.containedPath(stored.path);
    const stat = absolute ? await fs.promises.stat(absolute).catch(() => null) : null;
    if (!absolute || !stat?.isFile()) throw new NotFoundException({ message: 'The media file is not on the server', code: 'MEDIA_FILE_NOT_FOUND' });
    return { path: absolute, mimeType: stored.mimeType, size: stat.size, fileName: path.basename(absolute) };
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
    // The join row is tenant-owned (roadmap 8.1): idempotent per (asset, tag).
    await this.prisma.mediaAssetTag.upsert({
      where: { assetId_tagId: { assetId, tagId: mediaTag.id } },
      update: {},
      create: { assetId, tagId: mediaTag.id, shopId },
      select: { assetId: true },
    });
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
