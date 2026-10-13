import { nextReconCursor, RECON_BATCH_ORDER, reconBatchWhere } from './recon-keyset';

describe('reconciliation keyset pagination (roadmap 5.4)', () => {
  const lookbackStart = new Date('2026-09-29T07:00:00.000Z');
  const runStart = new Date('2026-09-29T07:15:00.000Z');

  it('the first page is the closed window on updatedAt, live products only', () => {
    expect(reconBatchWhere(lookbackStart, runStart, null)).toEqual({ isDeleted: false, updatedAt: { gte: lookbackStart, lte: runStart } });
    expect(RECON_BATCH_ORDER).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
  });

  it('later pages continue strictly after the cursor in (updatedAt, id) order, never with an offset', () => {
    const cursor = { updatedAt: new Date('2026-09-29T07:10:00.000Z'), id: 'p-42' };
    const where = reconBatchWhere(lookbackStart, runStart, cursor);
    expect(where.OR).toEqual([{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: 'p-42' } }]);
    expect(where.updatedAt).toEqual({ gte: lookbackStart, lte: runStart });
    expect(JSON.stringify(where)).not.toContain('skip');
  });

  it('the cursor is the last row of the page, and an empty page ends the walk', () => {
    const rows = [
      { id: 'a', updatedAt: new Date('2026-09-29T07:01:00.000Z') },
      { id: 'b', updatedAt: new Date('2026-09-29T07:02:00.000Z') },
    ];
    expect(nextReconCursor(rows)).toEqual({ updatedAt: rows[1].updatedAt, id: 'b' });
    expect(nextReconCursor([])).toBeNull();
  });
});
