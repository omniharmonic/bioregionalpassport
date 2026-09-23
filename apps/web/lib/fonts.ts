import { Fraunces, Inter, Space_Grotesk } from 'next/font/google';

/**
 * Self-hosted Google fonts exposed as CSS variables. Manifests name fonts by
 * family ("Fraunces"); `fontStack` maps that name onto the hashed family
 * next/font generates so `ThemeProvider`'s `--bp-font-*` variables resolve.
 */
export const fraunces = Fraunces({ subsets: ['latin'], display: 'swap', variable: '--font-fraunces', axes: ['opsz', 'SOFT'] });
export const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
export const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], display: 'swap', variable: '--font-space-grotesk' });

export const fontVariables = [fraunces.variable, inter.variable, spaceGrotesk.variable].join(' ');
