'use client';

/** Renders a timestamp in the reader's own time zone and locale. */
export function LocalTime({ iso, withTime = true }: { iso: string; withTime?: boolean }) {
  const d = new Date(iso);
  const text = d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
