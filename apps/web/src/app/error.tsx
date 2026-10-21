'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Card } from '@/components/ui/Card';

/**
 * Route error boundary (roadmap 6.5): a render or data error in a page no
 * longer blanks the whole app. The layout, sidebar and navbar stay; the page
 * area shows what happened and offers a retry, which re-renders the segment.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[page] Unhandled error:', error);
  }, [error]);

  return (
    <div className="p-8 flex justify-center">
      <Card className="p-8 max-w-lg w-full text-center" role="alert" data-testid="route-error">
        <div className="w-12 h-12 mx-auto rounded-xl bg-red-500/10 flex items-center justify-center text-red-500 mb-4">
          <AlertTriangle size={24} />
        </div>
        <h2 className="text-lg font-bold text-gray-800">This page hit an error</h2>
        <p className="mt-2 text-sm text-gray-500">{error.message || 'Something went wrong while rendering this page.'}</p>
        {error.digest && <p className="mt-1 text-xs text-gray-400 font-mono">Reference {error.digest}</p>}
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#8B5CF6] px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-purple-500/30 transition-colors hover:bg-[#7C3AED]"
        >
          <RotateCcw size={16} /> Try again
        </button>
      </Card>
    </div>
  );
}
