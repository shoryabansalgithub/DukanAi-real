import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArticlePage } from '@/components/marketing/ArticlePage';
import { FEATURE_PAGES } from '@/marketing/content/features';
import { pageMetadata } from '@/marketing/metadata';
import {
  breadcrumbs,
  faqPage,
  graph,
  organization,
  softwareApplication,
  webPage,
} from '@/marketing/structured-data';

type Props = { params: Promise<{ slug: string }> };

function findFeature(slug: string) {
  return FEATURE_PAGES.find((page) => page.path === `/features/${slug}`);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = findFeature((await params).slug);
  return page ? pageMetadata(page) : {};
}

export default async function FeaturePage({ params }: Props) {
  const page = findFeature((await params).slug);
  if (!page) notFound();
  const nodes = [webPage(page), breadcrumbs(page), softwareApplication(), organization()];
  if (page.faqs?.length) nodes.push(faqPage(page.faqs, page.path));
  return <ArticlePage page={page} schema={graph(...nodes)} />;
}
