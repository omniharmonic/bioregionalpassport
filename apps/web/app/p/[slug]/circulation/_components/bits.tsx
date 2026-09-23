'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Notice } from '@passport/ui-kit';
import type { Band } from '../_lib/format';

/** One-sentence server message (or nothing). */
export function ErrorLine({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div role="alert">
      <Notice kind="error">{message}</Notice>
    </div>
  );
}

export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <p role="status" className="muted">
      {children}
    </p>
  );
}

const BAND_COLOR: Record<Band | 'breach' | 'warn', string> = {
  ok: '#2e7d32',
  warm: '#b8860b',
  warn: '#b8860b',
  hot: '#b3261e',
  breach: '#b3261e',
};

/** Tinted background for exposure bands and kill-criteria cards. */
export function bandStyle(band: Band | 'breach' | 'warn'): CSSProperties {
  const c = BAND_COLOR[band];
  return { background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` };
}

export function BandDot({ band, label }: { band: Band | 'breach' | 'warn'; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: BAND_COLOR[band] }} />
      {label}
    </span>
  );
}

/** Copies text to the clipboard with a small confirmation. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Starts a download of `text` as a file. */
export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
