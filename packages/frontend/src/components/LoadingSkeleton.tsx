interface LoadingSkeletonProps {
  /** Number of skeleton rows to show */
  rows?: number;
  /** Optional heading text */
  heading?: string;
}

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className ?? ""}`} />;
}

export function LoadingSkeleton({ rows = 3, heading }: LoadingSkeletonProps) {
  return (
    <div className="mx-auto max-w-5xl p-6">
      {heading && <h2 className="mb-4 text-lg font-semibold text-gray-400">{heading}</h2>}

      {/* KPI cards skeleton */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-gray-200 bg-white p-4">
            <SkeletonBlock className="mb-2 h-4 w-20" />
            <SkeletonBlock className="h-8 w-28" />
          </div>
        ))}
      </div>

      {/* Content rows skeleton */}
      <div className="space-y-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="rounded-lg border border-gray-200 bg-white p-4">
            <SkeletonBlock className="mb-3 h-4 w-48" />
            <SkeletonBlock className="h-32 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
