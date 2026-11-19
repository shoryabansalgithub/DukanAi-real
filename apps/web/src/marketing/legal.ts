import { parseLegalDetails } from '@/config/site-rules';

/**
 * The privacy notice (`/privacy`) and the terms for shops (`/terms`).
 *
 * The text is the owner's drafts (docs/privacy/PRIVACY_NOTICE.md and
 * TERMS_FOR_SHOPS.md) with every placeholder filled: who runs the service and
 * how to reach them come from the deployment (`LEGAL_*`, rules in
 * src/config/site-rules.js), and each promise matches what the code does
 * (the retention periods are RetentionConfig's and the backup settings', the
 * export and erasure are src/privacy/shop-data.ts). Change the drafts and
 * these together, and move LEGAL_UPDATED with any change to the wording.
 * Without LEGAL_OPERATOR_NAME and LEGAL_CONTACT_EMAIL neither page is
 * published: a notice without a contact is no notice.
 */
export const LEGAL_UPDATED = '2026-11-19';

export type LegalDetails = NonNullable<ReturnType<typeof parseLegalDetails>>;

export function legalDetails(): LegalDetails | null {
  return parseLegalDetails(process.env);
}

function contactLines(d: LegalDetails): string {
  const lines = [`- **Operator:** ${d.operator}${d.address ? `, ${d.address}` : ''}`];
  if (d.grievanceOfficer) lines.push(`- **Grievance officer:** ${d.grievanceOfficer}`);
  lines.push(`- **Email:** [${d.contactEmail}](mailto:${d.contactEmail})`);
  if (d.phone) lines.push(`- **Phone:** ${d.phone}`);
  return lines.join('\n');
}

export function privacyMarkdown(d: LegalDetails): string {
  return `## Who we are

DukaanAI is a billing and stock service for shops in India, run by **${d.operator}** ("we"). Privacy questions, requests and complaints go to our grievance officer:

${contactLines(d)}

This notice covers two situations:

- **Your account.** You use DukaanAI as a shop owner or as a shop's staff. For your account data we decide why and how it is used.
- **Your shop's customers and suppliers.** Your shop keeps their details in DukaanAI. We process those details **for your shop and only on its instructions**. The shop decides why it keeps them and answers to them for it.

## Your account

### What we collect

- **Your account:** name, email address, phone number (optional), your role in the shop, a password (stored only as a one-way hash), and your Google account identifier if you sign in with Google.
- **Your sessions:** the IP address and browser of each signed-in session, and your sign-in attempts. You can see and end your sessions under **Settings › Account & Security**.
- **What you do in the app:** the records you create (bills, payments, stock changes) carry your name as their author, and our server logs record your user id and IP address with each request.

### Why

- To sign you in and keep your account secure, including blocking password guessing and ending your sessions when your password changes.
- To show who did what in your shop.
- To send the emails the service needs: invitations, password resets and notices that your password changed.
- To find faults and misuse.

We do not sell your data, show advertising, or use your data to train AI models.

### How long we keep it

| Data | Kept |
| --- | --- |
| Your account | While it exists |
| Signed-in sessions | Until 7 days after they expire |
| Searches you make in the app | 90 days |
| Server logs | At most 31 days |
| Backups | At most 30 days |

### Who else handles it

- **Vercel** hosts the website you use.
- **Microsoft Azure** runs our servers and database${d.dataLocation ? ` (${d.dataLocation})` : ''}.
- **Backblaze** stores our backups, encrypted before they leave our servers.
- **Our email provider** delivers the service's emails.
- **Google**, only if you choose Google sign-in.
- **An error-tracking service**, when we turn it on, receives your user id when something fails, never the content of your requests.

### Your rights

You can ask us for a summary of your data, ask us to correct it, or ask us to delete your account; your shop's owner can also remove you from the shop. Write to the grievance officer above. We answer within 30 days. If we do not resolve your complaint, you may complain to the Data Protection Board of India.

## Your shop's customers and suppliers

We process these details as the shop's processor:

- We store the shop's customer and supplier details only to provide the service to that shop. We never pass them to another shop and never use them for our own purposes.
- **Photos of bills and documents** the shop stores are kept in the shop's own storage area.
- **AI bill scanning:** when the shop uses the AI bill scanner, the photo of the bill is sent to Google (Gemini) to read its lines. Nothing else is sent.
- **Leaving:** when the shop asks, we send it a complete copy of its data within 7 days. If the shop leaves, we delete its personal data 30 days after it stops, and copies in backups expire within 30 more days. Only anonymous totals remain, and the records GST law requires the shop to keep go to the shop in its copy.
- **Security:** every connection is encrypted, each shop's data is kept apart from every other shop's, passwords are hashed, backups are encrypted, and our staff's access is limited and logged.
- **Breaches:** if a breach affects a shop's data, we tell the shop within 72 hours of becoming aware of it, with what we know and what we are doing.

### A notice the shop can give its customers

> **(Your shop's name and address)** keeps your name and phone number and, when you give them, your email, address and state, together with what you buy and any credit (udhar) you take. We use them to bill you, to keep your credit account and to print the invoices tax law requires. We keep invoices as long as GST law requires. You can ask us to see what we hold about you, to correct it, or to delete it once you owe nothing; we keep only what the law requires. Our billing system, DukaanAI, stores this data for us and uses it only to provide our billing.

## Changes to this notice

We tell shop owners by email 30 days before a change to this notice takes effect.`;
}

export function termsMarkdown(d: LegalDetails): string {
  const courts = d.jurisdiction ? `the courts of ${d.jurisdiction}` : 'the courts of India';
  return `These terms are between **${d.operator}** ("DukaanAI", "we") and the shop that signs up ("the shop", "you"). The [privacy notice](/privacy) is part of them.

## 1. The service

DukaanAI provides counter billing, invoices, returns, cash-drawer shifts, customer credit (udhar), stock, purchase records, reports, document storage and related features, used in a web browser.

DukaanAI does not charge for the service today. If that changes, we tell you by email at least 30 days before any charge applies, and you can leave before it does.

## 2. Your account and your staff

- The person who creates the shop is its owner. The owner invites staff and gives each one a role.
- You are responsible for what is done under your shop's accounts. Every person uses their own account and keeps their password secret.
- Remove people who leave the same day.

## 3. Taxes and your invoices

- **You are the taxpayer.** DukaanAI calculates GST from the rates and details you enter (each product's GST rate, your GSTIN and state, the place of supply) and prints invoices from them. You are responsible for those details, for your tax returns and for keeping your records as the law requires.
- **What the invoice does not carry yet** is listed on the [GST billing](/features/gst-billing) page. Until those gaps are closed, these are outside the service: invoices to GST-registered buyers (B2B), e-invoicing, and bills of supply for composition dealers. Do not use DukaanAI for those supplies until we tell you they are supported, and check the printed bill with your accountant before you rely on it for a large sale.
- We are not your tax advisor. Reports and exports, including the GST summary, help your accountant; they do not replace them.

## 4. Your data

- **It is yours.** You own the data you put into DukaanAI. We use it only to provide the service to you.
- **Processing.** For your customers' and suppliers' personal data we act as your processor, as the [privacy notice](/privacy) describes. You give your customers the notice they need (the privacy notice has one you can use) and you answer their requests; we help with the ones you cannot handle in the app.
- **Export.** You can ask for a complete copy of your data at any time. We deliver it within 7 days, in open formats (JSON and CSV, with your files).
- **Leaving.** You can close your account at any time. We pause the shop, send you the export and delete your shop's personal data 30 days later. Keep your export: it is your record for tax purposes.

## 5. Availability and support

- **Backups.** We back the service up continuously, aiming to lose at most 5 minutes of data and to have the service back within 1 hour after a database failure.
- **Pausing a feature.** We may pause a single feature (for example credit sales or the AI scanner) while we fix a problem in it, without stopping the rest of the service. We tell you when we do, what to use instead, and when it is back.
- **Planned maintenance** is announced 48 hours ahead and done outside 09:00 to 21:00 IST.
- **When the service is down,** keep billing on paper and enter the bills when it is back.
- **Support:** write to [${d.contactEmail}](mailto:${d.contactEmail}).

## 6. Acceptable use

Do not try to reach another shop's data, probe or overload the service, or resell access without our written agreement. We may suspend a shop that does, after telling the owner, unless the service or other shops are at immediate risk.

## 7. Liability

The service is provided as it is. To the extent the law allows, we are not liable for indirect or consequential loss, such as lost profit or lost business, and our total liability for any claim is limited to the fees you paid us for the service in the 12 months before the claim. Nothing in these terms limits a liability the law does not allow to be limited.

## 8. Changes and ending

- We tell you by email 30 days before a change to these terms takes effect. If you do not accept it, you may leave (section 4) before it does.
- Either side may end these terms with 30 days' notice.

## 9. Law

These terms are governed by the laws of India, and ${courts} have jurisdiction.

## Contact

${contactLines(d)}`;
}
