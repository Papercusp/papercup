/**
 * drill-judging.integration.test.ts — the FB-23 (P-048) judging round-trip against
 * a real MIGRATED Postgres: red-queen drill rows written through lib/red-queen/store
 * are LOADED by the gym:signals tool (loadDrillOutcomes) and scored by the
 * drill-ground-truth signals (drillResolveRate / drillTriageAccuracy / drillMttsh).
 *
 * This is the wiring leg the prior FB-23 session parked on frontier:drill-corpus-live
 * (now emitted by FB-20). It proves the consumer end of the contract end-to-end —
 * insert (store) → load (readDrillOutcomes via the tool) → SLO verdict + raw metric —
 * over migration 255's schema, without needing the live arming gate (P-001): the rows
 * are written directly, the way the live sandbox cycle writes them.
 *
 * The pure signal cores are drill-signals.test.ts; the explicit-arg path is
 * gym-tools.test.ts; this file is the PG-backed load path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import signalsTool from '../../agent-tools/gym/signals';
import {
  insertDrillRow,
  markDrillFailed,
  readDrillOutcomes,
  updateDrillResolved,
  updateDrillTriaged,
} from '../../red-queen/store';
import {
  DRILL_RESOLVE_RATE_FLOOR,
  DRILL_TRIAGE_ACCURACY_FLOOR,
  DRILL_MTTSH_CEILING_MS,
} from '../drill-signals';

// A dedicated workspace so the corpus this test plants is isolated from any other
// drills in the throwaway DB (the load defaults to the sandbox workspace).
const WS = 'rq-judging-test-ws';
const EMPTY_WS = 'rq-judging-empty-ws';

const FULL_LEAK = { passed: true, organicReadClean: true, liveCollectorClean: true, capturedOriginIsDrill: true };

function call(args: Record<string, unknown>): Promise<any> {
  return (signalsTool as any).handler(args);
}
function parse(res: { content: Array<{ text: string }> }): any {
  return JSON.parse(res.content[0].text);
}
function byName(out: any): Record<string, any> {
  return Object.fromEntries(out.results.map((r: any) => [r.name, r]));
}

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;

  // Four drills in WS, distinct classes (so the partial-unique OPEN-class index
  // never blocks), shaped for hand-computable metrics:
  //
  //   d1 resolved+evidence, triage place==place (correct), mttsh 600_000
  //   d2 resolved+evidence, triage gate vs reject (WRONG), mttsh 1_800_000
  //   d3 failed (settled, NOT resolved-with-evidence), never triaged
  //   d4 still planted (in-flight) — excluded from every metric
  //
  // ⇒ resolveRate  = 2 resolved-w-evidence / 3 settled        = 2/3
  //   triageAccuracy = 1 correct / 2 pinned+triaged            = 1/2
  //   mttsh          = mean(600_000, 1_800_000)                = 1_200_000

  const d1 = await insertDrillRow(h.sql, {
    workspaceId: WS, drillClass: 'c-resolved-correct', collectorFamily: 'smoke-fail',
    expectedWatchdogKey: 'k1', expectedKind: 'bug', expectedSeverity: 'major', expectedDecision: 'place', artifacts: {},
  });
  await updateDrillTriaged(h.sql, d1.drillId, { triagedAt: new Date().toISOString(), triagedDecision: 'place', triagedIdeaType: 'infra-environment' });
  await updateDrillResolved(h.sql, d1.drillId, { resolvedAt: new Date().toISOString(), resolvedWithEvidence: true, mttsh: { totalMs: 600_000 }, leakCheck: FULL_LEAK });

  const d2 = await insertDrillRow(h.sql, {
    workspaceId: WS, drillClass: 'c-resolved-wrong-triage', collectorFamily: 'smoke-fail',
    expectedWatchdogKey: 'k2', expectedKind: 'bug', expectedSeverity: 'major', expectedDecision: 'gate', artifacts: {},
  });
  await updateDrillTriaged(h.sql, d2.drillId, { triagedAt: new Date().toISOString(), triagedDecision: 'reject' });
  await updateDrillResolved(h.sql, d2.drillId, { resolvedAt: new Date().toISOString(), resolvedWithEvidence: true, mttsh: { totalMs: 1_800_000 }, leakCheck: FULL_LEAK });

  const d3 = await insertDrillRow(h.sql, {
    workspaceId: WS, drillClass: 'c-failed', collectorFamily: 'out-of-band',
    expectedWatchdogKey: 'k3', expectedKind: 'change', expectedSeverity: 'minor', expectedDecision: 'place', artifacts: {},
  });
  await markDrillFailed(h.sql, d3.drillId, 'synthetic failure for the test');

  await insertDrillRow(h.sql, {
    workspaceId: WS, drillClass: 'c-inflight', collectorFamily: 'smoke-fail',
    expectedWatchdogKey: 'k4', expectedKind: 'bug', expectedSeverity: 'major', expectedDecision: 'gym', artifacts: {},
  });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('gym:signals loadDrillOutcomes — the FB-23 judging round-trip (migration 255)', () => {
  it('loads the live corpus from PG and scores the drill signals (value = SLO verdict, metric = raw scalar)', async () => {
    const out = parse(
      await call({ signals: ['drillResolveRate', 'drillTriageAccuracy', 'drillMttsh'], loadDrillOutcomes: true, drillWorkspaceId: WS }),
    );
    expect(out.ok).toBe(true);
    expect(out.drillSource).toMatchObject({ mode: 'loaded', count: 4, workspaceId: WS });

    const r = byName(out);
    // resolveRate 2/3 ≥ floor 0.5 ⇒ pass
    expect(r.drillResolveRate.applicable).toBe(true);
    expect(r.drillResolveRate.metric).toBeCloseTo(2 / 3, 6);
    expect(r.drillResolveRate.value).toBe(2 / 3 >= DRILL_RESOLVE_RATE_FLOOR);
    expect(r.drillResolveRate.value).toBe(true);
    // triageAccuracy 0.5 < floor 0.8 ⇒ FAIL (the verdict the guardrail exists to catch)
    expect(r.drillTriageAccuracy).toMatchObject({ applicable: true, metric: 0.5 });
    expect(r.drillTriageAccuracy.value).toBe(0.5 >= DRILL_TRIAGE_ACCURACY_FLOOR);
    expect(r.drillTriageAccuracy.value).toBe(false);
    // mttsh 1_200_000 ≤ ceiling 3_600_000 ⇒ pass
    expect(r.drillMttsh).toMatchObject({ applicable: true, metric: 1_200_000 });
    expect(r.drillMttsh.value).toBe(1_200_000 <= DRILL_MTTSH_CEILING_MS);
    expect(r.drillMttsh.value).toBe(true);
  });

  it('every loaded row carries origin=drill (the D-002 provenance the cores guard on)', async () => {
    const rows = await readDrillOutcomes(h.sql, { workspaceId: WS });
    expect(rows).toHaveLength(4);
    expect(rows.every((o) => o.origin === 'drill')).toBe(true);
  });

  it('a class filter narrows the loaded corpus', async () => {
    const out = parse(
      await call({ signals: ['drillResolveRate'], loadDrillOutcomes: true, drillWorkspaceId: WS, drillClass: 'c-resolved-correct' }),
    );
    expect(out.drillSource).toMatchObject({ mode: 'loaded', count: 1 });
    expect(byName(out).drillResolveRate).toMatchObject({ value: true, applicable: true, metric: 1 });
  });

  it('an empty corpus is inapplicable, never a fake zero', async () => {
    const out = parse(await call({ signals: ['drillResolveRate'], loadDrillOutcomes: true, drillWorkspaceId: EMPTY_WS }));
    expect(out.drillSource).toMatchObject({ mode: 'loaded', count: 0 });
    expect(out.results[0]).toMatchObject({ name: 'drillResolveRate', applicable: false, value: false });
    expect(out.results[0].metric).toBeUndefined();
  });

  it('an explicit drillOutcomes arg wins over loadDrillOutcomes (the test/override seam)', async () => {
    const out = parse(
      await call({
        signals: ['drillResolveRate'],
        loadDrillOutcomes: true,
        drillWorkspaceId: WS,
        drillOutcomes: [
          {
            drillId: 'x', drillClass: 'explicit', collectorFamily: 'smoke-fail', plantedAt: '2026-06-12T00:00:00.000Z',
            resolvedAt: '2026-06-12T00:05:00.000Z', expectedWatchdogKey: 'k', expectedKind: 'bug', expectedSeverity: 'major',
            resolvedWithEvidence: true, status: 'resolved', origin: 'drill',
          },
        ],
      }),
    );
    expect(out.drillSource).toMatchObject({ mode: 'explicit', count: 1 });
    expect(byName(out).drillResolveRate).toMatchObject({ value: true, applicable: true, metric: 1 });
  });
});
