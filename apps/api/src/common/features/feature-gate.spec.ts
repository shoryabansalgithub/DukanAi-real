import 'reflect-metadata';
import { readFileSync } from 'fs';
import * as path from 'path';
import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagsConfig } from '../../config/domains/feature-flags.config';
import { ENV_VARIABLE_KEY } from '../../config/registry/registry.decorators';
import { hydrateFromEnv } from '../../config/hydrate-from-env';
import { FEATURES, FEATURE_NAMES, pausedFeatures, unknownFeatureVariables } from './feature-catalogue';
import { FeatureGate, FeatureGateGuard } from './feature-gate';

const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

class GatedController {
  @FeatureGate('ocr')
  write() {}

  @FeatureGate('dashboard_insights', { reads: true })
  insights() {}

  plain() {}
}

function context(handler: keyof GatedController, method: string): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => GatedController.prototype[handler],
    getClass: () => GatedController,
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
}

function flags(overrides: Partial<FeatureFlagsConfig> = {}): FeatureFlagsConfig {
  return Object.assign(new FeatureFlagsConfig(), overrides);
}

describe('feature pause switches (roadmap 9.23)', () => {
  it('every catalogue entry is one switch of FeatureFlagsConfig, read from its own variable', () => {
    const declared = (Reflect.getMetadata(ENV_VARIABLE_KEY, FeatureFlagsConfig) as string[]).slice().sort();
    expect(declared).toEqual(FEATURE_NAMES.map((name) => FEATURES[name].env).sort());
    expect(Object.keys(new FeatureFlagsConfig()).sort()).toEqual(FEATURE_NAMES.map((name) => FEATURES[name].flag).sort());
    const saved = { ...process.env };
    try {
      for (const name of FEATURE_NAMES) {
        process.env = { ...saved, [FEATURES[name].env]: 'false' };
        expect(pausedFeatures(hydrateFromEnv(FeatureFlagsConfig))).toEqual([name]);
      }
    } finally {
      process.env = saved;
    }
  });

  it('every switch defaults to on, and false/0 from the environment pauses it', () => {
    expect(pausedFeatures(flags())).toEqual([]);
    const saved = { ...process.env };
    try {
      process.env.FEATURE_OCR_ENABLED = 'false';
      process.env.FEATURE_RETURNS_ENABLED = '0';
      process.env.FEATURE_IMPORTS_ENABLED = '';
      expect(pausedFeatures(hydrateFromEnv(FeatureFlagsConfig))).toEqual(['returns', 'ocr']);
    } finally {
      process.env = saved;
    }
  });

  it('a FEATURE_* variable that names no switch is reported (a typo must not look like a pause)', () => {
    expect(unknownFeatureVariables({ FEATURE_OCR_ENABLED: 'false', FEATURE_OCR_ENABLE: 'false', OTHER: '1' })).toEqual(['FEATURE_OCR_ENABLE']);
  });

  it('the support guide, .env.example and .env.production list every switch', () => {
    const support = readFileSync(path.join(REPO_ROOT, 'docs', 'SUPPORT.md'), 'utf8');
    const example = readFileSync(path.join(API_ROOT, '.env.example'), 'utf8');
    const production = readFileSync(path.join(API_ROOT, '.env.production'), 'utf8');
    for (const name of FEATURE_NAMES) {
      const env = FEATURES[name].env;
      expect(support).toContain(`\`${env}\``);
      expect(example).toMatch(new RegExp(`^${env}=true$`, 'm'));
      expect(production).toMatch(new RegExp(`^${env}=true$`, 'm'));
    }
  });

  it('the deployment forms forward every switch (compose interpolation, Kubernetes ConfigMap)', () => {
    const compose = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
    const prod = readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
    const configMap = readFileSync(path.join(REPO_ROOT, 'deploy', 'k8s', 'configmap.yaml'), 'utf8');
    const deployment = readFileSync(path.join(REPO_ROOT, 'deploy', 'k8s', 'deployment-api.yaml'), 'utf8');
    for (const name of FEATURE_NAMES) {
      const env = FEATURES[name].env;
      for (const file of [compose, prod]) expect(file).toContain(`${env}: \${${env}:-true}`);
      expect(configMap).toContain(`${env}: "true"`);
      expect(deployment).toContain(`key: ${env} }`);
    }
  });

  describe('FeatureGateGuard', () => {
    const reflector = new Reflector();

    it('lets everything through while the feature is on', () => {
      const guard = new FeatureGateGuard(reflector, flags());
      expect(guard.canActivate(context('write', 'POST'))).toBe(true);
      expect(guard.canActivate(context('insights', 'GET'))).toBe(true);
    });

    it('a paused feature refuses writes with 503 FEATURE_PAUSED and stays readable', () => {
      const guard = new FeatureGateGuard(reflector, flags({ ocr: false }));
      expect(guard.canActivate(context('write', 'GET'))).toBe(true);
      let error: unknown;
      try {
        guard.canActivate(context('write', 'POST'));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'FEATURE_PAUSED', details: { feature: 'ocr' } });
      expect(guard.canActivate(context('plain', 'POST'))).toBe(true);
    });

    it('a gate with reads: true pauses GET too', () => {
      const guard = new FeatureGateGuard(reflector, flags({ dashboardInsights: false }));
      expect(() => guard.canActivate(context('insights', 'GET'))).toThrow(ServiceUnavailableException);
    });
  });
});
