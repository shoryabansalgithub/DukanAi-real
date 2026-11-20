/** The DukaanAI shop mark (the same drawing as `app/icon.svg`). */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="#4f46e5" />
      <path d="M14 26h36l-3 22H17z" fill="#fff" />
      <path d="M12 18h40l4 8H8z" fill="#c7d2fe" />
      <rect x="27" y="34" width="10" height="14" rx="2" fill="#4f46e5" />
    </svg>
  );
}
