/**
 * Liveness probe for the web server (roadmap 7.3): the Docker HEALTHCHECK,
 * compose and an orchestrator poll it. It proves the Next.js server answers
 * and nothing more; the API has its own readiness probe. Excluded from the
 * session check in src/proxy.ts.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(
    { status: 'ok', timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
