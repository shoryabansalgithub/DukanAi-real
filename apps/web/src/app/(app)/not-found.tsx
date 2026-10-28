import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Card } from '@/components/ui/Card';

export default function AppNotFound() {
  return (
    <div className="p-8 flex justify-center">
      <Card className="p-8 max-w-lg w-full text-center" data-testid="app-not-found">
        <div className="w-12 h-12 mx-auto rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-500 mb-4">
          <SearchX size={24} />
        </div>
        <h1 className="text-lg font-bold text-gray-800">This page could not be found</h1>
        <p className="mt-2 text-sm text-gray-500">The address may be mistyped, or the page has moved.</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#8B5CF6] px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-purple-500/30 transition-colors hover:bg-[#7C3AED]"
        >
          Go to dashboard
        </Link>
      </Card>
    </div>
  );
}
