import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider, themeVars, type ThemeSource } from './theme.js';

const sampleManifest: ThemeSource = {
  theme: {
    tokens: { primary: '#1F5F4A', accent: '#E4B04A', bg: '#FBF8F2', fg: '#17201C' },
    font: { display: 'Fraunces', body: 'Inter' },
    tone: 'warm',
  },
};

describe('ThemeProvider', () => {
  it('sets the six CSS variables and data-tone from the manifest', () => {
    render(
      <ThemeProvider manifest={sampleManifest}>
        <span data-testid="child">hi</span>
      </ThemeProvider>,
    );

    const child = screen.getByTestId('child');
    const root = child.parentElement as HTMLElement;

    expect(root).toHaveAttribute('data-tone', 'warm');
    expect(root.style.getPropertyValue('--bp-primary')).toBe('#1F5F4A');
    expect(root.style.getPropertyValue('--bp-accent')).toBe('#E4B04A');
    expect(root.style.getPropertyValue('--bp-bg')).toBe('#FBF8F2');
    expect(root.style.getPropertyValue('--bp-fg')).toBe('#17201C');
    expect(root.style.getPropertyValue('--bp-font-display')).toBe('Fraunces');
    expect(root.style.getPropertyValue('--bp-font-body')).toBe('Inter');
  });
});

describe('themeVars', () => {
  it('returns the same six variables as a plain style object', () => {
    const vars = themeVars(sampleManifest);
    expect(vars).toEqual({
      '--bp-primary': '#1F5F4A',
      '--bp-accent': '#E4B04A',
      '--bp-bg': '#FBF8F2',
      '--bp-fg': '#17201C',
      '--bp-font-display': 'Fraunces',
      '--bp-font-body': 'Inter',
    });
  });
});
