import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as quant from '../web/lib/quant.js';
import { completeLinkageGroups } from '../src/pipeline/cluster.ts';
import { correlationMatrix } from '../src/pipeline/correlation.ts';
import { mean, pearson, simpleReturns } from '../src/pipeline/stats.ts';

/**
 * The point of the shared module is that there is one implementation, not two
 * that happen to agree. These assert that structurally, so a future "just copy
 * it into the browser for now" fails here rather than drifting silently.
 */
describe('shared quant module', () => {
  it('is the same function object the pipeline uses, not a copy', () => {
    expect(completeLinkageGroups).toBe(quant.completeLinkageGroups);
    expect(correlationMatrix).toBe(quant.correlationMatrix);
    expect(pearson).toBe(quant.pearson);
    expect(mean).toBe(quant.mean);
    expect(simpleReturns).toBe(quant.simpleReturns);
  });

  it('is type-checked, not merely allowed', () => {
    // checkJs is what keeps the numerical core inside the checked surface.
    // allowJs alone would import it without checking its body, and nothing
    // would fail to tell you.
    const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    expect(tsconfig.compilerOptions.checkJs).toBe(true);
    expect(tsconfig.include.some((p) => p.includes('web/lib'))).toBe(true);
  });

  it('ships no price-series decoder, so display data cannot reach a correlation', () => {
    // Putting a decoder beside pearson is what made feeding display-grade
    // prices into a correlation feel natural, and that produced numbers that
    // were plausible, self-consistent and wrong.
    // Declarations, not prose — the module's own comment explains why the
    // decoder is deliberately absent, and should not trip its own test.
    const source = readFileSync('web/lib/quant.js', 'utf8');
    expect(source).not.toMatch(/^\s*(export\s+)?(function|const|let|class)\s+\w*decode/im);
    expect(Object.keys(quant).some((k) => /decode/i.test(k))).toBe(false);
  });

  it('is importable by a browser without a build step', () => {
    const source = readFileSync('web/lib/quant.js', 'utf8');
    // Plain ESM only: no bare specifiers, no node builtins, no CommonJS.
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/^import .* from ['"][^./]/m);
  });
});
