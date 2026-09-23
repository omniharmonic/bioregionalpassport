import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}

/** A calm placeholder for lists/views with nothing in them yet. */
export function EmptyState({ title, body, action, className }: EmptyStateProps) {
  return (
    <div
      className={
        (className ? className + ' ' : '') +
        'flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-12 text-center'
      }
      style={{ border: '1px dashed color-mix(in srgb, var(--bp-fg) 20%, transparent)' }}
    >
      <div data-display className="text-lg font-semibold">
        {title}
      </div>
      {body ? <p className="max-w-sm text-sm opacity-70">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
