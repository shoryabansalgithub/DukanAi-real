import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { enqueueWithin } from '../common/queues/enqueue';
import { BullConfig } from '../config/domains/bull.config';

@Injectable()
export class IndexingEngineService {
  private readonly logger = new Logger(IndexingEngineService.name);

  constructor(
    @InjectQueue('search-indexing') private readonly indexingQueue: Queue,
    private readonly bullConfig: BullConfig,
  ) {}

  /**
   * Dispatches a job to rebuild the entire search index for a tenant.
   */
  async triggerFullReindex(shopId: string) {
    this.logger.log(`Dispatching full reindex for shop ${shopId}`);
    // Bounded (audit R5): 503 QUEUE_UNAVAILABLE when Redis does not take it in time; a late reindex is harmless.
    await enqueueWithin(this.indexingQueue, 'full-reindex', { shopId }, undefined, this.bullConfig.enqueueTimeoutMs);
  }

  /**
   * Event listener facade: In a real architecture this listens to Outbox 
   * 'ProductUpdated' / 'ProductCreated' events and queues incremental updates.
   */
  async triggerIncrementalIndex(shopId: string, entityId: string, entityType: string) {
    this.logger.log(`Dispatching incremental index for ${entityType} ${entityId}`);
    await enqueueWithin(this.indexingQueue, 'incremental-index', { shopId, entityId, entityType }, undefined, this.bullConfig.enqueueTimeoutMs);
  }
}
