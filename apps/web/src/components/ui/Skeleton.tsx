'use client';


/** Placeholder block; the pulse is a CSS keyframe (`.skeleton-pulse`, globals.css), not a JS animation loop (roadmap 6.8). */
export const SkeletonBox = ({ className = '' }: { className?: string }) => (
  <div aria-hidden="true" className={`skeleton-pulse bg-gray-200 dark:bg-gray-800 rounded-md ${className}`} />
);

export const SkeletonTable = ({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) => {
  return (
    <div className="w-full space-y-4">
      <div className="flex gap-4 border-b border-gray-100 dark:border-gray-800 pb-4">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonBox key={`h-${i}`} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={`r-${r}`} className="flex gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <SkeletonBox key={`r-${r}-c-${c}`} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
};
