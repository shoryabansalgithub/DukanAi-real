/**
 * Wraps one JPEG in a single-page PDF without any library (roadmap 6.1: the
 * Smart Capture "Convert to PDF" option used to be a fake). A PDF can embed
 * JPEG bytes verbatim as an image XObject with the DCTDecode filter, so the
 * document is: catalog, pages, one page sized to the image (72 dpi, capped to
 * an A4 box), the image, and a content stream that draws it. Offsets in the
 * cross-reference table are byte offsets, so the header and every object are
 * emitted as Latin-1 bytes.
 */
const A4 = { width: 595.28, height: 841.89 };

function latin1(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Reads the pixel size and channel count from the JPEG's SOF marker. */
export function readJpegDimensions(bytes: Uint8Array): { width: number; height: number; components: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG file');
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9] };
    }
    if (marker === 0xda) break; // start of scan: no SOF seen
    i += 2 + length;
  }
  throw new Error('JPEG dimensions not found');
}

/** A PDF (as bytes) with the JPEG on one page, scaled to fit an A4 box at 72 dpi and never enlarged. */
export function jpegToPdf(jpeg: Uint8Array): Uint8Array<ArrayBuffer> {
  const { width, height, components } = readJpegDimensions(jpeg);
  if (width <= 0 || height <= 0) throw new Error('JPEG has no size');
  const scale = Math.min(1, A4.width / width, A4.height / height);
  const pageWidth = +(width * scale).toFixed(2);
  const pageHeight = +(height * scale).toFixed(2);
  const colorSpace = components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
  const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;

  const objects: Uint8Array[] = [
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    latin1(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    concat([
      latin1(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      latin1('\nendstream'),
    ]),
    latin1(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
  ];

  const parts: Uint8Array[] = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  const offsets: number[] = [];
  let position = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = concat([latin1(`${index + 1} 0 obj\n`), body, latin1('\nendobj\n')]);
    parts.push(chunk);
    position += chunk.length;
  });
  const xref = position;
  const table = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(latin1(`${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return concat(parts);
}
