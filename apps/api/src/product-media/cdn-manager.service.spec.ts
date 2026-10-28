import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CdnManagerService, mediaFileUrl } from './cdn-manager.service';

/** Audit P3: media moves survive a temp directory on another volume, and responses carry no server path. */
describe('CdnManagerService', () => {
  const cwd = process.cwd();
  let dir: string;
  let service: CdnManagerService;

  beforeEach(() => {
    // realpath: on macOS the temp dir is a /var symlink to /private/var, and the service resolves real paths.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-spec-')));
    process.chdir(dir);
    service = new CdnManagerService();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('moves the upload into the content-addressed store', async () => {
    const temp = path.join(dir, 'upload.tmp');
    fs.writeFileSync(temp, 'photo');
    const final = await service.persistLocal(temp, 'abcdef', 'jpg');
    expect(final).toBe(path.join(dir, 'uploads', 'media', 'ab', 'abcdef.jpg'));
    expect(fs.readFileSync(final, 'utf8')).toBe('photo');
    expect(fs.existsSync(temp)).toBe(false);
  });

  it('copies and removes the temp file when the temp directory is on another file system (EXDEV)', async () => {
    const temp = path.join(dir, 'upload.tmp');
    fs.writeFileSync(temp, 'photo');
    const realRename = fs.promises.rename.bind(fs.promises);
    jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === temp) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      return realRename(from, to);
    });
    const final = await service.persistLocal(temp, '12ffee', 'png');
    expect(fs.readFileSync(final, 'utf8')).toBe('photo');
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readdirSync(path.dirname(final)).filter((n) => n.endsWith('.partial'))).toEqual([]);
  });

  it('answers a store-relative path and the authenticated file route, never the absolute path', () => {
    const stored = path.join(dir, 'uploads', 'media', 'ab', 'abcdef.jpg');
    expect(service.publicPath(stored)).toBe('media/ab/abcdef.jpg');
    expect(service.publicPath('/etc/passwd')).toBe('passwd');
    expect(service.containedPath(stored)).toBe(stored);
    expect(service.containedPath('/etc/passwd')).toBeNull();
    expect(mediaFileUrl('asset1', '300px')).toBe('/api/media/assets/asset1/file?size=300px');
  });
});
