/**
 * Ultra-low latency SWR Cache and Debounced Search Manager with AbortController
 * Built for instant UI responses and resilient weak-network performance.
 */

export interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

export class SWRClientCache<T = any> {
  private memoryCache = new Map<string, CacheEntry<T>>();
  private maxMemoryEntries: number;
  private defaultTtlMs: number;

  constructor(maxMemoryEntries = 100, defaultTtlMs = 1000 * 5) {
    this.maxMemoryEntries = maxMemoryEntries;
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Retrieves data from in-memory cache.
   * Returns { data, isStale } for stale-while-revalidate execution.
   */
  public get(key: string, customTtl?: number): { data: T | null; isStale: boolean } {
    const cleanKey = key.trim();
    const ttl = customTtl ?? this.defaultTtlMs;

    const entry = this.memoryCache.get(cleanKey);
    if (!entry) {
      return { data: null, isStale: true };
    }

    const age = Date.now() - entry.timestamp;
    const isStale = age > ttl;

    return { data: entry.data, isStale };
  }

  /**
   * Writes data to in-memory cache
   */
  public set(key: string, data: T): void {
    const cleanKey = key.trim();
    const entry: CacheEntry<T> = {
      timestamp: Date.now(),
      data,
    };

    if (this.memoryCache.size >= this.maxMemoryEntries) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey) this.memoryCache.delete(oldestKey);
    }
    this.memoryCache.set(cleanKey, entry);
  }

  /**
   * Deletes a specific key from cache
   */
  public delete(key: string): void {
    const cleanKey = key.trim();
    this.memoryCache.delete(cleanKey);
  }

  /**
   * Invalidates a specific key or all keys matching a prefix
   */
  public invalidate(prefix?: string): void {
    if (!prefix) {
      this.memoryCache.clear();
      return;
    }

    for (const k of Array.from(this.memoryCache.keys())) {
      if (k.startsWith(prefix)) {
        this.memoryCache.delete(k);
      }
    }
  }
}

/**
 * Advanced Debounced Network & Search Controller with automatic AbortController request cancellation.
 * Prevents race conditions and eliminates unnecessary server load over slow or flapping networks.
 */
export class DebouncedSearchController {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private activeAbortController: AbortController | null = null;
  private delayMs: number;

  constructor(delayMs = 250) {
    this.delayMs = delayMs;
  }

  public execute<T>(
    fetcher: (signal: AbortSignal) => Promise<T>,
    onSuccess: (result: T) => void,
    onError?: (err: any) => void
  ): void {
    // 1. Cancel pending debounce timer
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // 2. Instantly cancel any in-flight network requests from previous keystroke
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    // 3. Schedule new debounced request
    this.timeoutId = setTimeout(async () => {
      this.activeAbortController = new AbortController();
      const signal = this.activeAbortController.signal;

      try {
        const result = await fetcher(signal);
        if (!signal.aborted) {
          onSuccess(result);
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || signal.aborted) {
          // Stale request cancelled cleanly
          return;
        }
        if (onError) onError(err);
      } finally {
        if (this.activeAbortController?.signal === signal) {
          this.activeAbortController = null;
        }
      }
    }, this.delayMs);
  }

  public cancel(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }
}

/**
 * Fast client-side multi-token indexing for instant (<1ms) search across in-memory collections
 */
export function fastFilterCollection<T>(
  items: T[],
  query: string,
  extractSearchText: (item: T) => string
): T[] {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return items;

  const tokens = cleanQuery.split(/[\s,?.!]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return items;

  return items.filter((item) => {
    const text = extractSearchText(item).toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
}

// Global shared instances for application modules
export const globalAppCache = new SWRClientCache();
