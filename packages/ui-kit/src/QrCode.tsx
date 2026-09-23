'use client';

import { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';

export interface QrCodeProps {
  value: string;
  size?: number;
  className?: string;
}

/**
 * Renders `value` as a QR code image. Generates the data URL client-side
 * with `qrcode`'s `toDataURL`; shows a placeholder box while it loads and
 * whenever `value` is empty.
 */
export function QrCode({ value, size = 200, className }: QrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    if (!value) return;
    toDataURL(value, { width: size, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        role="img"
        aria-label="QR code loading"
        className={className}
        style={{
          width: size,
          height: size,
          background: 'color-mix(in srgb, var(--bp-fg) 6%, transparent)',
          borderRadius: '1rem',
        }}
      />
    );
  }

  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt="QR code"
      className={className}
      style={{ borderRadius: '1rem' }}
    />
  );
}
