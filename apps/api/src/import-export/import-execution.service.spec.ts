import { ConflictException } from '@nestjs/common';
import { ImportKind, ImportMode, JobStatus } from '@prisma/client';
import { ImportExecutionService } from './import-execution.service';
import { PlannedRow, RowAction } from './importers/import-plan';

type Row = { importJobId: string; rowNumber: number; status: string; actionTaken: string | null; errors?: unknown; changes?: unknown };

function setup(options: { mode?: ImportMode; dryRun?: boolean; status?: JobStatus; records?: Array<Record<string, string>>; plan?: () => PlannedRow[]; reported?: Row[] } = {}) {
  const job = {
    id: 'job-1',
    shopId: 'shop-1',
    kind: ImportKind.PRODUCTS,
    fileName: 'products.csv',
    fileUrl: '/tmp/products.csv',
    format: 'CSV',
    mode: options.mode ?? ImportMode.UPSERT,
    dryRun: options.dryRun ?? false,
    status: options.status ?? JobStatus.PENDING,
    startedAt: null,
  };
  const rows: Row[] = [...(options.reported ?? [])];
  const prisma = {
    importJob: {
      findFirst: jest.fn(async () => ({ ...job })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(job, data)),
    },
    importJobRow: {
      findMany: jest.fn(async () => rows.filter((r) => r.rowNumber > 0)),
      count: jest.fn(async ({ where }: { where: { rowNumber: number } }) => rows.filter((r) => r.rowNumber === where.rowNumber).length),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => rows.push(...data)),
      create: jest.fn(async ({ data }: { data: Row }) => rows.push(data)),
    },
    auditLog: { create: jest.fn() },
  };
  const records = options.records ?? [
    { sku: 'A', name: 'A', costPrice: '1', sellingPrice: '2' },
    { sku: 'B', name: 'B', costPrice: '1', sellingPrice: '2' },
    { sku: 'C', name: 'C', costPrice: '1', sellingPrice: '2' },
    { sku: 'D', name: 'D', costPrice: '1', sellingPrice: '2' },
  ];
  const parsing = { parseFile: jest.fn(async () => records) };
  const applied: number[] = [];
  const apply = (rowNumber: number, result: RowAction | Error) => async () => {
    applied.push(rowNumber);
    if (result instanceof Error) throw result;
    return result;
  };
  const defaultPlan = (): PlannedRow[] => [
    { rowNumber: 2, raw: { sku: 'A' }, issues: [], action: 'CREATE', changes: ['new product A'], apply: apply(2, 'CREATE') },
    { rowNumber: 3, raw: { sku: 'B' }, issues: [], action: 'UPDATE', changes: ['sellingPrice 1.00 → 2.00'], apply: apply(3, 'UPDATE') },
    { rowNumber: 4, raw: { sku: 'C' }, issues: [], action: 'UNCHANGED', changes: [] },
    { rowNumber: 5, raw: { sku: 'D' }, issues: [{ field: 'mrp', message: 'MRP below the selling price.', severity: 'error' }], changes: [] },
  ];
  const importer = { plan: jest.fn(async () => (options.plan ?? defaultPlan)()) };
  const cache = { del: jest.fn(async () => undefined) };
  const service = new ImportExecutionService(prisma as never, parsing as never, importer as never, importer as never, importer as never, cache as never);
  const actor = { shopId: 'shop-1', userId: 'user-1', role: 'OWNER' as const };
  return { service, prisma, job, rows, applied, importer, cache, actor, apply };
}

describe('ImportExecutionService (roadmap 9.20)', () => {
  it('a dry run plans every row, writes only the report and applies nothing', async () => {
    const t = setup({ dryRun: true });
    await t.service.processJob('job-1', t.actor);
    expect(t.applied).toEqual([]);
    expect(t.rows.map((r) => [r.rowNumber, r.status, r.actionTaken])).toEqual([
      [2, 'SUCCESS', 'WOULD_CREATE'],
      [3, 'SUCCESS', 'WOULD_UPDATE'],
      [4, 'SUCCESS', 'UNCHANGED'],
      [5, 'ERROR', null],
    ]);
    expect(t.rows[0].changes).toEqual(['new product A']);
    expect(t.job).toEqual(expect.objectContaining({ status: JobStatus.PARTIAL_SUCCESS, totalRows: 4, validRows: 3, errorRows: 1, createdCount: 1, updatedCount: 1, unchangedCount: 1, skippedCount: 0 }));
    expect(t.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(t.cache.del).not.toHaveBeenCalled();
  });

  it('a real run applies CREATE and UPDATE rows; a refused write is an ERROR row with the API message and the run goes on', async () => {
    const t = setup({
      plan: () => [
        { rowNumber: 2, raw: {}, issues: [], action: 'CREATE', changes: ['new'], apply: t.apply(2, new ConflictException({ message: 'Barcode 1 is already assigned to another product', code: 'BARCODE_IN_USE' })) },
        { rowNumber: 3, raw: {}, issues: [], action: 'UPDATE', changes: ['x'], apply: t.apply(3, 'UPDATE') },
        // A re-check inside the write found it already done.
        { rowNumber: 4, raw: {}, issues: [], action: 'CREATE', changes: ['y'], apply: t.apply(4, 'UNCHANGED') },
      ],
    });
    await t.service.processJob('job-1', t.actor);
    expect(t.applied).toEqual([2, 3, 4]);
    expect(t.rows.map((r) => [r.rowNumber, r.status, r.actionTaken])).toEqual([
      [2, 'ERROR', null],
      [3, 'SUCCESS', 'UPDATED'],
      [4, 'SUCCESS', 'UNCHANGED'],
    ]);
    expect(t.rows[0].errors).toEqual([{ message: 'Barcode 1 is already assigned to another product (BARCODE_IN_USE)', severity: 'error' }]);
    expect(t.job).toEqual(expect.objectContaining({ status: JobStatus.PARTIAL_SUCCESS, errorRows: 1, updatedCount: 1, unchangedCount: 1, createdCount: 0 }));
    expect(t.prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'IMPORT_APPLIED', entityId: 'job-1', userId: 'user-1' }) });
    expect(t.cache.del).toHaveBeenCalled();
  });

  it('CREATE_ONLY leaves existing rows alone and UPDATE_ONLY creates nothing (skipped, not errors)', async () => {
    const createOnly = setup({ mode: ImportMode.CREATE_ONLY });
    await createOnly.service.processJob('job-1', createOnly.actor);
    expect(createOnly.applied).toEqual([2]);
    expect(createOnly.rows.find((r) => r.rowNumber === 3)).toEqual(expect.objectContaining({ status: 'SKIPPED', actionTaken: 'SKIPPED' }));
    const updateOnly = setup({ mode: ImportMode.UPDATE_ONLY });
    await updateOnly.service.processJob('job-1', updateOnly.actor);
    expect(updateOnly.applied).toEqual([3]);
    expect(updateOnly.job).toEqual(expect.objectContaining({ skippedCount: 1, updatedCount: 1, createdCount: 0 }));
  });

  it('a file without a required column fails as a whole before any row is planned', async () => {
    const t = setup({ records: [{ sku: 'A', name: 'A', sellingPrice: '2' }] });
    await t.service.processJob('job-1', t.actor);
    expect(t.importer.plan).not.toHaveBeenCalled();
    expect(t.rows).toEqual([expect.objectContaining({ rowNumber: 0, status: 'ERROR', actionTaken: 'FILE', errors: [expect.objectContaining({ field: 'costPrice', severity: 'error' })] })]);
    expect(t.job.status).toBe(JobStatus.FAILED);
  });

  it('a redelivered job resumes after the rows it already reported', async () => {
    const t = setup({ reported: [{ importJobId: 'job-1', rowNumber: 2, status: 'SUCCESS', actionTaken: 'CREATED' }] });
    await t.service.processJob('job-1', t.actor);
    expect(t.applied).toEqual([3]);
    expect(t.job).toEqual(expect.objectContaining({ createdCount: 1, updatedCount: 1, unchangedCount: 1, errorRows: 1 }));
  });

  it('a finished job is not run again', async () => {
    const t = setup({ status: JobStatus.COMPLETED });
    await t.service.processJob('job-1', t.actor);
    expect(t.importer.plan).not.toHaveBeenCalled();
    expect(t.prisma.importJob.update).not.toHaveBeenCalled();
  });
});
