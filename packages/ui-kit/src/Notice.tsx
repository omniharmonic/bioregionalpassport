import type { ReactNode } from 'react';
import { cn } from './cn.js';

export type NoticeKind = 'info' | 'success' | 'warning' | 'error';

export interface NoticeProps {
  kind: NoticeKind;
  children: ReactNode;
  className?: string;
}

const KIND_COLORS: Record<NoticeKind, string> = {
  info: 'var(--bp-primary)',
  success: '#2e7d32',
  warning: '#b8860b',
  error: '#b3261e',
};

/** A short inline status/feedback banner. */
export function Notice({ kind, children, className }: NoticeProps) {
  const color = KIND_COLORS[kind];
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      data-kind={kind}
      className={cn('rounded-2xl px-4 py-3 text-sm', className)}
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color: 'var(--bp-fg)',
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {children}
    </div>
  );
}
