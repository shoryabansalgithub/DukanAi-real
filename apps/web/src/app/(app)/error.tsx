'use client';

/**
 * The app's route error boundary sits inside `(app)/layout.tsx`, so a page
 * error keeps the sidebar and navbar (roadmap 6.5). `app/error.tsx` is the
 * same component one level up, for the marketing pages.
 */
export { default } from '../error';
