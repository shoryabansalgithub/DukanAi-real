/**
 * Indian states and union territories as `Shop.state` / `Customer.state`
 * store them: the spelling the web's picker offers
 * (`apps/web/src/components/pos/indian-states.ts`, kept identical by
 * `states.spec.ts`). `BillingService.resolveInterState` compares the shop's
 * and the customer's state to choose IGST over CGST + SGST, so a misspelled
 * state is a wrong tax line, not a typo: imports refuse what this list does
 * not recognise (roadmap 9.20).
 */
export const INDIAN_STATES: readonly string[] = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
];

/** Older or common spellings a shop's spreadsheet still carries. */
const STATE_ALIASES: Readonly<Record<string, string>> = {
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  'new delhi': 'Delhi',
  'nct of delhi': 'Delhi',
  'delhi ncr': 'Delhi',
  uttaranchal: 'Uttarakhand',
  'jammu & kashmir': 'Jammu and Kashmir',
  'j&k': 'Jammu and Kashmir',
  'andaman & nicobar islands': 'Andaman and Nicobar Islands',
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
};

function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

const BY_FOLDED = new Map<string, string>([...INDIAN_STATES.map((s) => [fold(s), s] as [string, string]), ...Object.entries(STATE_ALIASES)]);

/** The stored spelling of a state, or `undefined` when the name is not an Indian state or union territory. */
export function canonicalState(value: string): string | undefined {
  return BY_FOLDED.get(fold(value));
}
