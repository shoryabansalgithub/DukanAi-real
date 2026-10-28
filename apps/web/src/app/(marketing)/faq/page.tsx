import { ArticlePage } from '@/components/marketing/ArticlePage';
import { faqPage as faqContent } from '@/marketing/content/faq';
import { pageMetadata } from '@/marketing/metadata';
import { breadcrumbs, faqPage, graph, organization, webPage } from '@/marketing/structured-data';

export const metadata = pageMetadata(faqContent);

export default function FaqPage() {
  const page = faqContent;
  return <ArticlePage page={page} schema={graph(webPage(page), breadcrumbs(page), faqPage(page.faqs ?? [], page.path), organization())} />;
}
