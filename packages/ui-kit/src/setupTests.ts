// Registered via vitest.config.ts `test.setupFiles`. Imports `expect` and the
// jest-dom matchers both resolved from this package's own node_modules (not
// jest-dom's `./vitest` re-export, which resolves a hoisted `vitest` copy
// from the workspace root and can end up extending a different `expect`
// instance than the one test files import).
import { afterEach, expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

expect.extend(matchers);

// `@testing-library/react`'s auto-cleanup normally hooks a global `afterEach`,
// which isn't available with `test.globals: false`; register it explicitly
// so each test starts from an empty document.
afterEach(() => {
  cleanup();
});
