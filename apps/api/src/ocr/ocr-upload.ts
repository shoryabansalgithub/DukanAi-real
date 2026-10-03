import { BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { sniffMimeType } from '../common/upload/file-signature';

/**
 * Upload rules of the OCR route (roadmap 4.4). The image is held in memory
 * and re-encoded as base64 for the model, so the size cap is the memory
 * budget of one request. Only raster images are accepted, and the type sent
 * to the model is read from the bytes, never from the client's headers.
 */
export const OCR_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const OCR_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp']);

type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

/** Multer file filter: the declared type and extension must be an accepted image. The bytes are checked after the upload. */
export function ocrImageFileFilter(_request: unknown, file: Express.Multer.File, callback: FileFilterCallback): void {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!OCR_IMAGE_MIME_TYPES.has(file.mimetype)) {
    callback(new BadRequestException({ message: `Unsupported file type ${file.mimetype}; upload a JPEG, PNG or WebP image.`, code: 'OCR_UNSUPPORTED_IMAGE' }), false);
    return;
  }
  if (ext && !OCR_IMAGE_EXTENSIONS.has(ext)) {
    callback(new BadRequestException({ message: `Unsupported file extension ${ext}; upload a JPEG, PNG or WebP image.`, code: 'OCR_UNSUPPORTED_IMAGE' }), false);
    return;
  }
  callback(null, true);
}

/**
 * Reads the image type from the magic bytes (JPEG `FF D8 FF`, PNG
 * `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF....WEBP`). Returns null for anything
 * else, including a renamed PDF or text file.
 */
export function sniffImageMimeType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const sniffed = sniffMimeType(buffer);
  return sniffed === 'image/jpeg' || sniffed === 'image/png' || sniffed === 'image/webp' ? sniffed : null;
}
