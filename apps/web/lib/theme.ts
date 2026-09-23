import type { BioregionManifest } from '@passport/tenant-config';
import type { ThemeSource } from '@passport/ui-kit';

const SERIF = 'ui-serif, Georgia, "Times New Roman", serif';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const LOADED: Record<string, string> = {
  fraunces: `var(--font-fraunces), ${SERIF}`,
  inter: `var(--font-inter), ${SANS}`,
  'space grotesk': `var(--font-space-grotesk), ${SANS}`,
};

/** CSS font stack for a manifest font name: a self-hosted family when we load it, else the name plus a fallback. */
export function fontStack(name: string): string {
  const key = name.trim().toLowerCase();
  const hit = LOADED[key];
  if (hit) return hit;
  const safe = name.replace(/["\;{}]/g, '').trim();
  return safe ? `"${safe}", ${SANS}` : SANS;
}

/** The manifest's theme with font names resolved to loadable stacks, ready for `ThemeProvider`. */
export function themeSource(manifest: BioregionManifest): ThemeSource {
  const { tokens, font, tone } = manifest.theme;
  return {
    theme: {
      tokens: { primary: tokens.primary, accent: tokens.accent, bg: tokens.bg, fg: tokens.fg },
      font: { display: fontStack(font.display), body: fontStack(font.body) },
      tone,
    },
  };
}
