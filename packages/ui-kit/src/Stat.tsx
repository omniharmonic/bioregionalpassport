import type { ReactNode } from 'react';

export interface StatProps {
  label: string;
  value: ReactNode;
  hint?: string;
  className?: string;
}

/** A labelled number/value, e.g. for consoles and dashboards. */
export function Stat({ label, value, hint, className }: StatProps) {
  return (
    <div className={className}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div data-display className="text-2xl font-semibold">
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs opacity-60">{hint}</div> : null}
    </div>
  );
}
