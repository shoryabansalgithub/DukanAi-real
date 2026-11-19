import { notFound } from 'next/navigation';

/**
 * Every path no page claims lands here, so its 404 renders through
 * `(app)/not-found.tsx` inside the app shell. Without it Next.js would answer
 * from the bare root layout, with no sidebar or navbar. A logged-out visitor
 * reaches it only on a path the proxy's matcher skips (one with a dot, such as
 * `/wp-login.php`), and sees the 404, as on main before the marketing site;
 * every other unknown path sends them to /login first, and an unknown address
 * under a marketing section is claimed by that section's own catch-all
 * (`MarketingMissingPage`), whose 404 is the marketing one.
 */
export default function MissingPage(): never {
  notFound();
}
