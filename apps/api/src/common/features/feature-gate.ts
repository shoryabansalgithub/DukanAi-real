import { CanActivate, ExecutionContext, Injectable, Logger, OnModuleInit, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { FeatureFlagsConfig } from '../../config/domains/feature-flags.config';
import { featureEnabled } from '../observability/metrics';
import { FEATURES, FEATURE_NAMES, FeatureName, featurePausedException, isFeatureEnabled, pausedFeatures, unknownFeatureVariables } from './feature-catalogue';

export const FEATURE_GATE_KEY = 'featureGate';

export interface FeatureGateOptions {
  /** Pause GET/HEAD too (a read that is itself the broken work, such as the insights query). Default: writes only. */
  reads?: boolean;
}

interface FeatureGateMetadata {
  feature: FeatureName;
  reads: boolean;
}

/**
 * Puts a controller or handler behind a pause switch (roadmap 9.23). By
 * default only writes are paused, so a paused feature stays readable: the
 * shop can still look at what it recorded.
 */
export const FeatureGate = (feature: FeatureName, options: FeatureGateOptions = {}) =>
  SetMetadata(FEATURE_GATE_KEY, { feature, reads: options.reads === true } satisfies FeatureGateMetadata);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard, registered after the authorization guards (`app.module.ts`):
 * nobody learns that a feature is paused before they are signed in and
 * allowed to use it, and the route walker's 401/403 expectations hold.
 */
@Injectable()
export class FeatureGateGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger('FeatureFlags');

  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagsConfig,
  ) {}

  onModuleInit(): void {
    for (const name of FEATURE_NAMES) featureEnabled.set({ feature: name }, isFeatureEnabled(this.flags, name) ? 1 : 0);
    const paused = pausedFeatures(this.flags);
    if (paused.length > 0) {
      this.logger.warn({ message: `Paused features: ${paused.map((name) => `${name} (${FEATURES[name].env}=false)`).join(', ')}`, event: 'feature_paused', paused });
    }
    const unknown = unknownFeatureVariables(process.env);
    if (unknown.length > 0) {
      this.logger.warn({
        message: `Ignored ${unknown.join(', ')}: no such feature switch. Known: ${FEATURE_NAMES.map((name) => FEATURES[name].env).join(', ')}`,
        event: 'feature_unknown_variable',
        unknown,
      });
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const gate = this.reflector.getAllAndOverride<FeatureGateMetadata | undefined>(FEATURE_GATE_KEY, [context.getHandler(), context.getClass()]);
    if (!gate) return true;
    const method = context.switchToHttp().getRequest<Request>().method?.toUpperCase() ?? 'GET';
    if (!gate.reads && READ_METHODS.has(method)) return true;
    if (isFeatureEnabled(this.flags, gate.feature)) return true;
    throw featurePausedException(gate.feature);
  }
}
