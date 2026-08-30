import { describe, expect, it, vi } from 'vitest';
import { RateLimiter, mapPool } from '../src/fmp/client.ts';
import {
  RATE_LIMIT_BACKOFF_FACTOR,
  RATE_LIMIT_DECAY_AFTER_CLEAN,
  RATE_LIMIT_MAX_BACKOFF,
} from '../src/config.ts';

describe('RateLimiter backoff', () => {
  it('treats concurrent 429s as one episode rather than one each', () => {
    const rl = new RateLimiter(600);
    const before = rl.requestsPerMinute;

    // Every worker in flight sees the same rate-limit episode.
    const opened = Array.from({ length: 8 }, () => rl.throttle(60_000));

    expect(opened[0]).toBe(true);
    expect(opened.slice(1).every((v) => v === false)).toBe(true);
    expect(rl.episodes).toBe(1);
    // One easing step, not eight. Eight would compound to roughly 6x.
    expect(rl.requestsPerMinute).toBeCloseTo(before / RATE_LIMIT_BACKOFF_FACTOR, 0);
    expect(rl.requestsPerMinute).toBeGreaterThan(before / 2);
  });

  it('opens a new episode once the cooldown has elapsed', () => {
    const rl = new RateLimiter(600);
    expect(rl.throttle(10)).toBe(true);
    expect(rl.throttle(10)).toBe(false);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 50);
      expect(rl.throttle(10)).toBe(true);
      expect(rl.episodes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps the easing so the rate cannot collapse toward zero', () => {
    const rl = new RateLimiter(600);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 50; i++) {
        vi.setSystemTime(Date.now() + 1000);
        rl.throttle(10);
      }
      expect(rl.episodes).toBe(50);
      // Without a ceiling this would be a fraction of a request per minute.
      expect(rl.requestsPerMinute).toBeGreaterThanOrEqual(Math.floor(600 / RATE_LIMIT_MAX_BACKOFF));
    } finally {
      vi.useRealTimers();
    }
  });

  it('decays back toward the configured budget after clean responses', () => {
    const rl = new RateLimiter(600);
    rl.throttle(10);
    const eased = rl.requestsPerMinute;
    expect(eased).toBeLessThan(600);

    for (let i = 0; i < RATE_LIMIT_DECAY_AFTER_CLEAN * 4; i++) rl.recordSuccess();
    expect(rl.requestsPerMinute).toBe(600);
  });

  it('never decays past the configured budget', () => {
    const rl = new RateLimiter(600);
    for (let i = 0; i < 1000; i++) rl.recordSuccess();
    expect(rl.requestsPerMinute).toBe(600);
  });
});

describe('mapPool', () => {
  it('collects results keyed by item, independent of completion order', async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await mapPool(items, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 5));
      return n * 10;
    }, 3);
    expect(items.map((i) => out.get(i))).toEqual([10, 20, 30, 40, 50]);
  });

  it('propagates a worker rejection instead of draining the whole queue', async () => {
    let started = 0;
    const items = Array.from({ length: 500 }, (_, i) => i);
    const boom = new Error('revoked');

    await expect(
      mapPool(items, async (n) => {
        started++;
        if (n === 3) throw boom;
        await new Promise((r) => setTimeout(r, 1));
        return n;
      }, 4),
    ).rejects.toBe(boom);

    // The pool stops promptly rather than working through all 500 items.
    expect(started).toBeLessThan(100);
  });
});
