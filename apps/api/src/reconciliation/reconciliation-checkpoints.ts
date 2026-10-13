import { Injectable } from '@nestjs/common';
import { ReconciliationProbePoint } from './reconciliation-engine';

/**
 * Named points between the reconciliation engine's reads. A no-op in
 * production; the snapshot test overrides the provider to commit a sale
 * between two reads and proves the run still sees one consistent database
 * (release audit L5).
 */
@Injectable()
export class ReconciliationCheckpoints {
  async reach(_point: ReconciliationProbePoint): Promise<void> {
    /* no-op outside the snapshot test */
  }
}
