import { ArticlePage } from '@/components/marketing/ArticlePage';
import { GLOSSARY, glossaryPage } from '@/marketing/content/glossary';
import { pageMetadata } from '@/marketing/metadata';
import { breadcrumbs, definedTermSet, graph, organization, webPage } from '@/marketing/structured-data';

export const metadata = pageMetadata(glossaryPage);

export default function GlossaryPage() {
  const page = glossaryPage;
  return <ArticlePage page={page} schema={graph(webPage(page), breadcrumbs(page), definedTermSet(GLOSSARY, page.path), organization())} />;
}
