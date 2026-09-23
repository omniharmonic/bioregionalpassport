import type { ReactNode } from 'react';
import { cn } from './cn.js';

export interface ExplainProps {
  children: ReactNode;
  className?: string;
}

/**
 * A one-sentence gate explanation box. Every gate in the product explains
 * itself in one plain sentence — this is the box that carries it, with a
 * small "i" glyph so it reads as informational rather than a warning.
 */
export function Explain({ children, className }: ExplainProps) {
  return (
    <div
      role="note"
      className={cn('flex items-start gap-2 rounded-2xl px-4 py-3 text-sm', className)}
      style={{
        background: 'color-mix(in srgb, var(--bp-primary) 8%, transparent)',
        color: 'var(--bp-fg)',
        border: '1px solid color-mix(in srgb, var(--bp-primary) 20%, transparent)',
      }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold"
        style={{ background: 'var(--bp-primary)', color: '#fff' }}
      >
        i
      </span>
      <span>{children}</span>
    </div>
  );
}
