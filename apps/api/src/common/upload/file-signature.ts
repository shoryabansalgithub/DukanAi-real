/**
 * Content sniffing for uploads (roadmap 5.1). A client's `Content-Type` and
 * file name are claims; the bytes are the fact. Every accepted type either has
 * a magic number or is plain text, which is verified as such (UTF-8, no NUL).
 * The header the checks need is at most SNIFF_BYTES long, so a service can
 * read it from a disk-stored upload without loading the file.
 */

/** Bytes a caller must supply for every check below to be decisive. */
export const SNIFF_BYTES = 4100;

export type SniffedType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/gif'
  | 'image/avif'
  | 'video/mp4'
  | 'video/quicktime'
  | 'video/webm'
  | 'video/x-matroska'
  | 'application/pdf'
  | 'application/zip'
  | 'application/x-ole-storage'
  | 'model/gltf-binary'
  | 'text/plain';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString('latin1');
}

/** ISO base media brand (`....ftypXXXX`): mp4-family and QuickTime share the container. */
function isoBrand(buffer: Buffer): string | null {
  if (buffer.length < 12 || ascii(buffer, 4, 8) !== 'ftyp') return null;
  return ascii(buffer, 8, 12);
}

/** EBML DocType (`webm` or `matroska`) sits within the first bytes after the EBML header. */
function ebmlDocType(buffer: Buffer): 'video/webm' | 'video/x-matroska' | null {
  const head = ascii(buffer, 0, Math.min(buffer.length, 64));
  if (head.includes('webm')) return 'video/webm';
  if (head.includes('matroska')) return 'video/x-matroska';
  return null;
}

/**
 * Text that a CSV / JSON / plain-text importer can process: valid UTF-8 with no
 * NUL byte and no C0 control characters other than tab, newline and carriage return.
 * The trailing bytes of a truncated multi-byte sequence are tolerated.
 */
export function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
  }
  const decoded = buffer.toString('utf8');
  // A truncated sequence at the cut decodes to U+FFFD at the very end only; anywhere else it is not UTF-8.
  const replacementAt = decoded.indexOf('�');
  return replacementAt === -1 || replacementAt >= decoded.length - 1;
}

/** The type the bytes prove, or null when nothing accepted matches. */
export function sniffMimeType(buffer: Buffer): SniffedType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG)) return 'image/png';
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && (ascii(buffer, 0, 6) === 'GIF87a' || ascii(buffer, 0, 6) === 'GIF89a')) return 'image/gif';
  if (buffer.length >= 5 && ascii(buffer, 0, 5) === '%PDF-') return 'application/pdf';
  if (buffer.length >= 4 && ascii(buffer, 0, 4) === 'PK\u0003\u0004') return 'application/zip';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE)) return 'application/x-ole-storage';
  if (buffer.length >= 4 && ascii(buffer, 0, 4) === 'glTF') return 'model/gltf-binary';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(EBML)) return ebmlDocType(buffer);
  const brand = isoBrand(buffer);
  if (brand) {
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (looksLikeText(buffer)) return 'text/plain';
  return null;
}

/**
 * Declared MIME types that each sniffed type may stand behind. A declared type
 * outside this table, or a sniffed type that does not list it, is a mismatch.
 */
const DECLARED_FOR_SNIFFED: Record<SniffedType, ReadonlySet<string>> = {
  'image/jpeg': new Set(['image/jpeg', 'image/pjpeg']),
  'image/png': new Set(['image/png']),
  'image/webp': new Set(['image/webp']),
  'image/gif': new Set(['image/gif']),
  'image/avif': new Set(['image/avif']),
  'video/mp4': new Set(['video/mp4']),
  'video/quicktime': new Set(['video/quicktime']),
  'video/webm': new Set(['video/webm']),
  'video/x-matroska': new Set(['video/x-matroska']),
  'application/pdf': new Set(['application/pdf']),
  'application/zip': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip']),
  'application/x-ole-storage': new Set(['application/msword']),
  'model/gltf-binary': new Set(['model/gltf-binary']),
  'text/plain': new Set(['text/plain', 'text/csv', 'application/csv', 'application/vnd.ms-excel', 'application/json', 'model/obj']),
};

/** True when the sniffed content may legitimately be served under the declared type. */
export function contentMatchesDeclaredType(sniffed: SniffedType | null, declaredMimeType: string): boolean {
  if (!sniffed) return false;
  return DECLARED_FOR_SNIFFED[sniffed].has(declaredMimeType.toLowerCase());
}
