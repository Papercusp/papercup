// featuresConsolidated.bySlug summary-slim + featuresConsolidated.detail
// on-demand read (P-007, precompute-sync-reads-phase2). bySlug drops the per-row
// `summary` at the sync boundary (the grid never renders it — only the Detail
// pane's Description prose, for the ONE selected feature); featuresConsolidated
// .detail serves that single feature's full row (with summary) on demand.
//
// Mirrors the workItems.byHarness/.detail split (P-006). The featuresConsolidated
// resolvers read the drizzle chain directly, so — like workspace-filter-coverage
// — this asserts via registration + source-pattern rather than a DB run.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { knownQueryNamesV2 } from './index';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, 'index.ts'), 'utf8');

/** Extract a single resolver block's source by its query-name key. */
function resolverBlock(name: string): string {
  const start = INDEX.indexOf(`'${name}': {`);
  expect(start, `resolver block '${name}' must exist`).toBeGreaterThan(-1);
  // Walk to the matching close by brace balance from the block-open brace.
  const openBrace = INDEX.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') {
      depth--;
      if (depth === 0) return INDEX.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces scanning block '${name}'`);
}

describe('featuresConsolidated P-007 (bySlug summary-slim + detail)', () => {
  it('registers both query names', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('featuresConsolidated.bySlug');
    expect(names).toContain('featuresConsolidated.detail');
  });

  it('bySlug projection no longer selects the heavy per-row summary', () => {
    const block = resolverBlock('featuresConsolidated.bySlug');
    // The projection is an explicit column list; summary must be gone from it.
    expect(block).not.toMatch(/summary:\s*t\.summary/);
    // But the light rendered fields the grid DOES use stay present.
    expect(block).toMatch(/title:\s*t\.title/);
    expect(block).toMatch(/status:\s*t\.status/);
    expect(block).toMatch(/workingUsers:\s*t\.workingUsers/);
  });

  it('detail resolver serves the single feature WITH summary, workspace-scoped', () => {
    const block = resolverBlock('featuresConsolidated.detail');
    // Carries the summary bySlug dropped.
    expect(block).toMatch(/summary:\s*t\.summary/);
    // Single-feature keyed read.
    expect(block).toMatch(/eq\(t\.featureId,\s*featureId\)/);
    expect(block).toMatch(/\.limit\(1\)/);
    // Tenant-scoped (EI-1763) — must thread workspaceId so it can't cross-leak.
    expect(block).toMatch(/eq\(t\.workspaceId,\s*workspaceId\)/);
    expect(block).toMatch(/workspaceId:\s*z\.string\(\)\.optional\(\)/);
  });
});
