export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading page" className="mx-auto max-w-7xl animate-pulse">
      <div className="h-4 w-28 rounded bg-surface-raised" />
      <div className="mt-3 h-10 w-64 max-w-full rounded bg-surface-raised" />
      <div className="mt-4 h-5 w-full max-w-2xl rounded bg-surface-raised" />
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((item) => (
          <div className="h-36 rounded-card border border-border bg-surface" key={item} />
        ))}
      </div>
    </div>
  );
}
