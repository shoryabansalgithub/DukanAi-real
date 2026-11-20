/**
 * Operator-controlled auth bypass for the web app, mirroring the API's
 * AUTH_DISABLED flag. NEXT_PUBLIC_* values are inlined into the bundle at
 * build time, so the flag must be set when `next build` runs (and in the
 * runtime environment, for middleware).
 *
 * Secure by default: unset, empty, or unrecognized values keep the login
 * gate active. Only an explicit truthy value skips it, and never in a
 * production build: `process.env.NODE_ENV` is inlined too, so a production
 * bundle compiles this to `false` whatever the variable says (roadmap 6.4;
 * next.config.js additionally refuses to build or start with it set).
 */
const REQUESTED = ['1', 'true', 'yes', 'on'].includes((process.env.NEXT_PUBLIC_AUTH_DISABLED ?? '').trim().toLowerCase());

export const AUTH_DISABLED = process.env.NODE_ENV !== 'production' && REQUESTED;

/** True when the bypass is requested where it is not allowed (used by the middleware to refuse the request). */
export const AUTH_BYPASS_REFUSED = process.env.NODE_ENV === 'production' && REQUESTED;
