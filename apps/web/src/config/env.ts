import { z } from 'zod';

const DEFAULT_API_URL = 'http://localhost:3002/api';
const apiUrlSchema = z.string().url();

/** The `<meta>` the root layout renders so the browser learns the API URL at request time. */
export const API_URL_META_NAME = 'dukaanai-api-url';

/** The `<meta>` the root layout renders so the browser learns whether this server offers Google sign-in. */
export const GOOGLE_SIGNIN_META_NAME = 'dukaanai-google-signin';

let resolvedApiUrl: string | undefined;

/**
 * The API as the browser reaches it, resolved at RUN time so one web image
 * serves every environment (roadmap 9.9: promotion is an image tag, nothing
 * is rebuilt per environment).
 *
 * - On the server: `API_PUBLIC_URL` (runtime, never inlined by Next because
 *   it is not `NEXT_PUBLIC_`), else the build-time `NEXT_PUBLIC_API_URL`.
 * - In the browser: the `<meta name="dukaanai-api-url">` the root layout
 *   renders from the server value, else the build-time value inlined here.
 *
 * `NEXT_PUBLIC_API_URL` stays as the local default (`next dev`, Playwright)
 * and as the build-time fallback of an image run without `API_PUBLIC_URL`.
 */
export function publicApiUrl(): string {
  if (resolvedApiUrl) return resolvedApiUrl;
  const candidate =
    typeof window === 'undefined'
      ? process.env.API_PUBLIC_URL || process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL
      : document.querySelector<HTMLMetaElement>(`meta[name="${API_URL_META_NAME}"]`)?.content ||
        process.env.NEXT_PUBLIC_API_URL ||
        DEFAULT_API_URL;
  const parsed = apiUrlSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`The public API URL is not an absolute URL: "${candidate}" (API_PUBLIC_URL / NEXT_PUBLIC_API_URL)`);
  }
  // In the browser the <meta> is in <head> before any module evaluates, so
  // the first answer is final; on the server the environment does not change.
  resolvedApiUrl = parsed.data;
  return resolvedApiUrl;
}

/** Values the committed templates and generators leave behind. */
const PLACEHOLDER = /replace_me|your_|change_?me|placeholder|todo|xxx/i;

/** Template leftovers in OAuth credentials; a provider registered with them only produces confusing OAuth errors. */
const OAUTH_PLACEHOLDER = /replace_me|your_|change_?me|placeholder/i;

export function hasGoogleCredentials<T extends { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string }>(
  config: T,
): config is T & { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string } {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = config;
  return Boolean(id && secret && !OAUTH_PLACEHOLDER.test(id) && !OAUTH_PLACEHOLDER.test(secret));
}

/**
 * Whether "Continue with Google" is offered, decided at RUN time like the API
 * URL (roadmap 9.19): the server registers the NextAuth Google provider only
 * with real GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, and the button follows
 * the same rule, in the browser through `<meta name="dukaanai-google-signin">`.
 * The former build-time NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED was set by no
 * image, so no deployment could offer Google sign-in.
 */
export function googleSignInEnabled(): boolean {
  if (typeof window === 'undefined') {
    return hasGoogleCredentials({ GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET });
  }
  return document.querySelector<HTMLMetaElement>(`meta[name="${GOOGLE_SIGNIN_META_NAME}"]`)?.content === 'on';
}

/**
 * A production server must run with a real NEXTAUTH_SECRET: set, at least 32
 * characters and not a template placeholder. `next build` runs with
 * NODE_ENV=production too but cannot know the runtime secret, so the rule is
 * enforced on the running server only (NEXT_PHASE marks the build).
 */
const enforceProductionSecret =
  process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build';

const serverSchema = z
  .object({
    NEXTAUTH_SECRET: z.string().min(32, 'NEXTAUTH_SECRET must be at least 32 characters').optional(),
    NEXTAUTH_URL: z.string().url().default('http://localhost:3000'),
    /**
     * Where THIS server reaches the API (sign-in, token refresh). Unset, the
     * public NEXT_PUBLIC_API_URL is used. In Docker the browser reaches the
     * API through a published port while the web container reaches it on the
     * compose network (http://api:3002/api), so the two differ (roadmap 7.3).
     */
    API_INTERNAL_URL: z.string().url().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** The release this server runs (the version tag or sha-<commit>), baked into release images (roadmap 9.21). */
    APP_RELEASE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (!enforceProductionSecret) return;
    if (!env.NEXTAUTH_SECRET) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NEXTAUTH_SECRET'], message: 'NEXTAUTH_SECRET must be set in production' });
    } else if (PLACEHOLDER.test(env.NEXTAUTH_SECRET)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NEXTAUTH_SECRET'], message: 'NEXTAUTH_SECRET is a template placeholder; production needs a real secret' });
    }
  });

/** Read lazily: `NEXT_PUBLIC_API_URL` here is the runtime value of `publicApiUrl()`, not the inlined one. */
export const clientConfig = {
  get NEXT_PUBLIC_API_URL(): string {
    return publicApiUrl();
  },
};

export const serverConfig = typeof window === 'undefined' 
  ? serverSchema.parse({
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
      NEXTAUTH_URL: process.env.NEXTAUTH_URL,
      API_INTERNAL_URL: process.env.API_INTERNAL_URL,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      NODE_ENV: process.env.NODE_ENV,
      APP_RELEASE: process.env.APP_RELEASE || undefined,
    }) 
  : ({} as z.infer<typeof serverSchema>);
