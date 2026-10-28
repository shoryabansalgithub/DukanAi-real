import { notFound } from 'next/navigation';

/**
 * Claims every unknown address under a marketing section, so its 404 is
 * `(marketing)/not-found.tsx` and not the app shell's catch-all
 * (`(app)/[...missing]`). Every section in `MARKETING_SECTIONS` mounts it.
 */
export function MarketingMissingPage(): never {
  notFound();
}
