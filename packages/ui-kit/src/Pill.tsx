import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'accent';
  children?: ReactNode;
}

/** A small rounded label, e.g. for record categories or status words. */
export function Pill({ tone = 'neutral', className, children, style, ...rest }: PillProps) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', className)}
      style={{
        background:
          tone === 'accent'
            ? 'color-mix(in srgb, var(--bp-accent) 25%, transparent)'
            : 'color-mix(in srgb, var(--bp-fg) 8%, transparent)',
        color: 'var(--bp-fg)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
