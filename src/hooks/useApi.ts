// ===================================================================
// useApi HOOK - Lightweight data fetcher with auth + user headers
// ===================================================================

import { useCallback, useEffect, useState, useRef } from 'react';
import { sanitizeAuthToken } from '../utils/auth.js';
import { Identity } from '../types.js';

export interface ApiResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

interface UseApiOptions {
  /** Auto-refresh interval in ms (0 = no auto) */
  refreshMs?: number;
  /** Skip if true (e.g., when not authenticated) */
  skip?: boolean;
}

export function useApi<T = any>(
  path: string | null,
  identity: Identity,
  authToken?: string,
  options: UseApiOptions = {},
): ApiResult<T> {
  const { refreshMs = 0, skip = false } = options;
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(!skip && path !== null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const fetchData = useCallback(async () => {
    if (!path || skip) {
      setIsLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      const cleanToken = sanitizeAuthToken(authToken);
      if (cleanToken) headers['Authorization'] = `Bearer ${cleanToken}`;
      if (identity?.id && identity.id !== 'UNKNOWN') headers['X-User-Id'] = identity.id;
      const res = await fetch(path, { headers, cache: 'no-store' });
      if (seq !== seqRef.current) return; // stale
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (seq !== seqRef.current) return;
      setData(json);
    } catch (e: any) {
      if (seq !== seqRef.current) return;
      setError(e?.message || 'Fetch failed');
      setData(null);
    } finally {
      if (seq === seqRef.current) setIsLoading(false);
    }
  }, [path, identity?.id, authToken, skip]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (refreshMs > 0) {
      const id = setInterval(fetchData, refreshMs);
      return () => clearInterval(id);
    }
  }, [refreshMs, fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}
