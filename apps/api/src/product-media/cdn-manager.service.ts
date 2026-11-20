import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';

/** The authenticated route that serves an asset's file (or a thumbnail with `?size=`); the API prefix included. */
export function mediaFileUrl(assetId: string, sizeKey?: string): string {
  return `/api/media/assets/${encodeURIComponent(assetId)}/file${sizeKey ? `?size=${encodeURIComponent(sizeKey)}` : ''}`;
}

@Injectable()
export class CdnManagerService {
  private readonly logger = new Logger(CdnManagerService.name);

  // Using a local fallback strategy in this epic for the 'uploads' folder
  private readonly uploadDir = path.join(process.cwd(), 'uploads', 'media');

  constructor() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /** The media store's root (absolute). */
  get root(): string {
    return this.uploadDir;
  }

  /**
   * Generates a permanent storage location and moves the file there. The
   * temp directory may sit on another file system (a separate volume): a
   * rename across devices fails with EXDEV, so the file is copied and the
   * temp copy removed instead (audit P3).
   */
  async persistLocal(tempFilePath: string, uniqueHash: string, extension: string): Promise<string> {
    const finalFileName = `${uniqueHash}.${extension}`;
    // Structure: uploads/media/xx/xxxx...
    const prefixDir = path.join(this.uploadDir, uniqueHash.substring(0, 2));
    await fs.promises.mkdir(prefixDir, { recursive: true });

    const finalPath = path.join(prefixDir, finalFileName);
    try {
      await fs.promises.rename(tempFilePath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      // Copied under a temporary name and renamed within the media volume, so a reader never sees half a file.
      const partial = `${finalPath}.${process.pid}.${Date.now()}.partial`;
      try {
        await fs.promises.copyFile(tempFilePath, partial);
        await fs.promises.rename(partial, finalPath);
      } catch (copyError) {
        await fs.promises.unlink(partial).catch(() => undefined);
        throw copyError;
      }
      await fs.promises.unlink(tempFilePath).catch(() => undefined);
    }
    return finalPath;
  }

  /**
   * The form of a stored media path a response may carry: relative to the
   * uploads directory (`media/ab/ab12....png`), never the server's absolute
   * path (audit P3). A path outside the media store is reported by its name only.
   */
  publicPath(storedPath: string): string {
    const absolute = path.resolve(process.cwd(), storedPath);
    const relative = path.relative(this.uploadDir, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return path.basename(storedPath);
    return ['media', ...relative.split(path.sep)].join('/');
  }

  /** The stored path as an absolute path inside the media store, or null when it points elsewhere. */
  containedPath(storedPath: string): string | null {
    const absolute = path.resolve(process.cwd(), storedPath);
    const relative = path.relative(this.uploadDir, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return absolute;
  }
}
