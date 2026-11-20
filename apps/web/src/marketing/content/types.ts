/** A question and its answer; the answer is inline Markdown (see `markdown.ts`). */
export interface Faq {
  q: string;
  a: string;
}

export type Section = 'home' | 'features' | 'blog' | 'faq' | 'alternatives' | 'glossary';

/**
 * One public page. `body` is the Markdown subset of `markdown.ts`; the HTML
 * page and its `.md` twin are both rendered from it, so they never disagree.
 */
export interface MarketingPage {
  path: string;
  section: Section;
  /** Short name for breadcrumbs, menus and related links. */
  label: string;
  /** The <title>, used as is (no site suffix added). Under about 60 characters. */
  title: string;
  /** The meta description. Under about 160 characters. */
  description: string;
  h1: string;
  eyebrow?: string;
  /** The opening paragraph: the direct answer to the page's question (inline Markdown). */
  lede: string;
  body: string;
  faqs?: Faq[];
  /** Paths of the pages linked under "Related" (internal linking). */
  related: string[];
  /** YYYY-MM-DD of the last real content change. */
  updated: string;
  /** Blog posts: YYYY-MM-DD first published. */
  published?: string;
}
