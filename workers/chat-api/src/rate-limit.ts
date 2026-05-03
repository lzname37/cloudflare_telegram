type RateBucket = {
  windowStart: number;
  count: number;
};

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const current = this.buckets.get(key);
    if (!current || now - current.windowStart >= windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      this.compact(now, windowMs);
      return true;
    }

    if (current.count >= limit) {
      return false;
    }

    current.count += 1;
    return true;
  }

  private compact(now: number, windowMs: number): void {
    if (this.buckets.size < 1000) {
      return;
    }

    const expireBefore = now - windowMs * 2;
    for (const [key, value] of this.buckets.entries()) {
      if (value.windowStart < expireBefore) {
        this.buckets.delete(key);
      }
    }
  }
}
