import {
  BLEND_WEIGHT,
  HORIZON_KEYS,
  MODES,
  SCORE_KEYS,
  TOP_N,
  viewId,
  type HorizonKey,
  type Mode,
  type ScoreKey,
  type ViewId,
} from '../config.ts';
import type { StockMetrics } from './momentum.ts';
import { crossSectionalNormalize } from './normalize.ts';

export interface RankedEntry {
  rank: number;
  symbol: string;
  /** The figure this view ranks and displays. */
  score: number;
  /** Normalized per-horizon components; present only on blended views. */
  components?: Record<HorizonKey, number>;
}

export interface ViewResult {
  id: ViewId;
  scoreKey: ScoreKey;
  mode: Mode;
  ranked: RankedEntry[];
  /** Size of the eligible cross-section the ranking was drawn from. */
  universeSize: number;
}

/** The raw figure a horizon contributes under a given mode. */
function horizonValue(m: StockMetrics, horizon: HorizonKey, mode: Mode): number {
  const h = m.horizons[horizon];
  return mode === 'raw' ? h.momentum : h.volAdjusted;
}

/**
 * Builds all eight views from the eligible cross-section.
 *
 * `metrics` must already be ordered deterministically (by symbol); every
 * normalization sums over that fixed order so results do not drift with
 * floating point accumulation.
 */
export function buildViews(metrics: readonly StockMetrics[], topN: number = TOP_N): Map<ViewId, ViewResult> {
  const out = new Map<ViewId, ViewResult>();

  for (const mode of MODES) {
    // Normalize each horizon across the whole eligible universe first; the
    // blend is the equal-weight mean of those normalized scores.
    const normalized = {} as Record<HorizonKey, number[]>;
    for (const horizon of HORIZON_KEYS) {
      normalized[horizon] = crossSectionalNormalize(metrics.map((m) => horizonValue(m, horizon, mode)));
    }

    for (const scoreKey of SCORE_KEYS) {
      const rows = metrics.map((m, i) => {
        if (scoreKey !== 'blend') {
          return { symbol: m.symbol, score: horizonValue(m, scoreKey, mode) };
        }
        let blended = 0;
        const components = {} as Record<HorizonKey, number>;
        for (const horizon of HORIZON_KEYS) {
          const z = (normalized[horizon] as number[])[i] as number;
          components[horizon] = z;
          blended += BLEND_WEIGHT * z;
        }
        return { symbol: m.symbol, score: blended, components };
      });

      // Descending by score; ties broken on symbol so the order is total.
      rows.sort((a, b) => (b.score - a.score) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

      const ranked: RankedEntry[] = rows.slice(0, topN).map((r, i) => {
        const entry: RankedEntry = { rank: i + 1, symbol: r.symbol, score: r.score };
        if (r.components) entry.components = r.components;
        return entry;
      });

      const id = viewId(scoreKey, mode);
      out.set(id, { id, scoreKey, mode, ranked, universeSize: metrics.length });
    }
  }
  return out;
}
