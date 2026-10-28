import { headers } from 'next/headers';

/**
 * A JSON-LD block. It is data, not script, but it carries the request's CSP
 * nonce anyway so no browser reports it under `script-src`. `<` is escaped so
 * the content can never close the tag.
 */
export async function JsonLd({ data }: { data: Record<string, unknown> }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: json }} />;
}
