import type { MarketingPage } from './types';

/** One term of the glossary; `definition` is inline Markdown. */
export interface GlossaryTerm {
  term: string;
  definition: string;
}

export const GLOSSARY: GlossaryTerm[] = [
  {
    term: 'GSTIN',
    definition:
      'The 15-character Goods and Services Tax Identification Number given to every GST-registered business. The first two digits are the state code and the next ten are the business’s PAN. It must be printed on every tax invoice you issue.',
  },
  {
    term: 'CGST and SGST',
    definition:
      'Central GST and State GST. On a sale within your own state, the GST rate is split equally between the two: an 18 % item carries 9 % CGST and 9 % SGST. A normal counter sale is always billed this way. See [GST billing](/features/gst-billing).',
  },
  {
    term: 'IGST',
    definition:
      'Integrated GST, charged instead of CGST and SGST on a supply from one state to another, such as goods delivered to a buyer in another state. Goods sold over the counter are supplied where the shop is, so they are not billed with IGST.',
  },
  {
    term: 'Cess',
    definition:
      'An extra tax charged on top of GST on some goods, such as tobacco products. When an item carries cess, the invoice shows it as its own amount.',
  },
  {
    term: 'HSN code',
    definition:
      'Harmonised System of Nomenclature: the number that classifies a product for GST. Businesses with turnover up to ₹5 crore print 4 digits on invoices to registered buyers; above ₹5 crore, 6 digits on every invoice.',
  },
  {
    term: 'Tax invoice',
    definition:
      'The bill a GST-registered business issues for a taxable sale. Rule 46 of the CGST Rules lists what it must show. Our [GST bill format guide](/blog/gst-bill-format-kirana-store) explains each item.',
  },
  {
    term: 'Bill of supply',
    definition:
      'The document issued instead of a tax invoice when no GST may be charged: by a composition dealer, or for a sale of exempt goods only.',
  },
  {
    term: 'Composition scheme',
    definition:
      'A simpler GST scheme for small businesses (turnover up to ₹1.5 crore for goods in most states) that pay tax at a low fixed rate on turnover. Composition dealers cannot charge GST to customers and issue bills of supply.',
  },
  {
    term: 'Credit note',
    definition:
      'The document issued when goods are returned or a bill is reduced after the sale. It refers to the original invoice and reduces the output tax. Under section 34 it can be issued only until 30 November after the end of the financial year of the sale. See [returns and credit notes](/blog/gst-returns-credit-notes).',
  },
  {
    term: 'Financial year',
    definition:
      'In India, 1 April to 31 March. GST invoice numbers run in one series per financial year, and many deadlines are counted from its end.',
  },
  {
    term: 'Place of supply',
    definition:
      'Where a supply is taxed under GST. It decides whether a sale is intra-state (CGST + SGST) or inter-state (IGST). For goods sold over the counter, it is the shop’s location.',
  },
  {
    term: 'MRP',
    definition:
      'Maximum Retail Price: the highest price, inclusive of all taxes, at which a packaged product may be sold to a consumer. A shop may sell below MRP, never above it.',
  },
  {
    term: 'Udhar',
    definition:
      'Credit given to a customer: goods taken now and paid for later. Shops record it in a khata (ledger). See [udhar tracking](/features/udhar-khata) and [how to manage udhar](/blog/manage-udhar-kirana-store).',
  },
  {
    term: 'Khata',
    definition:
      'A ledger book. In a shop, the bahi khata records each customer’s purchases on credit and their payments, with the balance they owe.',
  },
  {
    term: 'Credit limit',
    definition:
      'The most a customer is allowed to owe at any time. A credit sale that would take them past it is refused until they pay or the limit is raised.',
  },
  {
    term: 'Reorder point',
    definition:
      'The stock level at which a product should be reordered: average daily sales × supplier lead time + safety stock. See [reorder points with examples](/blog/reorder-point-kirana-store).',
  },
  {
    term: 'Safety stock',
    definition:
      'Extra stock kept to cover busy days and late deliveries, so a product does not run out before the next order arrives.',
  },
  {
    term: 'Lead time',
    definition:
      'The number of days between placing an order with a supplier and having the stock on your shelf.',
  },
  {
    term: 'SKU',
    definition:
      'Stock Keeping Unit: a shop’s own code for one product, often printed as or alongside a barcode. Two pack sizes of the same item have different SKUs.',
  },
  {
    term: 'Shift variance',
    definition:
      'The difference between the cash counted in a drawer at closing and the cash that should be there. A negative variance means cash is missing. See [cash drawer and shifts](/features/cash-drawer-shifts).',
  },
];

export const glossaryPage: MarketingPage = {
  path: '/glossary',
  section: 'glossary',
  label: 'Glossary',
  title: 'Kirana and GST Glossary: GSTIN, CGST, HSN, Udhar and More',
  description:
    'Plain-language definitions of the GST, billing and stock terms a kirana store owner meets: GSTIN, CGST and SGST, HSN, bill of supply, credit note, udhar, reorder point and more.',
  eyebrow: 'Glossary',
  h1: 'Kirana and GST glossary',
  lede: 'Short, plain definitions of the tax, billing and stock words that come up when you run a shop in India, with links to the guides that go deeper.',
  body: GLOSSARY.map(({ term, definition }) => `## ${term}\n\n${definition}`).join('\n\n'),
  related: ['/blog/gst-bill-format-kirana-store', '/features', '/faq'],
  updated: '2026-10-28',
};
