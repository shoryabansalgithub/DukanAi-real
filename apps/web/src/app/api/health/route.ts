/**
 * Liveness probe for the web server (roadmap 7.3): the Docker HEALTHCHECK,
 * compose and an orchestrator poll it. It proves the Next.js server answers
 * and nothing more; the API has its own readiness probe. Excluded from the
 * session check in src/proxy.ts.
 */
import { serverConfig } from '@/config/env';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(
    // `release`: the version tag or sha-<commit> of the image (roadmap 9.21), what a deploy is verified against.
    { status: 'ok', timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), release: serverConfig.APP_RELEASE ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
