import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { firstValueFrom, of, throwError } from 'rxjs';
import { requestUploads, UploadCleanupInterceptor } from './upload-cleanup.interceptor';

describe('UploadCleanupInterceptor (roadmap 5.1 safety net)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-cleanup-'));
  const touch = (name: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, 'x');
    return p;
  };
  const run = async (req: object, handler: () => unknown) => {
    const context = { switchToHttp: () => ({ getRequest: () => req }) };
    const observable = new UploadCleanupInterceptor().intercept(context as never, { handle: handler } as never) as never;
    return firstValueFrom(observable);
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('collects disk uploads from req.file, req.files arrays and field maps, ignoring memory uploads', () => {
    const req = {
      file: { fieldname: 'file', path: '/a' },
      files: { images: [{ fieldname: 'images', path: '/b' }, { fieldname: 'images', buffer: Buffer.alloc(1) }] },
    };
    expect(requestUploads(req as never).map((f) => f.path)).toEqual(['/a', '/b']);
    expect(requestUploads({ files: [{ fieldname: 'f', path: '/c' }] } as never).map((f) => f.path)).toEqual(['/c']);
    expect(requestUploads({} as never)).toEqual([]);
  });

  it('unlinks the temp file when the handler errors (validation 400, ownership 404, anything)', async () => {
    const p = touch('errored.png');
    await expect(run({ file: { fieldname: 'file', path: p } }, () => throwError(() => new Error('404')))).rejects.toThrow('404');
    await settle();
    expect(fs.existsSync(p)).toBe(false);
  });

  it('unlinks a file the handler left behind on success, and tolerates one it already removed', async () => {
    const left = touch('left.png');
    const gone = path.join(tmp, 'gone.png');
    await expect(run({ files: [{ fieldname: 'f', path: left }, { fieldname: 'f', path: gone }] }, () => of({ ok: true }))).resolves.toEqual({ ok: true });
    await settle();
    expect(fs.existsSync(left)).toBe(false);
  });
});
