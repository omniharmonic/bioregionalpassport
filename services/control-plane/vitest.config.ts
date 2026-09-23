import { defineConfig } from 'vitest/config';

// PGlite (WASM Postgres) cold-starts slowly on shared CI runners; give DB-backed tests room.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
