/**
 * Per-page print sheet (roadmap 6.7). `@page` cannot be scoped by selector, so
 * each printable page mounts its own rule while it is on screen: the receipt
 * uses an 80 mm roll, an invoice A4. The CSP allows inline <style>
 * (`style-src 'unsafe-inline'`), and the element is removed with the page.
 */
export function PrintPageStyle({ size, margin }: { size: string; margin: string }) {
  return <style>{`@media print { @page { size: ${size}; margin: ${margin}; } }`}</style>;
}
