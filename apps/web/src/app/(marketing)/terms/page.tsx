import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalDocument } from '@/components/marketing/LegalDocument';
import { siteIndexable } from '@/config/site';
import { LEGAL_UPDATED, legalDetails, termsMarkdown } from '@/marketing/legal';

const TITLE = 'Terms for shops';
const LEDE = 'The terms on which a shop uses DukaanAI.';

export function generateMetadata(): Metadata {
  return {
    title: { absolute: `${TITLE} | DukaanAI` },
    description: LEDE,
    alternates: { canonical: '/terms' },
    robots: siteIndexable() ? { index: true, follow: true } : { index: false, follow: false },
  };
}

/** Published once the deployment names its operator and contact (`LEGAL_*`). */
export default function TermsPage() {
  const details = legalDetails();
  if (!details) notFound();
  return (
    <LegalDocument
      title={TITLE}
      lede={LEDE}
      updated={LEGAL_UPDATED}
      body={termsMarkdown(details)}
    />
  );
}
