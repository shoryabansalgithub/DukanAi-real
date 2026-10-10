'use client';

import { useEffect } from 'react';

/**
 * Per-page print sheet (roadmap 6.7). `@page` cannot be scoped by selector, so
 * each printable page mounts its own rule while it is on screen: an invoice
 * prints on A4. The receipt passes no size: CSS has no "continuous roll"
 * value (`80mm auto`, used until 9.19, is invalid and every browser ignored
 * it; `80mm` alone cuts a long receipt into 80 mm pages), so the thermal
 * printer's own roll paper, chosen in its driver, sets the length
 * (docs/PILOT.md, printer setup). The CSP allows inline <style>
 * (`style-src 'unsafe-inline'`), and the element is removed with the page.
 *
 * Paper is printed in the light theme the documents are designed in: a
 * device in dark mode turned the receipt's gray labels into near-white text,
 * which a thermal printer leaves blank (roadmap 9.19). `beforeprint` takes
 * the `dark` class off for the print and `afterprint` puts it back.
 */
export function PrintPageStyle({ size, margin }: { size?: string; margin: string }) {
  useEffect(() => {
    const root = document.documentElement;
    let restoreDark = false;
    const beforePrint = () => {
      restoreDark = root.classList.contains('dark');
      if (restoreDark) root.classList.remove('dark');
    };
    const afterPrint = () => {
      if (restoreDark) root.classList.add('dark');
      restoreDark = false;
    };
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    return () => {
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
      afterPrint();
    };
  }, []);

  return <style>{`@media print { @page { ${size ? `size: ${size}; ` : ''}margin: ${margin}; } }`}</style>;
}
