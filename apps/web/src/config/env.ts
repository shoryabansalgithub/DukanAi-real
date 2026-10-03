import { z } from 'zod';

const clientSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3002/api'),
});

/** Values the committed templates and generators leave behind. */
const PLACEHOLDER = /replace_me|your_|change_?me|placeholder|todo|xxx/i;

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
  })
  .superRefine((env, ctx) => {
    if (!enforceProductionSecret) return;
    if (!env.NEXTAUTH_SECRET) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NEXTAUTH_SECRET'], message: 'NEXTAUTH_SECRET must be set in production' });
    } else if (PLACEHOLDER.test(env.NEXTAUTH_SECRET)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NEXTAUTH_SECRET'], message: 'NEXTAUTH_SECRET is a template placeholder; production needs a real secret' });
    }
  });

export const clientConfig = clientSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});

export const serverConfig = typeof window === 'undefined' 
  ? serverSchema.parse({
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
      NEXTAUTH_URL: process.env.NEXTAUTH_URL,
      API_INTERNAL_URL: process.env.API_INTERNAL_URL,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      NODE_ENV: process.env.NODE_ENV,
    }) 
  : ({} as z.infer<typeof serverSchema>);
