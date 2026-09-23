'use client';

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';

/**
 * Minimal shape of "something manifest-like" this kit needs to theme a
 * page. Deliberately NOT imported from `@passport/tenant-config` — the
 * ui-kit must not depend on that package, so any object with this shape
 * (a full BioregionManifest, a test fixture, a partial preview payload)
 * works here.
 */
export interface ThemeSource {
  theme: {
    tokens: {
      primary: string;
      accent: string;
      bg: string;
      fg: string;
    };
    font: {
      display: string;
      body: string;
    };
    tone: string;
  };
}

export interface ThemeVars extends CSSProperties {
  '--bp-primary': string;
  '--bp-accent': string;
  '--bp-bg': string;
  '--bp-fg': string;
  '--bp-font-display': string;
  '--bp-font-body': string;
}

/**
 * Builds the inline style object carrying the six runtime CSS variables
 * that everything else in this kit (and the app's Tailwind utilities via
 * theme.css) reads from.
 */
export function themeVars(manifest: ThemeSource): ThemeVars {
  const { tokens, font } = manifest.theme;
  return {
    '--bp-primary': tokens.primary,
    '--bp-accent': tokens.accent,
    '--bp-bg': tokens.bg,
    '--bp-fg': tokens.fg,
    '--bp-font-display': font.display,
    '--bp-font-body': font.body,
  };
}

const ThemeContext = createContext<ThemeSource | null>(null);

export interface ThemeProviderProps {
  manifest: ThemeSource;
  children?: ReactNode;
}

/**
 * Renders the themed root of a pod page. Writes the six `--bp-*` CSS
 * variables from `manifest.theme` on a wrapper div and exposes
 * `manifest.theme.tone` as `data-tone` so components can vary treatment
 * (e.g. "warm" vs "plain") without prop drilling.
 */
export function ThemeProvider({ manifest, children }: ThemeProviderProps) {
  const style = themeVars(manifest);
  return (
    <ThemeContext.Provider value={manifest}>
      <div
        data-tone={manifest.theme.tone}
        style={{ ...style, background: 'var(--bp-bg)', color: 'var(--bp-fg)' }}
        className="bp-theme min-h-screen"
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

/** Reads the manifest-shaped source supplied by the nearest ThemeProvider. */
export function useTheme(): ThemeSource {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme() must be called within a <ThemeProvider>');
  }
  return ctx;
}
