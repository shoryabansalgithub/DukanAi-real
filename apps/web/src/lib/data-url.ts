/**
 * Decodes a `data:` URL into a Blob without going through `fetch`: the CSP's
 * `connect-src` (roadmap 6.4) allows only the app and API origins, and a
 * `fetch('data:…')` counts as a connection and is refused. Only base64 and
 * percent-encoded payloads exist in this app (canvas exports are base64).
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Not a data URL');
  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = match[2].split(';').includes('base64');
  const payload = match[3];
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(payload)], { type: mimeType });
}
