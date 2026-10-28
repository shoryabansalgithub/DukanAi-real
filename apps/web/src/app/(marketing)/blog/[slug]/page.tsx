import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArticlePage } from '@/components/marketing/ArticlePage';
import { BLOG_POSTS } from '@/marketing/content/blog';
import { pageMetadata } from '@/marketing/metadata';
import { blogPosting, breadcrumbs, faqPage, graph, organization, webPage } from '@/marketing/structured-data';

type Props = { params: Promise<{ slug: string }> };

function findPost(slug: string) {
  return BLOG_POSTS.find((post) => post.path === `/blog/${slug}`);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = findPost((await params).slug);
  return post ? pageMetadata(post) : {};
}

export default async function BlogPostPage({ params }: Props) {
  const post = findPost((await params).slug);
  if (!post) notFound();
  const nodes = [webPage(post), blogPosting(post), breadcrumbs(post), organization()];
  if (post.faqs?.length) nodes.push(faqPage(post.faqs, post.path));
  return <ArticlePage page={post} schema={graph(...nodes)} />;
}
