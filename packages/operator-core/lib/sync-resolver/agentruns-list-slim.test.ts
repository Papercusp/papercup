// agentRunsConsolidated.bySlug wire-projection slim (P-007,
// precompute-sync-reads-phase2). agent-runs-list-query now ships only the
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
const SOURCE = readFileSync(resolve(HERE, 'agent-runs-list-query.ts'), 'utf8');

/**
 * The OUTER wire projection only — `const q = db.select({ … })` up to `.from(t)`.
 * Distinct from {@link resolveRunsBody}, which also contains the `spawn`
 * subquery's own select: several column names (harnessSlug, runId, featureId)
 * appear in BOTH, so a whole-body substring check cannot tell "we stopped
 * shipping this to the client" from "we still read it from the table".
 */
function outerProjection(): string {
  const start = SOURCE.indexOf('const mapRow');
  expect(start, 'the wire mapper must exist').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n});', start);
  expect(end, 'the wire mapper must close').toBeGreaterThan(start);
  return SOURCE.slice(start, end + 4);
}

describe('agentRunsConsolidated list slim (P-007)', () => {
  const body = SOURCE;

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
    expect(body).toMatch(/left\(sa\.error_message,\s*1000\)/);
  });
});

describe('agentRunsConsolidated list slim (P-028 / D-022)', () => {
  it('does not ship harnessSlug to the client (redundant with the query arg)', () => {
    // Still READ from the tables (the spawn subquery + the join/scoping predicates
    // need it) — just not projected onto the wire. Neither consumer type declares
    // it: useHarnessData's SyncAgentRow, DetailPanel's RunRow.
    expect(outerProjection(), 'harnessSlug must not be in the wire projection').not.toContain(
      'harnessSlug:',
    );
    expect(SOURCE, 'the spawn subquery must still read harness_slug').toContain('sa.harness_slug');
  });

  it('nulls errorMessage on rows that can never render it (featureId is null)', () => {
    // errorMessage renders ONLY via run-outcome's `detail` inside DetailPanel's
    // `featureRuns` = runs.filter(r => r.featureId === feature.id) — so a null
    // featureId makes it unreachable. 464,840 B of the measured 530,216 B rode on
    // exactly those rows.
    expect(SOURCE, 'errorMessage must be gated on the coalesced featureId').toMatch(
      /CASE[\s\S]*coalesce\(ar\.feature_id, sa\.feature_id\) IS NULL THEN NULL[\s\S]*left\(sa\.error_message, 1000\)/,
    );
  });

  it('still ships featureId itself (the gate would be unusable otherwise)', () => {
    expect(outerProjection()).toContain('featureId:');
  });

  it('joins legacy/live runs on workspace as well as harness and run id', () => {
    expect(SOURCE).toContain('ON sa.workspace_id = ar.workspace_id');
    expect(SOURCE).toContain('AND sa.harness_slug = ar.harness_slug');
    expect(SOURCE).toContain('AND sa.run_id = ar.run_id');
  });
});
