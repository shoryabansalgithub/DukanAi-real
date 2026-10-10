import { NotFoundException } from '@nestjs/common';
import { ImportKind } from '@prisma/client';
import { ImportExportController } from './import-export.controller';
import { templateCsv } from './import-columns';

describe('ImportExportController (roadmap 9.20)', () => {
  const imports = { queueUpload: jest.fn(async () => ({ jobId: 'job-1' })) };
  const controller = new ImportExportController(imports as never, { exportListLimit: 100 } as never);

  it('serves each template as a CSV download and 404s an unknown kind', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => (headers[name] = value) };
    expect(controller.template('opening-stock', res as never)).toBe(templateCsv(ImportKind.OPENING_STOCK));
    expect(headers['Content-Disposition']).toBe('attachment; filename="opening-stock.csv"');
    expect(() => controller.template('suppliers', res as never)).toThrow(NotFoundException);
  });

  it('refuses a request without a file before anything is queued (uploads are covered by the integration spec)', async () => {
    await expect(controller.uploadCustomers(undefined, {}, 'shop-1', 'user-1')).rejects.toThrow('No file uploaded');
    expect(imports.queueUpload).not.toHaveBeenCalled();
  });
});
