import { BadRequestException } from '@nestjs/common';
import * as path from 'path';
import {
  ALLOWED_FILE_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  EXECUTABLE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  JSON_MIME_TYPES,
  MAX_BILLING_DOCUMENT_BYTES,
  MAX_CLOUD_UPLOAD_BYTES,
  PDF_MIME_TYPES,
  TEXT_MIME_TYPES,
} from './storage-security.constants';
import { sanitizeStorageFileName } from './storage-path.util';
import { contentMatchesDeclaredType, sniffMimeType } from '../common/upload/file-signature';

type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

export interface UploadPolicy {
  maxBytes: number;
  allowedMimeTypes: ReadonlySet<string>;
  allowedExtensions: ReadonlySet<string>;
}

export const billingDocumentUploadPolicy: UploadPolicy = {
  maxBytes: MAX_BILLING_DOCUMENT_BYTES,
  allowedMimeTypes: ALLOWED_MIME_TYPES,
  allowedExtensions: ALLOWED_FILE_EXTENSIONS,
};

export const cloudUploadPolicy: UploadPolicy = {
  maxBytes: MAX_CLOUD_UPLOAD_BYTES,
  allowedMimeTypes: ALLOWED_MIME_TYPES,
  allowedExtensions: ALLOWED_FILE_EXTENSIONS,
};

export function secureFileFilter(
  _request: unknown,
  file: Express.Multer.File,
  callback: FileFilterCallback,
): void {
  try {
    validateUploadedFile(file, billingDocumentUploadPolicy);
    callback(null, true);
  } catch (error) {
    callback(error instanceof Error ? error : new BadRequestException(), false);
  }
}

export function validateUploadedFile(
  file: Express.Multer.File | undefined,
  policy: UploadPolicy,
): Express.Multer.File {
  if (!file) {
    throw new BadRequestException('Required file is missing');
  }

  const sanitizedName = sanitizeStorageFileName(file.originalname);
  const ext = path.extname(sanitizedName).toLowerCase();

  if (file.size > policy.maxBytes) {
    throw new BadRequestException('File exceeds maximum allowed size');
  }

  if (EXECUTABLE_EXTENSIONS.has(ext)) {
    throw new BadRequestException('Executable uploads are blocked');
  }

  if (!policy.allowedExtensions.has(ext)) {
    throw new BadRequestException(`File extension ${ext} is not allowed`);
  }

  if (!policy.allowedMimeTypes.has(file.mimetype)) {
    throw new BadRequestException(`MIME type ${file.mimetype} is not allowed`);
  }

  // After the upload (the filter runs before any byte arrives): the content must be what the type claims.
  if (file.buffer && !contentMatchesDeclaredType(sniffMimeType(file.buffer), file.mimetype)) {
    throw new BadRequestException({ message: `File content does not match its declared type ${file.mimetype}`, code: 'STORAGE_CONTENT_MISMATCH' });
  }

  return file;
}

export function assertPdfFile(file: Express.Multer.File | undefined): Express.Multer.File {
  const validFile = validateUploadedFile(file, billingDocumentUploadPolicy);
  if (!PDF_MIME_TYPES.has(validFile.mimetype)) {
    throw new BadRequestException('PDF file is required');
  }
  return validFile;
}

export function assertImageFile(file: Express.Multer.File | undefined): Express.Multer.File {
  const validFile = validateUploadedFile(file, billingDocumentUploadPolicy);
  if (!IMAGE_MIME_TYPES.has(validFile.mimetype)) {
    throw new BadRequestException('Image file is required');
  }
  return validFile;
}

export function assertOptionalPdfFile(
  file: Express.Multer.File | undefined,
): Express.Multer.File | undefined {
  if (!file) return undefined;
  return assertPdfFile(file);
}

export function assertOptionalImageFile(
  file: Express.Multer.File | undefined,
): Express.Multer.File | undefined {
  if (!file) return undefined;
  return assertImageFile(file);
}

export function assertJsonOrTextMime(mimeType: string): void {
  if (!JSON_MIME_TYPES.has(mimeType) && !TEXT_MIME_TYPES.has(mimeType)) {
    throw new BadRequestException('Only JSON or text metadata is allowed');
  }
}
