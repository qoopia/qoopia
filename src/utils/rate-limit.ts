/**
 * In-memory sliding-window rate limiter keyed by IP.
 * No dependencies. Cleans up expired entries on each check.
 */

interface Bucket {
  hits: number[];
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxHits: number;
  private lastCleanup = Date.now();

  constructor(opts: { windowMs: number; maxHits: number }) {
    this.windowMs = opts.windowMs;
    this.maxHits = opts.maxHits;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    if (now - this.lastCleanup > 60_000) {
      this.cleanup(cutoff);
      this.lastCleanup = now;
    }

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.buckets.set(key, bucket);
    }

    bucket.hits = bucket.hits.filter((t) => t > cutoff);

    if (bucket.hits.length >= this.maxHits) return false;

    bucket.hits.push(now);
    return true;
  }

  retryAfterSec(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.hits.length === 0) return 0;
    const oldest = bucket.hits[0]!;
    const unlockAt = oldest + this.windowMs;
    return Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000));
  }

  private cleanup(cutoff: number) {
    for (const [key, bucket] of this.buckets) {
      bucket.hits = bucket.hits.filter((t) => t > cutoff);
      if (bucket.hits.length === 0) this.buckets.delete(key);
    }
  }
}

/** General API: 100 requests per minute per IP */
export const apiLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 100 });

/** Auth endpoints: 20 per minute per IP */
export const authLimiter = new RateLimiter({ windowMs: 60_000, maxHits: 20 });
