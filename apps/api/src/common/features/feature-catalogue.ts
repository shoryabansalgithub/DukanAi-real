import { ServiceUnavailableException } from '@nestjs/common';
import { FeatureFlagsConfig } from '../../config/domains/feature-flags.config';

/**
 * The features an operator can pause (roadmap 9.23). Each entry names its
 * switch on `FeatureFlagsConfig` (one `FEATURE_<NAME>_ENABLED` variable),
 * what the shop sees while it is paused, and where it is enforced: a route
 * gate (`@FeatureGate`, `FeatureGateGuard`) or a check inside the service
 * that must still answer replays of documents already committed. The
 * support guide (`docs/SUPPORT.md`) lists the same table for the operator;
 * `feature-catalogue.spec.ts` keeps the two and the config class in step.
 */
export const FEATURES = {
  credit_sales: { flag: 'creditSales', env: 'FEATURE_CREDIT_SALES_ENABLED', label: 'Credit (udhar) sales', enforcedBy: 'BillingService.checkout' },
  returns: { flag: 'returns', env: 'FEATURE_RETURNS_ENABLED', label: 'Sales returns', enforcedBy: 'InvoiceReversalService.processReturn' },
  cancellations: { flag: 'cancellations', env: 'FEATURE_CANCELLATIONS_ENABLED', label: 'Invoice cancellations', enforcedBy: 'InvoiceReversalService.cancelInvoice' },
  ocr: { flag: 'ocr', env: 'FEATURE_OCR_ENABLED', label: 'AI bill scanner', enforcedBy: 'route' },
  imports: { flag: 'imports', env: 'FEATURE_IMPORTS_ENABLED', label: 'Data imports', enforcedBy: 'route' },
  documents: { flag: 'documents', env: 'FEATURE_DOCUMENTS_ENABLED', label: 'Stored documents (Smart Capture)', enforcedBy: 'route' },
  media: { flag: 'media', env: 'FEATURE_MEDIA_ENABLED', label: 'Product photos', enforcedBy: 'route' },
  procurement: { flag: 'procurement', env: 'FEATURE_PROCUREMENT_ENABLED', label: 'Purchasing (orders, receipts, bills)', enforcedBy: 'route' },
  dashboard_insights: { flag: 'dashboardInsights', env: 'FEATURE_DASHBOARD_INSIGHTS_ENABLED', label: 'Dashboard insights', enforcedBy: 'route' },
} as const satisfies Record<string, { flag: keyof FeatureFlagsConfig; env: string; label: string; enforcedBy: string }>;

export type FeatureName = keyof typeof FEATURES;

export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[];

export function isFeatureEnabled(config: FeatureFlagsConfig, feature: FeatureName): boolean {
  return config[FEATURES[feature].flag] !== false;
}

export function pausedFeatures(config: FeatureFlagsConfig): FeatureName[] {
  return FEATURE_NAMES.filter((name) => !isFeatureEnabled(config, name));
}

/** The answer of a paused feature: 503 with a code the web shows as a message, never a bug. */
export function featurePausedException(feature: FeatureName): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: `${FEATURES[feature].label} is paused for maintenance. Everything else keeps working; please try again later.`,
    code: 'FEATURE_PAUSED',
    details: { feature },
  });
}

/** Throws the paused answer when the feature is off (service-level checks). */
export function assertFeatureEnabled(config: FeatureFlagsConfig, feature: FeatureName): void {
  if (!isFeatureEnabled(config, feature)) throw featurePausedException(feature);
}

/**
 * Environment variables that look like a switch but name none: a typo such
 * as `FEATURE_OCR_ENABLE=false` would otherwise leave the feature running
 * while the operator believes it paused. Reported at boot, never fatal (a
 * refusal to boot during an incident is worse than the warning).
 */
export function unknownFeatureVariables(env: NodeJS.ProcessEnv): string[] {
  const known = new Set<string>(FEATURE_NAMES.map((name) => FEATURES[name].env));
  return Object.keys(env)
    .filter((key) => key.startsWith('FEATURE_') && !known.has(key))
    .sort();
}
