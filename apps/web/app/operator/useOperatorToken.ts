'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'bp-operator-token';

/**
 * The operator key for this browser tab only: React state, mirrored to
 * `sessionStorage` so it survives navigation between `/operator` pages without
 * being retyped, but never a permanent store (cleared when the tab closes, and
 * never written anywhere but this one key). It is attached to `/api/control/*`
 * requests as `Authorization: Bearer <token>` and never persisted server-side.
 */
export function useOperatorToken() {
  const [token, setTokenState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setTokenState(sessionStorage.getItem(STORAGE_KEY));
    } catch {
      // Private browsing / blocked storage: the tab just asks again.
    } finally {
      setHydrated(true);
    }
  }, []);

  const setToken = useCallback((next: string | null) => {
    setTokenState(next);
    try {
      if (next) sessionStorage.setItem(STORAGE_KEY, next);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore: the token still works for this render via state.
    }
  }, []);

  return { token, setToken, hydrated };
}
