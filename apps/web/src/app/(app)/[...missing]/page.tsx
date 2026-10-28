import { notFound } from 'next/navigation';

/**
 * Every path no page claims lands here, so its 404 renders through
 * `(app)/not-found.tsx` inside the app shell. Without it Next.js would answer
 * from the bare root layout, with no sidebar or navbar. A logged-out visitor
 * never reaches this for an app path: the proxy sends them to /login.
 */
export default function MissingPage(): never {
  notFound();
}
