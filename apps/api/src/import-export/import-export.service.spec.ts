import { ConflictException, NotFoundException } from '@nestjs/common';
import { ImportKind, ImportMode, JobStatus } from '@prisma/client';
import { ImportExportService } from './import-export.service';

function setup(job: Record<string, unknown> | null, rows: Array<Record<string, unknown>> = []) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    importJob: {
      findFirst: jest.fn(async () => job),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'job-2', ...data };
      }),
    },
    importJobRow: { findMany: jest.fn(async ({ skip }: { skip: number }) => (skip === 0 ? rows : [])) },
  };
  const queue = { add: jest.fn() };
  const service = new ImportExportService(prisma as never, {} as never, queue as never);
  return { service, prisma, queue, created };
}

const dryRun = { id: 'job-1', shopId: 'shop-1', kind: ImportKind.CUSTOMERS, fileName: 'customers.csv', fileSize: 120, fileUrl: '/data/imports/shop-1-x.csv', format: 'CSV', mode: ImportMode.UPSERT, dryRun: true, status: JobStatus.PARTIAL_SUCCESS };

describe('ImportExportService (roadmap 9.20)', () => {
  it('applies a finished dry run as a new job on the same stored file, run by the user who asks', async () => {
    const t = setup(dryRun);
    const result = await t.service.applyDryRun('shop-1', 'job-1', 'manager-1');
    expect(t.created).toEqual([expect.objectContaining({ shopId: 'shop-1', kind: ImportKind.CUSTOMERS, fileUrl: dryRun.fileUrl, mode: ImportMode.UPSERT, dryRun: false, status: JobStatus.PENDING, createdById: 'manager-1' })]);
    expect(t.queue.add).toHaveBeenCalledWith('process-import', { jobId: 'job-2', shopId: 'shop-1' });
    expect(result).toEqual(expect.objectContaining({ jobId: 'job-2', fromDryRun: 'job-1', dryRun: false }));
  });

  it('refuses to apply a real run, an unfinished or failed dry run, and an unknown job', async () => {
    await expect(setup({ ...dryRun, dryRun: false }).service.applyDryRun('shop-1', 'job-1', 'u')).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ ...dryRun, status: JobStatus.PROCESSING }).service.applyDryRun('shop-1', 'job-1', 'u')).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ ...dryRun, status: JobStatus.FAILED }).service.applyDryRun('shop-1', 'job-1', 'u')).rejects.toBeInstanceOf(ConflictException);
    await expect(setup(null).service.applyDryRun('shop-1', 'job-1', 'u')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes the report as CSV: result, changes and problems first, then the row as the template spells it', async () => {
    const t = setup(dryRun, [
      { rowNumber: 0, status: 'SUCCESS', actionTaken: 'FILE', rawData: {}, errors: [{ message: 'Column not read: "Colour".', severity: 'warning' }], changes: null },
      { rowNumber: 2, status: 'SUCCESS', actionTaken: 'WOULD_CREATE', rawData: { name: 'Ramesh', phone: '9876543210', openingBalance: '1250' }, errors: null, changes: ['new customer Ramesh', 'opening udhar 1250.00'] },
      { rowNumber: 3, status: 'ERROR', actionTaken: null, rawData: { name: '=cmd', phone: '1' }, errors: [{ field: 'phone', message: '"1" is not a phone number (6 to 15 digits).', severity: 'error' }], changes: null },
    ]);
    const report = await t.service.reportCsv('shop-1', 'job-1');
    expect(report.fileName).toBe('import-customers-job-1-report.csv');
    expect(report.csv.split('\n')).toEqual([
      'row,status,action,changes,problems,name,phone,email,address,city,state,creditLimit,openingBalance,notes',
      'file,SUCCESS,FILE,,"warning: Column not read: ""Colour"".",,,,,,,,,',
      '2,SUCCESS,WOULD_CREATE,new customer Ramesh; opening udhar 1250.00,,Ramesh,9876543210,,,,,,1250,',
      `3,ERROR,,,"phone: ""1"" is not a phone number (6 to 15 digits).",'=cmd,1,,,,,,,`,
      '',
    ]);
  });
});
