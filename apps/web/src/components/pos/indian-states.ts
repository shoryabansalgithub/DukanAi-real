/** Indian states and union territories, as stored on `Customer.state` / `Shop.state`. */
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

/**
 * Older or common spellings, read as the state they mean. Identical to the
 * API's list (`apps/api/src/common/india/states.ts`; its states.spec.ts
 * keeps the two equal), so the POS preview and the server agree.
 */
export const STATE_ALIASES: Readonly<Record<string, string>> = {
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

/** A state as two states are compared, the way the API compares them: canonical, else folded text; null when blank. */
function comparableState(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return canonicalState(value) ?? fold(value);
}

/**
 * Inter-state supply (IGST), the API's rule (`BillingService.resolveInterState`,
 * audit P1-3): goods sold over the counter are supplied in the shop's state,
 * so a sale is intra-state (CGST + SGST) whatever state the customer's
 * profile names. IGST applies only when an explicit place of supply (a
 * delivery) differs from the shop's state. The POS sends none.
 */
export function isInterStateSupply(shopState: string | null | undefined, placeOfSupply: string | null | undefined): boolean {
  const home = comparableState(shopState);
  const supply = comparableState(placeOfSupply);
  return Boolean(home && supply && home !== supply);
}
