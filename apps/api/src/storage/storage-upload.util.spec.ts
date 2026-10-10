import { BadRequestException } from '@nestjs/common';
import { assertImageFile, assertPdfFile, billingDocumentUploadPolicy, validateUploadedFile } from './storage-upload.util';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PDF = Buffer.from('%PDF-1.4\n%');

const file = (originalname: string, mimetype: string, buffer?: Buffer): Express.Multer.File =>
  ({ fieldname: 'f', originalname, mimetype, size: buffer?.length ?? 0, buffer } as unknown as Express.Multer.File);

describe('storage upload validation (roadmap 5.1)', () => {
  it('still applies the size, extension and declared-type policy', () => {
    expect(() => validateUploadedFile(undefined, billingDocumentUploadPolicy)).toThrow(BadRequestException);
    expect(() => validateUploadedFile(file('a.exe', 'application/pdf', PDF), billingDocumentUploadPolicy)).toThrow(/Executable/);
    expect(() => validateUploadedFile(file('a.gif', 'image/gif', PNG), billingDocumentUploadPolicy)).toThrow(/extension/);
    const big = file('a.pdf', 'application/pdf', PDF);
    (big as { size: number }).size = billingDocumentUploadPolicy.maxBytes + 1;
    expect(() => validateUploadedFile(big, billingDocumentUploadPolicy)).toThrow(/maximum allowed size/);
  });

  it('at the filter stage (no bytes yet) it judges the declaration; after the upload the bytes must agree', () => {
    // Filter stage: multer calls with no buffer.
    expect(validateUploadedFile(file('a.png', 'image/png'), billingDocumentUploadPolicy).mimetype).toBe('image/png');
    // Upload stage: bytes present.
    expect(assertImageFile(file('a.png', 'image/png', PNG)).mimetype).toBe('image/png');
    expect(assertImageFile(file('a.jpg', 'image/jpeg', JPEG)).mimetype).toBe('image/jpeg');
    expect(assertPdfFile(file('a.pdf', 'application/pdf', PDF)).mimetype).toBe('application/pdf');
    expect(() => assertImageFile(file('a.png', 'image/png', PDF))).toThrow(/does not match/);
    expect(() => assertPdfFile(file('a.pdf', 'application/pdf', PNG))).toThrow(/does not match/);
    expect(() => assertPdfFile(file('a.pdf', 'application/pdf', Buffer.from('MZ\u0090\u0000')))).toThrow(/does not match/);
    expect(validateUploadedFile(file('n.json', 'application/json', Buffer.from('{"a":1}')), billingDocumentUploadPolicy).mimetype).toBe('application/json');
    expect(() => validateUploadedFile(file('n.json', 'application/json', PNG), billingDocumentUploadPolicy)).toThrow(/does not match/);
  });
});
