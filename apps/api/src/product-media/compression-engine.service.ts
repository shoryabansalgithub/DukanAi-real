import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BullConfig } from '../config/domains/bull.config';
import { enqueueWithin } from '../common/queues/enqueue';

/**
 * Hands a stored media file to the `media-processing` worker (thumbnails,
 * metadata). Called on the upload request, so the add is bounded by
 * BULL_ENQUEUE_TIMEOUT_MS (audit R5): a Redis outage rejects it with 503
 * QUEUE_UNAVAILABLE instead of hanging the request.
 */
@Injectable()
export class CompressionEngineService {
  private readonly logger = new Logger(CompressionEngineService.name);

  constructor(
    @InjectQueue('media-processing') private readonly mediaQueue: Queue,
    private readonly bullConfig: BullConfig,
  ) {}

  /**
   * Dispatches a job to asynchronously generate thumbnails (WEBP, AVIF)
   * and extract metadata.
   */
  async queueImageProcessing(assetId: string, shopId: string, filePath: string) {
    this.logger.log(`Dispatching image processing for asset ${assetId}`);
    await enqueueWithin(this.mediaQueue, 'generate-thumbnails', { assetId, shopId, filePath }, undefined, this.bullConfig.enqueueTimeoutMs);
  }

  /**
   * Dispatches a job to process video files (metadata, previews).
   */
  async queueVideoProcessing(assetId: string, shopId: string, filePath: string) {
    this.logger.log(`Dispatching video processing for asset ${assetId}`);
    await enqueueWithin(this.mediaQueue, 'process-video', { assetId, shopId, filePath }, undefined, this.bullConfig.enqueueTimeoutMs);
  }
}
