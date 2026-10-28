import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };

/** The 1200×630 social card: the shop mark, a headline and a kicker, in the site's colours. */
export function ogCard({ title, kicker }: { title: string; kicker: string }) {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 80px',
        background: 'linear-gradient(135deg, #eef2ff 0%, #ffffff 55%, #f5f3ff 100%)',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <svg width="72" height="72" viewBox="0 0 64 64">
          <rect width="64" height="64" rx="14" fill="#4f46e5" />
          <path d="M14 26h36l-3 22H17z" fill="#fff" />
          <path d="M12 18h40l4 8H8z" fill="#c7d2fe" />
          <rect x="27" y="34" width="10" height="14" rx="2" fill="#4f46e5" />
        </svg>
        <div style={{ fontSize: 40, fontWeight: 800, color: '#0f172a', letterSpacing: -1 }}>
          DukaanAI
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div
          style={{
            fontSize: 30,
            fontWeight: 600,
            color: '#4f46e5',
            textTransform: 'uppercase',
            letterSpacing: 2,
          }}
        >
          {kicker}
        </div>
        <div
          style={{
            fontSize: title.length > 60 ? 56 : 68,
            fontWeight: 800,
            color: '#0f172a',
            lineHeight: 1.1,
            letterSpacing: -2,
          }}
        >
          {title}
        </div>
      </div>
      <div style={{ fontSize: 28, color: '#475569' }}>
        GST billing · Udhar · Stock · Cash drawer · For Indian shops
      </div>
    </div>,
    OG_SIZE
  );
}
