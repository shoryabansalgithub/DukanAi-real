import { DOCUMENT_PHOTO_MAX_EDGE, fitWithin } from '@/lib/photo';

/**
 * Hand-off between Smart Capture and the AI Scanner: a captured JPEG data URL
 * is parked in sessionStorage under this key and consumed once by the scanner.
 */
export const PENDING_SCAN_KEY = 'smart-capture:pending-scan';

export const JPEG_QUALITY = 0.9;

/**
 * A JPEG data URL from a picked photo, its long edge at most
 * DOCUMENT_PHOTO_MAX_EDGE: a 50 MP gallery photo was 29 MB here, past the
 * 10 MiB storage limit (roadmap 9.19). The storage route accepts JPEG and PNG only.
 */
export async function blobToJpegDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = fitWithin(bitmap.width, bitmap.height, DOCUMENT_PHOTO_MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

export function newBillId(): string {
  // Hyphen last in the character class: Tailwind scans this file and reads a leading-hyphen bracket as an arbitrary property.
  const stamp = new Date().toISOString().replace(/[:.TZ-]/g, '').slice(0, 14);
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${stamp}-${suffix}`;
}
