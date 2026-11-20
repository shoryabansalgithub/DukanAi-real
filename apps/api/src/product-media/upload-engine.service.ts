import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import { UploadConfig } from '../config/domains/upload.config';
import { assertUploadContent, discardUpload, resolveTempDir, UploadPolicy } from '../common/upload/upload-options';

/** A multer file as the media service sees it: on disk (`path`) after the interceptor, or in memory (`buffer`) in unit tests. */
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  path?: string;
}

/**
 * Media types a product or variant may carry (roadmap 5.1). Each declared
 * type has a byte signature the upload is checked against; SVG is not
 * accepted because it is a script container, not an image.
 */
export const MEDIA_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'text/plain',
  'model/gltf-binary',
  'model/obj',
]);

export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif',
  '.mp4', '.m4v', '.mov', '.mkv', '.webm',
  '.pdf', '.doc', '.docx', '.csv', '.txt',
  '.glb', '.obj',
]);

/** Sniffed content types the media store accepts (what the bytes must be). */
const MEDIA_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
  'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm',
  'application/pdf', 'application/x-ole-storage', 'application/zip', 'model/gltf-binary', 'text/plain',
]);

export const MEDIA_UPLOAD_CODE = 'MEDIA_UNSUPPORTED_FILE';

export function mediaUploadPolicy(maxBytes: number): UploadPolicy {
  return { maxBytes, files: 1, fields: 4, allowedMimeTypes: MEDIA_MIME_TYPES, allowedExtensions: MEDIA_EXTENSIONS, code: MEDIA_UPLOAD_CODE };
}

@Injectable()
export class UploadEngineService {
  constructor(private readonly uploadConfig: UploadConfig) {}

  /**
   * Size, declared type and content check. The interceptor already enforced
   * the size cap and the declared-type allow-list; this re-checks them for
   * callers that bypass the interceptor and then verifies the magic bytes,
   * discarding the stored file when they do not match the declared type.
   */
  async validateFile(file: UploadedFile | undefined): Promise<void> {
    if (!file) throw new BadRequestException({ message: 'No file provided', code: MEDIA_UPLOAD_CODE });
    if (file.size > this.uploadConfig.maxMediaBytes) {
      await discardUpload(file);
      throw new BadRequestException({ message: `File exceeds the ${Math.floor(this.uploadConfig.maxMediaBytes / 1024 / 1024)} MB media limit`, code: 'MEDIA_TOO_LARGE' });
    }
    if (!MEDIA_MIME_TYPES.has((file.mimetype || '').toLowerCase())) {
      await discardUpload(file);
      throw new BadRequestException({ message: `Unsupported media type: ${file.mimetype}`, code: MEDIA_UPLOAD_CODE });
    }
    await assertUploadContent(file, MEDIA_CONTENT_TYPES, MEDIA_UPLOAD_CODE);
  }

  /**
   * The path the deduplication hash and the CDN move read from. A disk-stored
   * upload is already in the temp directory; a memory upload is written there.
   */
  async storeLocalTemporarily(file: UploadedFile): Promise<string> {
    if (file.path) return file.path;
    const tempDir = resolveTempDir(this.uploadConfig.tempDir);
    const tempFilePath = path.join(tempDir, `${randomBytes(16).toString('hex')}${path.extname(file.originalname || '').toLowerCase()}`);
    await fs.promises.writeFile(tempFilePath, file.buffer ?? Buffer.alloc(0));
    return tempFilePath;
  }
}
