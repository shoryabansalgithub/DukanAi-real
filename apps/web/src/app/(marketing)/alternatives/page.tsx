import { ArticlePage } from '@/components/marketing/ArticlePage';
import { alternativesPage } from '@/marketing/content/alternatives';
import { pageMetadata } from '@/marketing/metadata';
import { breadcrumbs, faqPage, graph, organization, softwareApplication, webPage } from '@/marketing/structured-data';

export function generateMetadata() {
  return pageMetadata(alternativesPage);
}

export default function AlternativesPage() {
  const page = alternativesPage;
  return (
    <ArticlePage
      page={page}
      schema={graph(webPage(page), breadcrumbs(page), faqPage(page.faqs ?? [], page.path), softwareApplication(), organization())}
    />
  );
}
