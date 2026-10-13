import 'reflect-metadata';
import { readFileSync } from 'fs';
import * as path from 'path';
import { ENV_VARIABLE_KEY } from './registry/registry.decorators';
import { EnterpriseConfigModule } from './enterprise-config.module';
import { hydrateFromEnv } from './hydrate-from-env';
import { isPlaceholderValue } from './validation/env-rules';

/**
 * Roadmap 9.19: an image carries no env file (docs/DEPLOYMENT.md, "no env
 * file copied in"), so a container runs the code default of every variable
 * compose or Kubernetes does not set, whatever `.env.production` says. The
 * pilot pre-flight found production running 30-day sessions where the
 * template says 12 h (ASVS 3.3.2) and a 0.4 OCR match threshold where it
 * says 0.85. This spec holds the three together:
 *
 *  - a value `.env.production` gives a config domain equals the class
 *    default (the 9.16 rule, for every domain);
 *  - except a variable the deployment itself sets (a secret, an endpoint, a
 *    path, a placeholder): then the API service of docker-compose.prod.yml
 *    and the Kubernetes manifests both set it.
 */
const API_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

/** Set by the deployment, never by a default; each must appear in both deployment forms. */
const DEPLOYMENT_SET: Record<string, string> = {
  DATABASE_URL: 'the managed database endpoint and its credentials',
  REDIS_URL: 'the managed Redis endpoint and its credentials',
  JWT_SECRET: 'a secret',
  FRONTEND_URL: "the web's public origin",
  STORAGE_ROOT: "the documents volume's mount point",
  SMTP_URL: 'the mail relay endpoint and its credentials',
  EMAIL_FROM: "the shop's sender address",
  GEMINI_API_KEY: 'a secret',
  METRICS_TOKEN: 'a secret',
  SENTRY_DSN: 'an endpoint with its key',
  TRUST_PROXY: 'the proxy hops in front of the API (1 behind the edge, 2 behind a load balancer)',
  LOG_LEVEL: 'set by the deployment to the reviewed production level',
  SHUTDOWN_DRAIN_DELAY_MS: 'differs by orchestrator: 0 under compose, 5 s under Kubernetes (endpoint removal)',
  SHUTDOWN_TIMEOUT_MS: 'tied to the orchestrator grace period (stop_grace_period / terminationGracePeriodSeconds)',
  UPLOAD_TEMP_DIR: "the uploads volume's mount point",
  BACKUP_STATUS_DIR: "the backups volume's mount point",
  PORT: 'the container port the edge and probes address',
  SENTRY_ENVIRONMENT: 'the environment name error tracking files events under (staging, production)',
};

/** Set by the image itself (`ENV` in apps/api/Dockerfile), not by the deployment. */
const IMAGE_SET: Record<string, string> = {
  NODE_ENV: 'production in every API image',
};

/**
 * Documented in the template but deliberately not deployed: a container runs
 * without them, which is the documented state.
 */
const NOT_DEPLOYED: Record<string, string> = {
  S3_REGION: 'object storage is not used: documents live on the volume behind StoragePathBuilder (roadmap 9.7)',
  S3_ENDPOINT: 'object storage is not used (see S3_REGION)',
  S3_ACCESS_KEY: 'object storage is not used (see S3_REGION)',
  S3_SECRET_KEY: 'object storage is not used (see S3_REGION)',
  S3_BUCKET: 'object storage is not used (see S3_REGION)',
  S3_PUBLIC_URL: 'object storage is not used (see S3_REGION)',
};

function parseTemplate(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of readFileSync(path.join(API_ROOT, file), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

function providedDomains(): Array<new () => object> {
  const meta = Reflect.getMetadata('providers', EnterpriseConfigModule) as Array<{ provide?: unknown } | (new () => object)>;
  return meta.map((p) => (typeof p === 'function' ? p : p.provide)).filter((p): p is new () => object => typeof p === 'function');
}

const production = parseTemplate('.env.production');
const apiDockerfile = readFileSync(path.join(API_ROOT, 'Dockerfile'), 'utf8');
const composeProd = readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
const kubernetes = ['configmap.yaml', 'deployment-api.yaml', 'dukaanai-secrets.env.example']
  .map((file) => readFileSync(path.join(REPO_ROOT, 'deploy', 'k8s', file), 'utf8'))
  .join('\n');

/** Every (domain, variable) whose `.env.production` value differs from what the class builds without it. */
function differences(): Array<{ domain: string; variable: string; production: string; defaultValue: unknown }> {
  const found: Array<{ domain: string; variable: string; production: string; defaultValue: unknown }> = [];
  for (const domain of providedDomains()) {
    const variables = (Reflect.getMetadata(ENV_VARIABLE_KEY, domain) as string[] | undefined) ?? [];
    const defaults = hydrateFromEnv(domain, {});
    for (const variable of variables) {
      if (!(variable in production)) continue;
      const withValue = hydrateFromEnv(domain, { [variable]: production[variable] });
      const changed = Object.keys({ ...defaults, ...withValue }).find(
        (key) => JSON.stringify((withValue as Record<string, unknown>)[key]) !== JSON.stringify((defaults as Record<string, unknown>)[key]),
      );
      if (changed) found.push({ domain: domain.name, variable, production: production[variable], defaultValue: (defaults as Record<string, unknown>)[changed] });
    }
  }
  return found;
}

describe('production runs what .env.production documents (roadmap 9.19)', () => {
  const diffs = differences();

  it('reads the production template and the domains', () => {
    expect(Object.keys(production).length).toBeGreaterThan(50);
    expect(providedDomains().length).toBeGreaterThan(20);
  });

  it('every value .env.production gives a domain is the class default, unless the deployment sets it', () => {
    const drifted = diffs
      .filter(({ variable, production: value }) => !DEPLOYMENT_SET[variable] && !IMAGE_SET[variable] && !NOT_DEPLOYED[variable] && !isPlaceholderValue(value))
      .map(({ domain, variable, production: value, defaultValue }) => `${domain}.${variable}: .env.production=${value}, default=${JSON.stringify(defaultValue)}`);
    expect(drifted).toEqual([]);
  });

  it('a variable the deployment sets is set by docker-compose.prod.yml and by the Kubernetes manifests', () => {
    const deploymentSet = new Set([
      ...Object.keys(DEPLOYMENT_SET).filter((variable) => variable in production),
      ...diffs.filter(({ variable, production: value }) => isPlaceholderValue(value) && !NOT_DEPLOYED[variable]).map(({ variable }) => variable),
    ]);
    const missing = [...deploymentSet]
      .flatMap((variable) => [
        ...(new RegExp(`^\\s+${variable}:`, 'm').test(composeProd) ? [] : [`${variable} (docker-compose.prod.yml)`]),
        ...(new RegExp(`\\b${variable}\\b`).test(kubernetes) ? [] : [`${variable} (deploy/k8s)`]),
      ])
      .sort();
    expect(missing).toEqual([]);
  });

  it('a variable the image sets is set by the API Dockerfile', () => {
    const missing = Object.keys(IMAGE_SET).filter((variable) => !new RegExp(`^ENV\\b.*\\b${variable}=${production[variable]}\\b`, 'm').test(apiDockerfile));
    expect(missing).toEqual([]);
  });

  it('the lists name only variables the API reads', () => {
    const declared = new Set(providedDomains().flatMap((domain) => (Reflect.getMetadata(ENV_VARIABLE_KEY, domain) as string[] | undefined) ?? []));
    const stale = [...Object.keys(DEPLOYMENT_SET), ...Object.keys(IMAGE_SET), ...Object.keys(NOT_DEPLOYED)].filter((variable) => !declared.has(variable) && variable !== 'PORT');
    expect(stale).toEqual([]);
  });
});
