import { ResponseCacheYDB, ResponseCacheYDBOptions } from './cache-ydb.js';

export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
  expiresAt?: number;
  tags?: string[];
}

export interface ResponseCache {
  get(key: string): Promise<CachedResponse | null>;
  set(
    key: string,
    response: CachedResponse,
    options?: {
      ttlSeconds?: number;
      tags?: string[];
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  purgeTag(tag: string): Promise<void>;
  close?(): Promise<void>;
}

export interface ResponseCacheOptions {
  enabled: boolean;
  driver?: 'memory' | 'ydb';
  defaultTtlSeconds?: number;
  ydb?: ResponseCacheYDBOptions;
}

interface MemoryEntry {
  value: CachedResponse;
  expiresAt: number;
}

export class InMemoryResponseCache implements ResponseCache {
  private readonly cache = new Map<string, MemoryEntry>();
  private readonly defaultTtlSeconds: number;
  private readonly maxEntries: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;

  constructor(defaultTtlSeconds = 60, maxEntries = 1000, sweepIntervalMs = 60_000) {
    this.defaultTtlSeconds = defaultTtlSeconds;
    this.maxEntries = maxEntries;
    this.sweepIntervalMs = sweepIntervalMs;
  }

  async get(key: string): Promise<CachedResponse | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(
    key: string,
    response: CachedResponse,
    options?: {
      ttlSeconds?: number;
      tags?: string[];
    },
  ): Promise<void> {
    this.sweepIfNeeded();
    this.evictIfFull();

    const ttlMs = (options?.ttlSeconds ?? this.defaultTtlSeconds) * 1000;
    this.cache.set(key, {
      value: {
        ...response,
        tags: options?.tags ?? response.tags,
        expiresAt: Date.now() + ttlMs,
      },
      expiresAt: Date.now() + ttlMs,
    });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async purgeTag(tag: string): Promise<void> {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.value.tags?.includes(tag)) {
        this.cache.delete(key);
      }
    }
  }

  private sweepIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastSweepAt < this.sweepIntervalMs) {
      return;
    }
    this.lastSweepAt = now;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  private evictIfFull(): void {
    if (this.cache.size < this.maxEntries) {
      return;
    }
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      this.cache.delete(firstKey);
    }
  }
}

class NoOpResponseCache implements ResponseCache {
  async get(): Promise<null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async purgeTag(): Promise<void> {}
}

export function createResponseCache(options: ResponseCacheOptions): ResponseCache {
  if (!options.enabled) {
    return new NoOpResponseCache();
  }

  if (options.driver === 'ydb' && options.ydb) {
    return new ResponseCacheYDB(options.ydb);
  }

  return new InMemoryResponseCache(options.defaultTtlSeconds ?? 60);
}
