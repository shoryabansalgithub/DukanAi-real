import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalDocument } from '@/components/marketing/LegalDocument';
import { siteIndexable } from '@/config/site';
import { LEGAL_UPDATED, legalDetails, privacyMarkdown } from '@/marketing/legal';

const TITLE = 'Privacy notice';
const LEDE = 'What DukaanAI does with personal data: yours, and that of your shop’s customers.';

export function generateMetadata(): Metadata {
  return {
    title: { absolute: `${TITLE} | DukaanAI` },
    description: LEDE,
    alternates: { canonical: '/privacy' },
    robots: siteIndexable() ? { index: true, follow: true } : { index: false, follow: false },
  };
}

/** Published once the deployment names its operator and contact (`LEGAL_*`). */
export default function PrivacyPage() {
  const details = legalDetails();
  if (!details) notFound();
  return (
    <LegalDocument
      title={TITLE}
      lede={LEDE}
      updated={LEGAL_UPDATED}
      body={privacyMarkdown(details)}
    />
  );
}
