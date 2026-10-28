import { ImageResponse } from 'next/og';

/** A 180×180 PNG of the shop mark: the home-screen icon, and the raster logo the Organization schema names. */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#4f46e5' }}>
        <svg width="180" height="180" viewBox="0 0 64 64">
          <rect width="64" height="64" fill="#4f46e5" />
          <path d="M14 26h36l-3 22H17z" fill="#fff" />
          <path d="M12 18h40l4 8H8z" fill="#c7d2fe" />
          <rect x="27" y="34" width="10" height="14" rx="2" fill="#4f46e5" />
        </svg>
      </div>
    ),
    size,
  );
}
