import { contentMatchesDeclaredType, looksLikeText, SNIFF_BYTES, sniffMimeType } from './file-signature';

const bytes = (...values: number[]) => Buffer.from(values);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const WEBP = Buffer.concat([Buffer.from('RIFF'), bytes(0x24, 0, 0, 0), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a\u0001\u0000');
const PDF = Buffer.from('%PDF-1.7\n%âã');
const ZIP = Buffer.concat([Buffer.from('PK\u0003\u0004'), bytes(0x14, 0, 0, 0)]);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0);
const GLB = Buffer.concat([Buffer.from('glTF'), bytes(2, 0, 0, 0)]);
const MP4 = Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypmp42'), bytes(0, 0, 0, 0)]);
const MOV = Buffer.concat([bytes(0, 0, 0, 0x14), Buffer.from('ftypqt  '), bytes(0, 0, 0, 0)]);
const AVIF = Buffer.concat([bytes(0, 0, 0, 0x1c), Buffer.from('ftypavif'), bytes(0, 0, 0, 0)]);
const WEBM = Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), bytes(0x9f, 0x42, 0x86, 0x81, 0x01), Buffer.from('B\u0082\u0084webm')]);
const MKV = Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), bytes(0x9f, 0x42, 0x86, 0x81, 0x01), Buffer.from('B\u0082\u0088matroska')]);
const EXE = Buffer.concat([Buffer.from('MZ'), bytes(0x90, 0, 3, 0, 0, 0)]);

describe('file signatures (roadmap 5.1)', () => {
  it('recognises every accepted binary type by its magic bytes', () => {
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(WEBP)).toBe('image/webp');
    expect(sniffMimeType(GIF)).toBe('image/gif');
    expect(sniffMimeType(PDF)).toBe('application/pdf');
    expect(sniffMimeType(ZIP)).toBe('application/zip');
    expect(sniffMimeType(OLE)).toBe('application/x-ole-storage');
    expect(sniffMimeType(GLB)).toBe('model/gltf-binary');
    expect(sniffMimeType(MP4)).toBe('video/mp4');
    expect(sniffMimeType(MOV)).toBe('video/quicktime');
    expect(sniffMimeType(AVIF)).toBe('image/avif');
    expect(sniffMimeType(WEBM)).toBe('video/webm');
    expect(sniffMimeType(MKV)).toBe('video/x-matroska');
  });

  it('treats readable UTF-8 as text and anything else as unknown', () => {
    expect(sniffMimeType(Buffer.from('sku,name,price\nA1,Tea,100\n'))).toBe('text/plain');
    expect(sniffMimeType(Buffer.from('[{"sku":"A1"}]'))).toBe('text/plain');
    expect(sniffMimeType(Buffer.from('नाम,मूल्य\nचाय,100\n'))).toBe('text/plain');
    expect(sniffMimeType(Buffer.alloc(0))).toBe('text/plain');
    expect(sniffMimeType(EXE)).toBeNull();
    expect(sniffMimeType(bytes(0x00, 0x01, 0x02))).toBeNull();
    expect(sniffMimeType(bytes(0xc3, 0x28, 0x41))).toBeNull(); // invalid UTF-8 in the middle
  });

  it('a multi-byte character cut at the sniff boundary still counts as text', () => {
    const text = Buffer.from('क'.repeat(2000)); // 3 bytes each: 6000 bytes
    expect(looksLikeText(text.subarray(0, SNIFF_BYTES))).toBe(true);
  });

  it('matches declared types only to content that can stand behind them', () => {
    expect(contentMatchesDeclaredType('image/png', 'image/png')).toBe(true);
    expect(contentMatchesDeclaredType('application/pdf', 'image/png')).toBe(false); // a PDF renamed .png
    expect(contentMatchesDeclaredType('text/plain', 'text/csv')).toBe(true);
    expect(contentMatchesDeclaredType('text/plain', 'application/json')).toBe(true);
    expect(contentMatchesDeclaredType('text/plain', 'image/jpeg')).toBe(false); // a text file claiming to be an image
    expect(contentMatchesDeclaredType('application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(contentMatchesDeclaredType('application/x-ole-storage', 'application/msword')).toBe(true);
    expect(contentMatchesDeclaredType(null, 'image/png')).toBe(false);
  });
});
