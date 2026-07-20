// agentRunsConsolidated.bySlug wire-projection slim (P-007,
// precompute-sync-reads-phase2). resolveRunsWithOutcome now ships only the
// fields the two consumers render — the runs grid (useHarnessRuns) and the
// Detail pane's per-feature run list. The 10 never-rendered fields (durationMs,
// the 5 token fields, backend, model, costIsEstimate, createdTs, updatedTs),
// mostly `:null` for the spawn-dominated window, are dropped. errorMessage is
// RENDERED (outcome-chip tooltip) so it stays.
//
// Source-pattern assertion (no DB) over the shared resolve function, the same
// approach as workspace-filter-coverage.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(resolve(HERE, 'index.ts'), 'utf8');

/** The body of the shared runs resolver, brace-balanced from its signature. */
function resolveRunsBody(): string {
  const start = INDEX.indexOf('async function resolveRunsWithOutcome');
  expect(start, 'resolveRunsWithOutcome must exist').toBeGreaterThan(-1);
  const openBrace = INDEX.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') {
      depth--;
      if (depth === 0) return INDEX.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces scanning resolveRunsWithOutcome');
}

describe('agentRunsConsolidated list slim (P-007)', () => {
  const body = resolveRunsBody();

  it('drops the never-rendered heavy/null-padding fields from the wire projection', () => {
    for (const dropped of [
      'durationMs:',
      'inputTokens:',
      'outputTokens:',
      'cacheReadTokens:',
      'cacheCreationTokens:',
      'backend:',
      'model:',
      'costIsEstimate:',
      'createdTs:',
      'updatedTs:',
    ]) {
      expect(body, `projection must no longer ship ${dropped}`).not.toContain(dropped);
    }
  });

  it('keeps the fields the grid + detail pane actually render', () => {
    for (const kept of [
      'runId:',
      'role:',
      'ts:',
      'featureId:',
      'sizeBytes:',
      'costUsd:',
      'running:',
      'lastEventTs:',
      'spawnStatus:',
      'exitCode:',
      'errorMessage:',
      'sessionId:',
    ]) {
      expect(body, `projection must still ship ${kept}`).toContain(kept);
    }
  });

  it('errorMessage stays capped at 1000 chars (P-004 tooltip-sufficient)', () => {
    expect(body).toMatch(/left\(\$\{spawn\.errorMessage\},\s*1000\)/);
  });
});
