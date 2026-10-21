import { AbcClass, Prisma, XyzClass } from '@prisma/client';

/**
 * Pure ABC / XYZ classification math for the nightly analytics job
 * (roadmap 4.9). The service feeds it net sales over the classification
 * window; nothing here touches the database.
 *
 * ABC ranks products by net revenue (sales minus returns, pre-tax) and walks
 * the ranking with a cumulative revenue share: a product still inside the
 * top 80 % is A, inside the top 95 % is B, the rest is C. A product without
 * positive revenue in the window is UNCLASSIFIED (no data, not "C").
 *
 * XYZ measures demand regularity as the coefficient of variation of the
 * weekly net units over the same window (zero weeks included): up to 0.5 is
 * X (steady), up to 1.0 is Y, above is Z (sporadic). No units sold is
 * UNCLASSIFIED.
 */

export const CLASSIFICATION_WEEKS = 13;
export const CLASSIFICATION_WINDOW_DAYS = CLASSIFICATION_WEEKS * 7;
export const ABC_A_CUMULATIVE_SHARE = 0.8;
export const ABC_B_CUMULATIVE_SHARE = 0.95;
export const XYZ_X_MAX_CV = 0.5;
export const XYZ_Y_MAX_CV = 1.0;

export interface ProductSales {
  productId: string;
  /** Net pre-tax revenue over the window. */
  revenue: Prisma.Decimal;
  /** Net units per week, index 0 = oldest week; exactly CLASSIFICATION_WEEKS entries. */
  weeklyUnits: number[];
}

export interface ProductClassification {
  productId: string;
  abcClass: AbcClass;
  xyzClass: XyzClass;
}

/** Population coefficient of variation (std dev / mean), null when the mean is not positive. */
export function coefficientOfVariation(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  if (mean <= 0) return null;
  const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance) / mean;
}

export function classifyXyz(weeklyUnits: number[]): XyzClass {
  const cv = coefficientOfVariation(weeklyUnits);
  if (cv === null) return XyzClass.UNCLASSIFIED;
  if (cv <= XYZ_X_MAX_CV) return XyzClass.X;
  if (cv <= XYZ_Y_MAX_CV) return XyzClass.Y;
  return XyzClass.Z;
}

/** ABC class per product id from the revenue ranking (ties broken by product id for a stable result). */
export function classifyAbc(products: ReadonlyArray<Pick<ProductSales, 'productId' | 'revenue'>>): Map<string, AbcClass> {
  const classes = new Map<string, AbcClass>();
  const ranked = products
    .filter((p) => p.revenue.greaterThan(0))
    .sort((a, b) => b.revenue.comparedTo(a.revenue) || a.productId.localeCompare(b.productId));
  const total = ranked.reduce((sum, p) => sum.plus(p.revenue), new Prisma.Decimal(0));

  for (const p of products) classes.set(p.productId, AbcClass.UNCLASSIFIED);
  let cumulative = new Prisma.Decimal(0);
  for (const p of ranked) {
    const shareBefore = cumulative.div(total).toNumber();
    classes.set(p.productId, shareBefore < ABC_A_CUMULATIVE_SHARE ? AbcClass.A : shareBefore < ABC_B_CUMULATIVE_SHARE ? AbcClass.B : AbcClass.C);
    cumulative = cumulative.plus(p.revenue);
  }
  return classes;
}

export function classifyProducts(products: ReadonlyArray<ProductSales>): ProductClassification[] {
  const abc = classifyAbc(products);
  return products.map((p) => ({
    productId: p.productId,
    abcClass: abc.get(p.productId) ?? AbcClass.UNCLASSIFIED,
    xyzClass: classifyXyz(p.weeklyUnits),
  }));
}
