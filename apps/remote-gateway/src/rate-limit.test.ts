import { describe, expect, it } from "vitest";

import { DEFAULT_ACCOUNT_DEVICE_LIMIT, DEFAULT_CREDENTIAL_LIMIT, DEFAULT_DEVICE_LIMIT, RateLimiter } from "./rate-limit.js";

describe("rate limiting", () => {
  it("allows a burst up to the bucket capacity and then refuses", () => {
    let now = 0;
    const limiter = new RateLimiter({
      device: { capacity: 3, refillPerSecond: 1 },
      ip: { capacity: 100, refillPerSecond: 100 },
      now: () => now,
    });
    expect(limiter.check("dev_1", "10.0.0.1")).toEqual({ allowed: true });
    expect(limiter.check("dev_1", "10.0.0.1")).toEqual({ allowed: true });
    expect(limiter.check("dev_1", "10.0.0.1")).toEqual({ allowed: true });
    const denied = limiter.check("dev_1", "10.0.0.1");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterMs).toBe(1000);
    // One second refills exactly one token.
    now += 1000;
    expect(limiter.check("dev_1", "10.0.0.1")).toEqual({ allowed: true });
  });


  it("gives account device requests their own tighter bucket", () => {
    const now = 0;
    const limiter = new RateLimiter({ now: () => now });
    // A device request asks every Host of the account to interrupt its user, so
    // it is capped well below the command bucket and never spends the budget
    // that stops AccessKey guessing.
    for (let attempt = 0; attempt < DEFAULT_ACCOUNT_DEVICE_LIMIT.capacity; attempt += 1) {
      expect(limiter.checkAccountDevice("10.0.0.9")).toEqual({ allowed: true });
    }
    expect(limiter.checkAccountDevice("10.0.0.9").allowed).toBe(false);
    expect(limiter.checkCredential("10.0.0.9")).toEqual({ allowed: true });
    expect(limiter.check("dev_1", "10.0.0.9")).toEqual({ allowed: true });
    // Another caller has its own budget.
    expect(limiter.checkAccountDevice("10.0.0.10")).toEqual({ allowed: true });
  });
  it("rate limits per device and per IP independently", () => {
    const now = 0;
    const limiter = new RateLimiter({
      device: { capacity: 1, refillPerSecond: 0.001 },
      ip: { capacity: 2, refillPerSecond: 0.001 },
      now: () => now,
    });
    expect(limiter.check("dev_1", "10.0.0.1").allowed).toBe(true);
    expect(limiter.check("dev_1", "10.0.0.1").allowed).toBe(false); // device bucket empty
    expect(limiter.check("dev_2", "10.0.0.1").allowed).toBe(true); // same IP, second device
    expect(limiter.check("dev_3", "10.0.0.1").allowed).toBe(false); // IP bucket empty
    expect(limiter.check("dev_3", "10.0.0.2").allowed).toBe(true); // fresh IP
  });

  it("applies the IP bucket to unauthenticated callers such as pairing", () => {
    const now = 0;
    const limiter = new RateLimiter({ device: DEFAULT_DEVICE_LIMIT, ip: { capacity: 2, refillPerSecond: 0.001 }, now: () => now });
    expect(limiter.check(null, "10.0.0.1").allowed).toBe(true);
    expect(limiter.check(null, "10.0.0.1").allowed).toBe(true);
    expect(limiter.check(null, "10.0.0.1").allowed).toBe(false);
  });

  it("keeps its bucket table bounded", () => {
    const limiter = new RateLimiter({
      device: { capacity: 1, refillPerSecond: 1 },
      ip: { capacity: 1, refillPerSecond: 1 },
      maxKeys: 10,
    });
    for (let index = 0; index < 200; index += 1) limiter.check(`dev_${index}`, `10.0.0.${index % 250}`);
    // A new device still gets its own bucket after pruning.
    expect(limiter.check("dev_fresh", "10.9.9.9").allowed).toBe(true);
  });

  /**
   * Credential attempts (account login, enroll by AccessKey) get their own,
   * deliberately tight bucket per client IP (security §9, D666). A bucket shared
   * with command traffic would let a caller spend the command budget guessing a
   * key, and a per-account bucket would let one caller multiply the budget by
   * spreading guesses across accounts.
   */
  it("gives credential attempts their own per-IP budget", () => {
    let now = 0;
    const limiter = new RateLimiter({ credential: { capacity: 2, refillPerSecond: 0.5 }, now: () => now });
    expect(limiter.checkCredential("10.0.0.1").allowed).toBe(true);
    expect(limiter.checkCredential("10.0.0.1").allowed).toBe(true);
    const denied = limiter.checkCredential("10.0.0.1");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterMs).toBe(2000);
    // Another address has its own budget, and command traffic is unaffected.
    expect(limiter.checkCredential("10.0.0.2").allowed).toBe(true);
    expect(limiter.check("dev_1", "10.0.0.1").allowed).toBe(true);
    now += 2000;
    expect(limiter.checkCredential("10.0.0.1").allowed).toBe(true);
  });

  it("defaults the credential bucket far below the command budget", () => {
    const limiter = new RateLimiter({ now: () => 0 });
    for (let index = 0; index < DEFAULT_CREDENTIAL_LIMIT.capacity; index += 1) {
      expect(limiter.checkCredential("10.0.0.1").allowed).toBe(true);
    }
    expect(limiter.checkCredential("10.0.0.1").allowed).toBe(false);
  });
});
