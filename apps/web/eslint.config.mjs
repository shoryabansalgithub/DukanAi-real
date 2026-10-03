// ESLint 9 flat config (Next.js 16 removed `next lint`; `npm run lint` runs `eslint .`).
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  globalIgnores(['.next/**', 'dist/**', 'build/**', 'coverage/**', 'public/**', 'next-env.d.ts', 'test-results/**', 'test-results-auth/**', 'playwright-report/**', 'playwright-report-auth/**']),
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      // eslint-plugin-react-hooks 7 ships React Compiler rules. The app does not use the compiler, and its
      // mount effects (reading storage, syncing props into state) are deliberate; revisit when the compiler is adopted.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },
  {
    // CommonJS tooling configs (Tailwind, PostCSS, Next) use require() by design.
    files: ['*.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
