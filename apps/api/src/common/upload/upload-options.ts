import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { diskStorage } from 'multer';
import { contentMatchesDeclaredType, SNIFF_BYTES, sniffMimeType } from './file-signature';

/**
 * One way to accept a multipart upload (roadmap 5.1, audit P1-9):
 *
 *   1. `buildUploadOptions` gives multer hard `limits` (file size, file count,
 *      part and field counts) so a request can never buffer more than the
 *      configured cap, a `fileFilter` that refuses a declared type or
 *      extension outside the allow-list before a byte is stored, and disk
 *      storage into the configured temp directory so a large file streams to
 *      disk instead of process memory.
 *   2. The handler then calls `assertUploadContent`, which sniffs the magic
 *      bytes and refuses a file whose bytes do not match its declared type
 *      (a PDF renamed `.png`, an executable named `.csv`).
 *   3. Whatever rejects a stored file calls `discardUpload`, and the
 *      `UploadCleanupInterceptor` (listed before the FileInterceptor) unlinks
 *      whatever is still on disk when the request ends by any other path
 *      (body-validation 400, ownership 404): a temp file never outlives its
 *      request.
 *
 * A file over `fileSize` surfaces as multer `LIMIT_FILE_SIZE`, which Nest
 * turns into 413; the remaining request bytes are drained, not buffered.
 */
export interface UploadPolicy {
  /** Maximum bytes of one file. */
  maxBytes: number;
  /** Files per request. */
  files?: number;
  /** Non-file fields per request. */
  fields?: number;
  /** Declared MIME types accepted by the filter (lower case). */
  allowedMimeTypes: ReadonlySet<string>;
  /** File extensions accepted by the filter (lower case, with the dot); an empty name is refused. */
  allowedExtensions: ReadonlySet<string>;
  /** Error code reported for a refused declared type. */
  code: string;
}

type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

export function uploadFileFilter(policy: UploadPolicy) {
  return (_request: unknown, file: Express.Multer.File, callback: FileFilterCallback): void => {
    const mimeType = (file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!policy.allowedMimeTypes.has(mimeType)) {
      callback(new BadRequestException({ message: `Unsupported file type ${file.mimetype || '(none)'}.`, code: policy.code }), false);
      return;
    }
    if (!policy.allowedExtensions.has(ext)) {
      callback(new BadRequestException({ message: `Unsupported file extension ${ext || '(none)'}.`, code: policy.code }), false);
      return;
    }
    callback(null, true);
  };
}

/** Resolves the configured temp directory against the working directory and creates it once. */
export function resolveTempDir(tempDir: string): string {
  const resolved = path.resolve(process.cwd(), tempDir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Multer options for a `FileInterceptor` / `AnyFilesInterceptor`; disk storage when `tempDir` is given. */
export function buildUploadOptions(policy: UploadPolicy, tempDir?: string): MulterOptions {
  const files = policy.files ?? 1;
  const fields = policy.fields ?? 8;
  return {
    fileFilter: uploadFileFilter(policy),
    limits: {
      fileSize: policy.maxBytes,
      files,
      fields,
      parts: files + fields,
      fieldSize: 16 * 1024,
      headerPairs: 200,
    },
    ...(tempDir
      ? {
          storage: diskStorage({
            destination: resolveTempDir(tempDir),
            // The client's name never reaches the file system: a random name plus the vetted extension.
            filename: (_req, file, cb) => cb(null, `${randomBytes(16).toString('hex')}${path.extname(file.originalname || '').toLowerCase()}`),
          }),
        }
      : {}),
  };
}

/** Removes a disk-stored upload; a memory upload has nothing to remove. Never throws. */
export async function discardUpload(file: { path?: string } | undefined): Promise<void> {
  if (!file?.path) return;
  await fs.promises.unlink(file.path).catch(() => undefined);
}

/** The first SNIFF_BYTES of a memory or disk upload. */
export async function readUploadHeader(file: { buffer?: Buffer; path?: string }): Promise<Buffer> {
  if (file.buffer) return file.buffer.subarray(0, SNIFF_BYTES);
  if (!file.path) return Buffer.alloc(0);
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const chunk = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, SNIFF_BYTES, 0);
    return chunk.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Verifies the stored bytes against the declared type and discards the file
 * when they disagree or when the sniffed type is not in `accepted`. Returns the
 * sniffed type so the caller stores what the bytes are, not what was claimed.
 */
export async function assertUploadContent(
  file: { buffer?: Buffer; path?: string; mimetype: string },
  accepted: ReadonlySet<string>,
  code: string,
): Promise<string> {
  const sniffed = sniffMimeType(await readUploadHeader(file));
  if (!sniffed || !accepted.has(sniffed) || !contentMatchesDeclaredType(sniffed, file.mimetype)) {
    await discardUpload(file);
    throw new BadRequestException({
      message: `The file content does not match its declared type ${file.mimetype}${sniffed ? ` (detected ${sniffed})` : ''}.`,
      code,
    });
  }
  return sniffed;
}
