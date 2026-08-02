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

/**
 * The OUTER wire projection only — `const q = db.select({ … })` up to `.from(t)`.
 * Distinct from {@link resolveRunsBody}, which also contains the `spawn`
 * subquery's own select: several column names (harnessSlug, runId, featureId)
 * appear in BOTH, so a whole-body substring check cannot tell "we stopped
 * shipping this to the client" from "we still read it from the table".
 */
function outerProjection(): string {
  const body = resolveRunsBody();
  const start = body.indexOf('const q = db');
  expect(start, 'the outer projection must still be built as `const q = db`').toBeGreaterThan(-1);
  const end = body.indexOf('.from(t)', start);
  expect(end, 'the outer projection must still select .from(t)').toBeGreaterThan(start);
  return body.slice(start, end);
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

describe('agentRunsConsolidated list slim (P-028 / D-022)', () => {
  it('does not ship harnessSlug to the client (redundant with the query arg)', () => {
    // Still READ from the tables (the spawn subquery + the join/scoping predicates
    // need it) — just not projected onto the wire. Neither consumer type declares
    // it: useHarnessData's SyncAgentRow, DetailPanel's RunRow.
    expect(outerProjection(), 'harnessSlug must not be in the wire projection').not.toContain(
      'harnessSlug:',
    );
    expect(resolveRunsBody(), 'the spawn subquery must still read harness_slug').toContain(
      'harnessSlug: s.harnessSlug',
    );
  });

  it('nulls errorMessage on rows that can never render it (featureId is null)', () => {
    // errorMessage renders ONLY via run-outcome's `detail` inside DetailPanel's
    // `featureRuns` = runs.filter(r => r.featureId === feature.id) — so a null
    // featureId makes it unreachable. 464,840 B of the measured 530,216 B rode on
    // exactly those rows.
    const proj = outerProjection();
    const errorMessage = proj.slice(proj.indexOf('errorMessage:'));
    expect(errorMessage, 'errorMessage must be gated on the coalesced featureId').toMatch(
      /case[\s\S]*featureIdExpr\}\s*is null then null[\s\S]*left\(\$\{spawn\.errorMessage\},\s*1000\)/,
    );
  });

  it('still ships featureId itself (the gate would be unusable otherwise)', () => {
    expect(outerProjection()).toContain('featureId:');
  });
});
