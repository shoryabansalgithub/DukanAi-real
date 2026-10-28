import type { Faq, MarketingPage } from './types';

export const GENERAL_FAQS: Faq[] = [
  {
    q: 'What is DukaanAI?',
    a: 'DukaanAI is billing and shop-management software for Indian kirana and retail stores: GST billing at the counter, udhar (credit) tracking, inventory with low-stock and expiry alerts, cash-drawer shifts, staff roles, an AI bill scanner and a dashboard with AI insights.',
  },
  {
    q: 'Who is DukaanAI for?',
    a: 'Owners of kirana, general, grocery and similar retail shops in India that sell over the counter to consumers, with one or more cashiers. It is not built for businesses that mainly sell to other GST-registered businesses, or for composition dealers.',
  },
  {
    q: 'What devices does it run on?',
    a: 'DukaanAI runs in the web browser on a laptop, desktop, tablet or phone, so there is nothing to install. A USB barcode scanner works on the billing screen, and receipts print on any 80 mm thermal printer or on A4.',
  },
  {
    q: 'Does DukaanAI work offline?',
    a: 'No, it needs an internet connection. If the connection drops while a sale is being confirmed, **Retry** completes it without billing twice. During a long outage, write bills on paper and enter them when the connection is back.',
  },
  {
    q: 'Are DukaanAI bills GST compliant?',
    a: 'Every counter sale prints as a tax invoice with your GSTIN, a 15-character serial number in a new series each financial year, and CGST and SGST split by rate. It does not yet print HSN codes or a buyer’s GSTIN, has no bill of supply for composition dealers and no e-invoicing. See [GST billing](/features/gst-billing) and the [GST bill format guide](/blog/gst-bill-format-kirana-store).',
  },
  {
    q: 'Can I track udhar (customer credit)?',
    a: 'Yes. Credit is a way to pay on the bill, checked against each customer’s limit, with a full ledger per customer and repayments by cash, UPI, card or bank transfer. See [udhar tracking](/features/udhar-khata).',
  },
  {
    q: 'Can my staff use it with their own logins?',
    a: 'Yes. Invite staff by email as Cashier, Stock Clerk, Manager or Admin. Each role sees only what it needs: cashiers never see cost prices, profit, stock value or supplier dues.',
  },
  {
    q: 'Can I bring my products and customers from a spreadsheet?',
    a: 'Yes. Products, customers with their udhar balances, and opening stock can be imported from spreadsheets on your first day, with our help. A dry run shows every row before anything is saved.',
  },
  {
    q: 'What does the AI do?',
    a: 'Two things today. The [AI bill scanner](/features/bill-scanner) reads a photo of a supplier bill and matches its lines to your products. The dashboard’s AI insights forecast the day’s sales, suggest what to restock and show your best-selling product.',
  },
  {
    q: 'Can I get all my data out?',
    a: 'Yes. On request you receive one archive with all your records (as JSON and as CSV for a spreadsheet) and your stored documents and photos, within 7 days.',
  },
  {
    q: 'Which languages is the app in?',
    a: 'The app’s screens are in English today. Product and customer names can be typed in any language, and Smart Capture stores photos of bills written in Hindi or any other script.',
  },
];

export const faqPage: MarketingPage = {
  path: '/faq',
  section: 'faq',
  label: 'FAQ',
  title: 'DukaanAI FAQ: GST Billing, Udhar and Inventory Questions',
  description:
    'Answers about DukaanAI: what it does, devices, offline use, GST compliance, udhar, staff logins, importing data, the AI features and getting your data out.',
  eyebrow: 'Questions and answers',
  h1: 'Frequently asked questions',
  lede: 'Straight answers about what DukaanAI does, and what it does not do yet. Missing something? The [feature pages](/features) go into detail.',
  body: '',
  faqs: GENERAL_FAQS,
  related: ['/features', '/alternatives', '/blog'],
  updated: '2026-10-28',
};
