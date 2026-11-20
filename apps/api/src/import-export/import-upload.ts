import { BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { looksLikeText } from '../common/upload/file-signature';
import { discardUpload, readUploadHeader, UploadPolicy } from '../common/upload/upload-options';

/**
 * Upload rules of `POST /imports/products/upload` (roadmap 5.1): CSV or JSON
 * only, by declared type and extension at the filter and by content after
 * the upload. Browsers label CSV files inconsistently, so the declared-type
 * list carries the common spellings; the extension decides the parser.
 */
export const IMPORT_MIME_TYPES: ReadonlySet<string> = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain', 'application/json', 'application/octet-stream']);
export const IMPORT_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.json']);
export const IMPORT_UPLOAD_CODE = 'IMPORT_UNSUPPORTED_FILE';

export function importUploadPolicy(maxBytes: number): UploadPolicy {
  return { maxBytes, files: 1, fields: 4, allowedMimeTypes: IMPORT_MIME_TYPES, allowedExtensions: IMPORT_EXTENSIONS, code: IMPORT_UPLOAD_CODE };
}

export function importFormatOf(originalName: string): 'CSV' | 'JSON' {
  return path.extname(originalName || '').toLowerCase() === '.csv' ? 'CSV' : 'JSON';
}

/** The stored bytes must be text (a binary renamed `.csv` is refused); a JSON import must open with `[` or `{`. */
export async function assertImportFileContent(file: Express.Multer.File): Promise<void> {
  const header = await readUploadHeader(file);
  const decoded = looksLikeText(header) ? header.toString('utf8') : null;
  // A UTF-8 byte-order mark is common in CSV exports; it is not content.
  const text = decoded === null ? null : (decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded).trimStart();
  const valid = text !== null && (importFormatOf(file.originalname) === 'CSV' || text.startsWith('[') || text.startsWith('{'));
  if (!valid) {
    await discardUpload(file);
    throw new BadRequestException({ message: `The file content is not a readable ${importFormatOf(file.originalname)} document.`, code: IMPORT_UPLOAD_CODE });
  }
}
