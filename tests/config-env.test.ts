import { describe, expect, it, vi } from 'vitest';

/**
 * The rate-limit budget is read from the environment at import time, so these
 * load a fresh module per case. A malformed value must fall back to the
 * default rather than yielding NaN — a NaN interval makes every wait
 * comparison false, which disables rate limiting entirely and runs the pool at
 * the rate that trips HTTP 429.
 */
async function rateLimitWith(value: string | undefined): Promise<number> {
  const previous = process.env.FMP_RATE_LIMIT_PER_MIN;
  if (value === undefined) delete process.env.FMP_RATE_LIMIT_PER_MIN;
  else process.env.FMP_RATE_LIMIT_PER_MIN = value;
  try {
    vi.resetModules();
    const mod = await import('../src/config.ts');
    return mod.RATE_LIMIT_PER_MIN as number;
  } finally {
    vi.resetModules();
    if (previous === undefined) delete process.env.FMP_RATE_LIMIT_PER_MIN;
    else process.env.FMP_RATE_LIMIT_PER_MIN = previous;
  }
}

describe('FMP_RATE_LIMIT_PER_MIN parsing', () => {
  it('uses the default when unset', async () => {
    expect(await rateLimitWith(undefined)).toBe(550);
  });

  it('accepts a valid override', async () => {
    expect(await rateLimitWith('300')).toBe(300);
  });

  it.each([['550/min'], ['abc'], [''], ['   '], ['0'], ['-100'], ['NaN'], ['Infinity']])(
    'falls back to the default for %j rather than disabling the limiter',
    async (value) => {
      const rate = await rateLimitWith(value);
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBe(550);
    },
  );
});
