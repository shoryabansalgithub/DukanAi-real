import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertUploadContent, buildUploadOptions, discardUpload, readUploadHeader, uploadFileFilter, UploadPolicy } from './upload-options';

const policy: UploadPolicy = {
  maxBytes: 1024,
  files: 1,
  fields: 2,
  allowedMimeTypes: new Set(['image/png', 'text/csv']),
  allowedExtensions: new Set(['.png', '.csv']),
  code: 'TEST_UNSUPPORTED',
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from('%PDF-1.7\n');

const filter = (mimetype: string, originalname: string) =>
  new Promise<boolean>((resolve, reject) => uploadFileFilter(policy)(undefined, { mimetype, originalname } as Express.Multer.File, (error, accept) => (error ? reject(error) : resolve(accept))));

describe('upload options (roadmap 5.1)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-spec-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the filter refuses a declared type or extension outside the policy before any byte is stored', async () => {
    await expect(filter('image/png', 'a.png')).resolves.toBe(true);
    await expect(filter('IMAGE/PNG', 'A.PNG')).resolves.toBe(true);
    await expect(filter('application/pdf', 'a.pdf')).rejects.toMatchObject({ response: { code: 'TEST_UNSUPPORTED' } });
    await expect(filter('image/png', 'a.exe')).rejects.toMatchObject({ response: { code: 'TEST_UNSUPPORTED' } });
    await expect(filter('image/png', 'noext')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('limits every part of the request and stores to the temp directory under a random name', async () => {
    const options = buildUploadOptions(policy, path.join(dir, 'tmp'));
    expect(options.limits).toMatchObject({ fileSize: 1024, files: 1, fields: 2, parts: 3 });
    expect(fs.existsSync(path.join(dir, 'tmp'))).toBe(true);
    const storage = options.storage as unknown as { getFilename: (req: unknown, file: Express.Multer.File, cb: (e: Error | null, name: string) => void) => void };
    const name = await new Promise<string>((resolve) => storage.getFilename({}, { originalname: '../../etc/passwd.PNG' } as Express.Multer.File, (_e, n) => resolve(n)));
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(buildUploadOptions(policy).storage).toBeUndefined(); // memory storage when no temp dir is given
  });

  it('reads the header of a disk or memory upload', async () => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(10_000, 1)]));
    expect((await readUploadHeader({ path: file })).length).toBe(4100);
    expect((await readUploadHeader({ buffer: PNG })).equals(PNG)).toBe(true);
    expect((await readUploadHeader({})).length).toBe(0);
  });

  it('assertUploadContent keeps a file whose bytes match and discards one whose bytes lie', async () => {
    const good = path.join(dir, 'good.png');
    fs.writeFileSync(good, PNG);
    await expect(assertUploadContent({ path: good, mimetype: 'image/png' } as Express.Multer.File, new Set(['image/png']), 'X')).resolves.toBe('image/png');
    expect(fs.existsSync(good)).toBe(true);

    const renamed = path.join(dir, 'renamed.png');
    fs.writeFileSync(renamed, PDF);
    await expect(assertUploadContent({ path: renamed, mimetype: 'image/png' } as Express.Multer.File, new Set(['image/png', 'application/pdf']), 'X')).rejects.toMatchObject({ response: { code: 'X' } });
    expect(fs.existsSync(renamed)).toBe(false);

    const notAccepted = path.join(dir, 'doc.pdf');
    fs.writeFileSync(notAccepted, PDF);
    await expect(assertUploadContent({ path: notAccepted, mimetype: 'application/pdf' } as Express.Multer.File, new Set(['image/png']), 'X')).rejects.toBeInstanceOf(BadRequestException);
    expect(fs.existsSync(notAccepted)).toBe(false);
  });

  it('discardUpload never throws', async () => {
    await expect(discardUpload({ path: path.join(dir, 'missing') })).resolves.toBeUndefined();
    await expect(discardUpload(undefined)).resolves.toBeUndefined();
  });
});
