import {
  API_KEY_ENV,
  CONCURRENCY,
  FMP_BASE,
  MAX_RETRIES,
  RATE_LIMIT_BACKOFF_FACTOR,
  RATE_LIMIT_COOLDOWN_MS,
  RATE_LIMIT_DECAY_AFTER_CLEAN,
  RATE_LIMIT_MAX_BACKOFF,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_PER_MIN,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_MS,
} from '../config.ts';
import type { AdjustedBar, History, ScreenerRow } from './types.ts';

/**
 * Thrown when a request could not be completed after every retry. This is
 * deliberately distinct from "the API answered, and the answer was empty":
 * a dry run against the live API showed a contiguous block of ~70 symbols
 * failing on transient network errors. Treating those as "no data" would
 * silently shrink the universe and change the ranking between runs, so an
 * unrecovered failure is an error, never a quiet exclusion.
 */
export class FmpFetchError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`FMP request failed after ${MAX_RETRIES} attempts: ${path} — ${message}`);
    this.name = 'FmpFetchError';
    this.path = path;
  }
}

/** Thrown when the API key is absent or rejected. The screen has no fallback source. */
export class FmpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FmpAuthError';
  }
}

function requireApiKey(): string {
  const key = process.env[API_KEY_ENV];
  if (!key || key.trim() === '') {
    throw new FmpAuthError(
      `No FMP API key found in $${API_KEY_ENV}. This project reads market data exclusively ` +
        `from Financial Modeling Prep and has no fallback provider. Set $${API_KEY_ENV} and re-run.`,
    );
  }
  return key.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Non-2xx responses that will never succeed on retry. */
function isPermanent(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 404;
}

/**
 * Spaces requests across the whole client so the concurrent pool cannot exceed
 * the API's per-minute budget.
 *
 * Slots are reserved rather than merely counted: each caller claims the next
 * free instant and waits for it, so a burst of workers self-arranges into an
 * even stream instead of all firing at once.
 *
 * Backoff is scoped to a rate-limit *episode*, not to each 429 response. With
 * N workers in flight one episode produces up to N responses, and easing the
 * rate once per response compounds — at concurrency 8 that is a 6x cut from a
 * single episode, and repeated episodes drive the budget to nearly zero. So
 * the first report opens an episode window and later reports inside it are
 * ignored, the easing is clamped to a ceiling, and a stretch of clean
 * responses decays the rate back toward the configured budget.
 */
export class RateLimiter {
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;
  private intervalMs: number;
  private nextSlot = 0;
  /** End of the current rate-limit episode; reports before this are duplicates. */
  private episodeUntil = 0;
  private cleanRun = 0;
  /** Distinct rate-limit episodes observed, as opposed to 429 responses. */
  episodes = 0;

  constructor(perMinute: number) {
    this.baseIntervalMs = 60_000 / Math.max(1, perMinute);
    this.intervalMs = this.baseIntervalMs;
    this.maxIntervalMs = this.baseIntervalMs * RATE_LIMIT_MAX_BACKOFF;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  }

  /**
   * Reports a 429. Returns true when this opened a new episode, false when it
   * is another worker reporting the episode already in progress.
   */
  throttle(cooldownMs: number): boolean {
    const now = Date.now();
    // A dedicated episode window, kept separate from `nextSlot`: the scheduling
    // cursor normally sits in the future under load, so it cannot distinguish
    // a fresh episode from an ongoing one.
    if (now < this.episodeUntil) return false;

    this.episodes++;
    this.episodeUntil = now + cooldownMs;
    this.nextSlot = Math.max(this.nextSlot, now + cooldownMs);
    this.intervalMs = Math.min(this.intervalMs * RATE_LIMIT_BACKOFF_FACTOR, this.maxIntervalMs);
    this.cleanRun = 0;
    return true;
  }

  /** Records a clean response, decaying the rate back toward the budget. */
  recordSuccess(): void {
    if (this.intervalMs <= this.baseIntervalMs) return;
    if (++this.cleanRun < RATE_LIMIT_DECAY_AFTER_CLEAN) return;
    this.cleanRun = 0;
    this.intervalMs = Math.max(this.baseIntervalMs, this.intervalMs / RATE_LIMIT_BACKOFF_FACTOR);
  }

  get requestsPerMinute(): number {
    return Math.round(60_000 / this.intervalMs);
  }
}

export class FmpClient {
  private readonly key: string;
  private readonly limiter: RateLimiter;
  /** Requests that returned 200 with an empty body — genuinely dataless symbols. */
  readonly emptyResponses: string[] = [];
  /** 429 responses seen. Several can belong to one rate-limit episode. */
  rateLimitHits = 0;

  constructor(key?: string, perMinute: number = RATE_LIMIT_PER_MIN) {
    this.key = key ?? requireApiKey();
    this.limiter = new RateLimiter(perMinute);
  }

  get requestsPerMinute(): number {
    return this.limiter.requestsPerMinute;
  }

  /** Distinct rate-limit episodes, as opposed to individual 429 responses. */
  get rateLimitEpisodes(): number {
    return this.limiter.episodes;
  }

  private url(path: string, params: Record<string, string | number>): string {
    const u = new URL(FMP_BASE + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    u.searchParams.set('apikey', this.key);
    return u.toString();
  }

  private async getJson<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const url = this.url(path, params);
    let lastError = '';
    // A 429 is transient and self-healing, so it gets a longer retry budget
    // than a generic failure; without this, rate limiting silently removes
    // whole alphabetical blocks of the universe.
    let budget = MAX_RETRIES;

    for (let attempt = 0; attempt < budget; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

        if (res.ok) {
          this.limiter.recordSuccess();
          return (await res.json()) as T;
        }

        const body = (await res.text().catch(() => '')).slice(0, 200);
        if (res.status === 401 || res.status === 403) {
          throw new FmpAuthError(
            `FMP rejected the API key in $${API_KEY_ENV} (HTTP ${res.status}) for ${path}. ${body}`,
          );
        }
        if (res.status === 429) {
          this.rateLimitHits++;
          budget = Math.max(budget, RATE_LIMIT_MAX_RETRIES);
          this.limiter.throttle(RATE_LIMIT_COOLDOWN_MS);
          lastError = `HTTP 429 (rate limited): ${body}`;
          continue;
        }
        if (isPermanent(res.status)) {
          throw new FmpFetchError(path, `HTTP ${res.status} (not retryable): ${body}`);
        }
        lastError = `HTTP ${res.status}: ${body}`;
      } catch (err) {
        if (err instanceof FmpAuthError || err instanceof FmpFetchError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (attempt < budget - 1) {
        // Exponential backoff with jitter. Jitter affects timing only; the
        // pipeline's output never depends on completion order.
        const backoff = RETRY_BASE_MS * 2 ** attempt;
        await sleep(backoff + Math.random() * backoff);
      }
    }
    throw new FmpFetchError(path, lastError);
  }

  /** Verifies the key works before doing thousands of requests with it. */
  async verifyAuth(): Promise<void> {
    const rows = await this.getJson<unknown[]>('/profile', { symbol: 'AAPL' });
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new FmpAuthError(
        `FMP authenticated but returned no data for a known-good symbol. Refusing to continue.`,
      );
    }
  }

  async screener(exchange: string, minMarketCap: number, minPrice: number): Promise<ScreenerRow[]> {
    return this.getJson<ScreenerRow[]>('/company-screener', {
      exchange,
      isEtf: 'false',
      isFund: 'false',
      isActivelyTrading: 'true',
      marketCapMoreThan: minMarketCap,
      priceMoreThan: minPrice,
      limit: 10000,
    });
  }

  /**
   * Split- and dividend-adjusted daily bars, normalized to oldest-first.
   * The `full` endpoint exposes no adjusted close, so it cannot be used for
   * momentum or correlation.
   */
  async history(symbol: string, from: string, to: string): Promise<History> {
    const bars = await this.getJson<AdjustedBar[]>('/historical-price-eod/dividend-adjusted', {
      symbol,
      from,
      to,
    });
    if (!Array.isArray(bars) || bars.length === 0) {
      this.emptyResponses.push(symbol);
      return { symbol, bars: [] };
    }
    // FMP returns newest-first; every downstream calculation assumes oldest-first.
    const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { symbol, bars: sorted };
  }
}

/**
 * Runs `worker` over `items` with bounded concurrency, collecting results into
 * a Map keyed by item. Callers must iterate the Map through their own sorted
 * key list — never in completion order — so results do not depend on which
 * request happened to finish first.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrency: number = CONCURRENCY,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<T, R>> {
  const out = new Map<T, R>();
  let next = 0;
  let done = 0;
  const aborted: unknown[] = [];

  const runner = async (): Promise<void> => {
    // A worker rejection stops the pool promptly instead of letting the rest of
    // the queue drain, and is re-thrown to the caller once every runner has
    // settled — so a fatal error (a revoked key, say) surfaces immediately and
    // without leaving unhandled rejections behind it.
    while (aborted.length === 0) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      try {
        out.set(item, await worker(item));
      } catch (err) {
        aborted.push(err);
        return;
      }
      done++;
      if (onProgress && (done % 100 === 0 || done === items.length)) onProgress(done, items.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  if (aborted.length > 0) throw aborted[0];
  return out;
}
