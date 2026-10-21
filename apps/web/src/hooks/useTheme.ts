import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/**
 * localStorage throws in some browsers (blocked site data, some private modes):
 * the theme then falls back to the system preference and is not remembered,
 * instead of the navbar crashing (audit W18).
 */
function readSavedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem('theme');
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Not remembered: the toggle still applies to this page.
  }
}

/** Light/dark toggle persisted in localStorage (the navbar switch). */
export const useTheme = () => {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedTheme = readSavedTheme();
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', prefersDark);
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    saveTheme(newTheme);
    document.documentElement.classList.toggle('dark', newTheme === 'dark');
  };

  return { theme, toggleTheme, mounted };
};
