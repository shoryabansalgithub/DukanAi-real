'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary (roadmap 6.5): catches an error in the root layout
 * itself, where no sidebar, provider or stylesheet can be assumed, so it
 * renders its own html/body with inline styles only.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app] Unhandled error in the root layout:', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f9fafb', color: '#1f2937' }}>
        <main role="alert" style={{ maxWidth: 480, margin: '15vh auto', padding: 32, background: '#fff', borderRadius: 16, boxShadow: '0 4px 20px rgba(15,23,42,0.06)', textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>DukaanAI could not load</h1>
          <p style={{ fontSize: 14, color: '#6b7280', margin: 0 }}>{error.message || 'An unexpected error occurred.'}</p>
          {error.digest && <p style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'monospace', marginTop: 8 }}>Reference {error.digest}</p>}
          <button
            type="button"
            onClick={reset}
            style={{ marginTop: 24, padding: '10px 20px', borderRadius: 12, border: 0, background: '#8B5CF6', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
          >
            Reload the app
          </button>
        </main>
      </body>
    </html>
  );
}
