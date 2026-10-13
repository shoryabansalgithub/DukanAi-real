import { Injectable } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { BooleanFromEnv } from '../hydrate-from-env';

/**
 * Feature pause switches (roadmap 9.23): the operator's way to stop one broken
 * feature without a new image. Every switch defaults to `true` (on); setting
 * `FEATURE_<NAME>_ENABLED=false` in the deployment's environment and
 * restarting the API pauses that feature and nothing else
 * (`docs/SUPPORT.md` "Pausing a feature"). A paused feature answers 503
 * `FEATURE_PAUSED`; reads, replays of documents already committed and every
 * other feature keep working. The catalogue of what each switch covers is
 * `src/common/features/feature-catalogue.ts`.
 */
@Injectable()
@ConfigDomain({ owner: 'operations', feature: 'FeatureFlagsConfig', version: '1.0.0', description: 'Feature pause switches' })
export class FeatureFlagsConfig {
  /** New sales with a credit (udhar) part. Cash, UPI and card sales continue; a replayed sale is still answered. */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_CREDIT_SALES_ENABLED')
  creditSales: boolean = true;

  /** New sales returns (`POST /billing/returns`); a replayed return is still answered. */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_RETURNS_ENABLED')
  returns: boolean = true;

  /** New invoice cancellations (`POST /billing/invoices/:id/cancel`); an already cancelled invoice is still answered. */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_CANCELLATIONS_ENABLED')
  cancellations: boolean = true;

  /** The AI bill scanner (`POST /ocr/scan-bill`). */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_OCR_ENABLED')
  ocr: boolean = true;

  /** Onboarding imports: uploads and applying a dry run (`/imports/...`); job reports stay readable. */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_IMPORTS_ENABLED')
  imports: boolean = true;

  /** Stored documents: Smart Capture bills and every other write under `/storage`. */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_DOCUMENTS_ENABLED')
  documents: boolean = true;

  /** Product photos and media changes (`/media` writes). */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_MEDIA_ENABLED')
  media: boolean = true;

  /** Procurement writes: purchase orders, goods receipts, purchase returns, vendor bills, supplier credit notes. */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_PROCUREMENT_ENABLED')
  procurement: boolean = true;

  /** The dashboard's AI insights card (`GET /dashboard/insights`, a live forecast query). */
  @IsBoolean()
  @BooleanFromEnv()
  @EnvVariable('FEATURE_DASHBOARD_INSIGHTS_ENABLED')
  dashboardInsights: boolean = true;
}
