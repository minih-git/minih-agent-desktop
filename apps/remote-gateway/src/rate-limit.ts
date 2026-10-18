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
/**
 * Credential attempts (account login, enroll by AccessKey) get their own,
 * deliberately tight bucket per client IP: an AccessKey is a bearer secret, so
 * the burst that is generous for commands is a brute-force budget for guesses
 * (security §9). Ten attempts, then one every five seconds.
 */
export const DEFAULT_CREDENTIAL_LIMIT: RateLimitPolicy = { capacity: 10, refillPerSecond: 0.2 };
/**
 * Account device requests get their own tighter bucket per client IP, separate
 * from ordinary account reads: asking the account's Hosts to confirm is a
 * fan-out to every one of them, so a flood of requests must not be able to bury
 * a Host or fill the Gateway's in-flight table. Six requests, then one every ten
 * seconds.
 */
export const DEFAULT_ACCOUNT_DEVICE_LIMIT: RateLimitPolicy = { capacity: 6, refillPerSecond: 0.1 };

type Bucket = { tokens: number; updatedAt: number };
type Projection = { key: string; policy: RateLimitPolicy; tokens: number; updatedAt: number };

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * One message for a `RATE_LIMITED` answer, whether the Gateway's own bucket or
 * the Router's `AUTH_LOCKED` lockout produced the hint. A hint-less lockout
 * still says "later" rather than telling the user the key is wrong.
 */
export function retryMessage(retryAfterMs?: number): string {
  return retryAfterMs === undefined ? "too many attempts; retry later" : `retry in ${retryAfterMs} ms`;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly device: RateLimitPolicy;
  private readonly ip: RateLimitPolicy;
  private readonly credential: RateLimitPolicy;
  private readonly accountDevice: RateLimitPolicy;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(
    options: {
      device?: RateLimitPolicy;
      ip?: RateLimitPolicy;
      credential?: RateLimitPolicy;
      accountDevice?: RateLimitPolicy;
      now?: () => number;
      maxKeys?: number;
    } = {},
  ) {
    this.device = options.device ?? DEFAULT_DEVICE_LIMIT;
    this.ip = options.ip ?? DEFAULT_IP_LIMIT;
    this.credential = options.credential ?? DEFAULT_CREDENTIAL_LIMIT;
    this.accountDevice = options.accountDevice ?? DEFAULT_ACCOUNT_DEVICE_LIMIT;
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
   * Both the principal and the IP bucket must allow the request; otherwise the
   * decision reports how long until the exhausted bucket refills one token.
   * `principalId` is a device id or an account session id, so one device and one
   * account session never share a bucket.
   */
  check(principalId: string | null, ip: string): RateLimitDecision {
    const now = this.now();
    const projections: Projection[] = [];
    if (principalId) projections.push(this.project(`principal:${principalId}`, this.device, now));
    projections.push(this.project(`ip:${ip}`, this.ip, now));
    return this.decide(projections);
  }

  /**
   * Credential attempts from one client IP. Account login and enroll by
   * AccessKey share the bucket, so spreading guesses across accounts does not
   * multiply the budget, and it keys on the resolved address so it follows a
   * caller that arrives through a trusted proxy (security §9).
   */
  checkCredential(ip: string): RateLimitDecision {
    return this.decide([this.project(`credential:${ip}`, this.credential, this.now())]);
  }

  /**
   * Account device requests from one client IP, in their own bucket. Kept
   * apart from the credential bucket so a device request cannot spend the
   * budget that stops AccessKey guessing, and from the command bucket so it
   * cannot spend the budget of the account's ordinary reads.
   */
  checkAccountDevice(ip: string): RateLimitDecision {
    return this.decide([this.project(`account-device:${ip}`, this.accountDevice, this.now())]);
  }

  private decide(projections: Projection[]): RateLimitDecision {
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
