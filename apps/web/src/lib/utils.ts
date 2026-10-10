/**
 * Utility functions for the application
 */

export const clsx = (...classes: (string | boolean | null | undefined)[]): string => {
  return classes.filter(Boolean).join(' ');
};
