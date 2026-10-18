/**
 * Token-bucket rate limits per device and per client IP (security §9). The
 * Gateway rejects before it opens a logical connection, so a flood never
 * reaches a Host.
 *
 * Both buckets are evaluated before either is consumed: an IP-limited request
 * does not burn the device's tokens, and vice versa.
 */
export type RateLimitPolicy = {
  /** Burst size. */
  capacity: number;
  /** Steady-state refill. */
  refillPerSecond: number;
};

export const DEFAULT_DEVICE_LIMIT: RateLimitPolicy = { capacity: 60, refillPerSecond: 30 };
export const DEFAULT_IP_LIMIT: RateLimitPolicy = { capacity: 120, refillPerSecond: 60 };

type Bucket = { tokens: number; updatedAt: number };
type Projection = { key: string; policy: RateLimitPolicy; tokens: number; updatedAt: number };

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly device: RateLimitPolicy;
  private readonly ip: RateLimitPolicy;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: { device?: RateLimitPolicy; ip?: RateLimitPolicy; now?: () => number; maxKeys?: number } = {}) {
    this.device = options.device ?? DEFAULT_DEVICE_LIMIT;
    this.ip = options.ip ?? DEFAULT_IP_LIMIT;
    this.now = options.now ?? (() => Date.now());
    this.maxKeys = options.maxKeys ?? 4096;
  }

  /** Refill a bucket for `now` without writing it back. */
  private project(key: string, policy: RateLimitPolicy, now: number): Projection {
    const bucket = this.buckets.get(key);
    const tokens = bucket
      ? Math.min(policy.capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * policy.refillPerSecond)
      : policy.capacity;
    return { key, policy, tokens, updatedAt: now };
  }

  private commit(projections: readonly Projection[]): void {
    for (const projection of projections) {
      this.buckets.set(projection.key, { tokens: projection.tokens, updatedAt: projection.updatedAt });
    }
    if (this.buckets.size > this.maxKeys) this.prune();
  }

  /** Drop the least recently used half once the table grows past its bound. */
  private prune(): void {
    const idle = [...this.buckets.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (const [key] of idle.slice(0, Math.ceil(idle.length / 2))) this.buckets.delete(key);
  }

  /**
   * Both the device and the IP bucket must allow the request; otherwise the
   * decision reports how long until the exhausted bucket refills one token.
   */
  check(deviceId: string | null, ip: string): RateLimitDecision {
    const now = this.now();
    const projections: Projection[] = [];
    if (deviceId) projections.push(this.project(`device:${deviceId}`, this.device, now));
    projections.push(this.project(`ip:${ip}`, this.ip, now));
    const exhausted = projections.find((projection) => projection.tokens < 1);
    if (exhausted) {
      this.commit(projections);
      const retryAfterMs = Math.ceil(((1 - exhausted.tokens) / Math.max(exhausted.policy.refillPerSecond, 1e-6)) * 1000);
      return { allowed: false, retryAfterMs };
    }
    for (const projection of projections) projection.tokens -= 1;
    this.commit(projections);
    return { allowed: true };
  }
}
