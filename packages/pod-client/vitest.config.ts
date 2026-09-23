import { defineConfig } from 'vitest/config';

// PGlite-backed tests (the wallet against the real pod VTA handlers) need generous timeouts on CI runners.
export default defineConfig({ test: { environment: 'node', testTimeout: 60_000, hookTimeout: 60_000 } });
