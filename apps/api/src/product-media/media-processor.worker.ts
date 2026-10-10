import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CdnManagerService } from './cdn-manager.service';
import sharp from 'sharp';
import * as path from 'path';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { jobContext } from '../iam/tenant-context/job-context';

@Processor('media-processing')
@Injectable()
export class MediaProcessorWorker extends WorkerHost {
  private readonly logger = new Logger(MediaProcessorWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cdn: CdnManagerService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  process(job: Job<any, any, string>): Promise<any> {
    const shopId = job.data?.shopId;
    if (typeof shopId !== 'string' || !shopId) throw new Error(`Media job ${String(job.id)} has no shopId`);
    return this.tenantContext.runWithContext(jobContext(shopId, String(job.id)), () => this.processForShop(job));
  }

  private async processForShop(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'generate-thumbnails':
        return this.handleImageThumbnails(job.data);
      case 'process-video':
        return this.handleVideoProcessing(job.data);
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  private async handleImageThumbnails(data: { assetId: string; shopId: string; filePath: string }) {
    const { assetId, shopId, filePath } = data;
    this.logger.log(`Generating thumbnails for image asset ${assetId}`);

    try {
      const metadata = await sharp(filePath).metadata();
      
      // Update asset metadata
      await this.prisma.mediaMetadata.upsert({
        where: { assetId },
        update: { width: metadata.width, height: metadata.height },
        create: {
          assetId,
          width: metadata.width,
          height: metadata.height,
          exifData: metadata.exif ? JSON.stringify(metadata.exif) : undefined,
        },
      });

      const sizes = [
        { key: '100px', width: 100 },
        { key: '300px', width: 300 },
        { key: '600px', width: 600 },
      ];

      for (const size of sizes) {
        if (!metadata.width || metadata.width <= size.width) continue; // Skip if original is smaller

        const prefixDir = path.dirname(filePath);
        const originalName = path.basename(filePath, path.extname(filePath));
        const thumbPath = path.join(prefixDir, `${originalName}-${size.key}.webp`);

        await sharp(filePath)
          .resize(size.width)
          .webp({ quality: 80 })
          .toFile(thumbPath);

        const cdnUrl = this.cdn.generateCdnUrl(thumbPath);

        await this.prisma.mediaThumbnail.create({
          data: {
            assetId,
            shopId,
            sizeKey: size.key,
            path: thumbPath,
            cdnUrl,
            width: size.width,
            height: Math.round((size.width / (metadata.width || 1)) * (metadata.height || 1)),
            mimeType: 'image/webp',
          },
        });
      }

      this.logger.log(`Thumbnails generated successfully for ${assetId}`);
    } catch (error) {
      this.logger.error(`Thumbnail generation failed for ${assetId}: ${(error as Error).message}`);
      throw error;
    }
  }

  private async handleVideoProcessing(data: { assetId: string; shopId: string; filePath: string }) {
    // In a real implementation, fluent-ffmpeg would be used here to extract duration and generate a preview frame.
    this.logger.log(`Video processing stub executed for ${data.assetId}`);
  }
}
