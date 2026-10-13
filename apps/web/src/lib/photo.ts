/**
 * Phone photos of bills (roadmap 9.19). A phone camera takes 12 to 200 MP
 * pictures, 4 to 30 MB as JPEG; the API refuses more than 10 MiB (the OCR and
 * document storage limits), and a weak mobile uplink at about 50 KB/s needs
 * minutes for an original. A bill stays legible far below that size, so a
 * photo larger than its purpose needs is re-encoded as JPEG with its long
 * edge at the purpose's limit before it is uploaded.
 */

/** The OCR model reads an image at about this size; more pixels only cost upload time. */
export const OCR_PHOTO_MAX_EDGE = 2048;
/** A bill kept as a document (Smart Capture): small print stays readable, about 1 to 3 MB. */
export const DOCUMENT_PHOTO_MAX_EDGE = 3072;

const JPEG_QUALITY = 0.85;

/** `width` x `height` scaled down so the long edge is at most `maxEdge` (never enlarged). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/** Decodes with the EXIF orientation applied (the browsers' default for both paths). */
async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Too large for a bitmap on this device, or a format only <img> decodes: try the element.
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

/**
 * The photo to upload: a JPEG whose long edge is `maxEdge` when the original
 * is larger, else the original file untouched. A photo the browser cannot
 * decode is returned as it is, for the API to accept or refuse with its reason.
 */
export async function photoForUpload(file: Blob, maxEdge: number): Promise<Blob> {
  let decoded: DecodedImage;
  try {
    decoded = await decodeImage(file);
  } catch {
    return file;
  }
  try {
    const target = fitWithin(decoded.width, decoded.height, maxEdge);
    if (target.width === decoded.width && target.height === decoded.height) return file;
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, target.width, target.height);
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return jpeg ?? file;
  } finally {
    decoded.release();
  }
}
