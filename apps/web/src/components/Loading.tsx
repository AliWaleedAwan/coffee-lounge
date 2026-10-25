/**
 * Loading state (UI_UX.md §8): a few placeholder rows while a screen's data arrives, so
 * the layout does not jump. Announced once to screen readers.
 */
export function Loading({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="skeleton stack" role="status" aria-busy="true" aria-label={label}>
      <span className="visually-hidden">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}
