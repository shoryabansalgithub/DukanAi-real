'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Lock } from 'lucide-react';
import { canSeeFinancials } from '@/components/customers/permissions';
import { TableSkeleton } from '@/components/customers/States';

/**
 * A page that is financial as a whole (suppliers, expenses, Reports): the API
 * answers its reads only for owners, admins and managers, so a cashier or a
 * stock clerk who opens it by address gets this note instead of a page of
 * refused requests. The page itself is not mounted, so it sends none.
 */
export function FinanceOnly({ what, children }: { what: string; children: ReactNode }) {
  const { data: session, status } = useSession();
  if (status === 'loading') return <TableSkeleton rows={4} cols={3} />;
  if (canSeeFinancials(session?.user?.role)) return <>{children}</>;
  return (
    <div data-testid="finance-only" className="mx-auto mt-12 max-w-md rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-sm">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-500">
        <Lock size={22} />
      </div>
      <h1 className="text-lg font-bold text-gray-800">Only the owner or a manager can see this page</h1>
      <p className="mt-2 text-sm text-gray-500">
        {what} are visible to the shop owner, admins and managers. Ask the owner if you need a figure from here.
      </p>
      <Link href="/dashboard" className="mt-6 inline-block rounded-lg bg-[#8B5CF6] px-4 py-2 text-sm font-semibold text-white hover:bg-[#7C3AED]">
        Back to the dashboard
      </Link>
    </div>
  );
}
