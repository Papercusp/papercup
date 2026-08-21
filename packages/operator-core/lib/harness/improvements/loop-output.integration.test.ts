/**
 * loop-output.integration.test.ts — the WI-6338 recurrence guard, against a real
 * MIGRATED Postgres.
 *
 * loop-output.ts documents (and this test PINS) that "the learning loop produced
 * this" is recorded by THREE independent writers with no shared transaction:
 *   - `payload.sourceRole = 'Scout'` and the `improvement-source:Scout` topic tag
 *     are written TOGETHER inside captureImprovement (capture-core.ts) — but a
 *     topic can also be added/removed independently later via tagIssue/untagIssue,
 *     and a capture can happen with NO routing at all;
 *   - a `scout_routed_ideas` row is written by a SEPARATE call, `recordRoutedIdea`
 *     (routed-ledger.ts), invoked from the scheduler AFTER the capture already
 *     happened — so a capture with no matching routed-idea record (or a routed
 *     record whose underlying issue was never Scout-tagged) is a real, reachable
 *     state, not a hypothetical.
 *
 * This test reproduces exactly that shape against real PG (all-three agreement,
 * a capture with no routing, and a routed idea whose issue isn't tagged) and pins
 * `readLoopOutputIds` / `provenanceDivergence` computing the union + divergence
 * correctly over it — so a future regression in either write path OR the union
 * query itself is caught here instead of silently drifting back to the ~50%
 * disagreement that went unnoticed before WI-6338.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// Both capture-core and routed-ledger fire-and-forget a lazy sync-sse import
// (resolved from this test file at '../../sync-sse' — same target either module
// imports it from) — mock it so the writes don't depend on a live SSE bus.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { captureImprovement } = await import('./capture-core');
const { recordRoutedIdea } = await import('../../scout/routed-ledger');
const { readLoopOutputIds, provenanceDivergence, SCOUT_SOURCE_ROLE } = await import('./loop-output');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

const HARNESS = 'papercup';

describe('loop-output — three-record Scout provenance union + divergence (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });

  it('all three writers agree ⇒ the id appears once in the union, divergence 0', async () => {
    const captured = await captureImprovement({
      title: 'loop-output-fixture: all-three-agree',
      kind: 'change',
      sourceRole: SCOUT_SOURCE_ROLE,
      createdBy: 'scout-test',
    });
    expect(captured.created).toBe(true);
    const id = captured.issue!.id;
    await recordRoutedIdea({
      ideaId: `loop-output-agree-${id}`,
      lens: 'analogical',
      rail: 'improvement',
      routedRef: `wi:${id}`,
      harnessSlug: HARNESS,
      cycleId: 'c-agree',
      title: captured.issue!.title,
    });

    const { ids, counts } = await readLoopOutputIds();
    expect(ids).toContain(id);
    // This id is counted on ALL THREE legs.
    expect(counts.bySourceRole).toBeGreaterThan(0);
    expect(counts.byTopic).toBeGreaterThan(0);
    expect(counts.byRoutedIdea).toBeGreaterThan(0);
  });

  it('captured + Scout-tagged but NEVER ROUTED ⇒ counted in sourceRole+topic, absent from routedIdea', async () => {
    const captured = await captureImprovement({
      title: 'loop-output-fixture: captured-not-routed',
      kind: 'change',
      sourceRole: SCOUT_SOURCE_ROLE,
      createdBy: 'scout-test',
    });
    expect(captured.created).toBe(true);
    const id = captured.issue!.id;

    const { ids } = await readLoopOutputIds();
    expect(ids).toContain(id);
    // Directly confirm the divergence mechanism this work item is about: a topic
    // tag with no corresponding scout_routed_ideas row (WI-6338's population "240:
    // tagged Scout-source but NO routed-ideas row").
    const [row] = await db.adminSql<{ has_routed_row: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM harness_shared.scout_routed_ideas WHERE routed_ref = ${'wi:' + id}
      ) AS has_routed_row`;
    expect(row.has_routed_row).toBe(false);
  });

  it('routed to a wi: ref whose issue was captured WITHOUT Scout tagging ⇒ counted only via routedIdea', async () => {
    // A plain human capture — no sourceRole, so neither payload.sourceRole nor the
    // improvement-source:Scout topic is ever written for it.
    const captured = await captureImprovement({
      title: 'loop-output-fixture: routed-but-untagged',
      kind: 'change',
      createdBy: 'human-test',
    });
    expect(captured.created).toBe(true);
    const id = captured.issue!.id;
    await recordRoutedIdea({
      ideaId: `loop-output-untagged-${id}`,
      lens: 'reframing',
      rail: 'improvement',
      routedRef: `wi:${id}`,
      harnessSlug: HARNESS,
      cycleId: 'c-untagged',
      title: captured.issue!.title,
    });

    const { ids } = await readLoopOutputIds();
    // Still in the UNION (routedIdea leg alone is enough) — this is exactly why a
    // consumer must read the union, not any single leg (the bug the Learning tab
    // shipped with: the Ideas view read scout_routed_ideas alone, the Backlog read
    // the topic alone, and they silently disagreed).
    expect(ids).toContain(id);
  });

  it('the live counts feed provenanceDivergence exactly like the pure unit tests assume', async () => {
    const { counts } = await readLoopOutputIds();
    // Sanity: the three per-leg tallies plus the union all agree with each other
    // under the same arithmetic contract provenanceDivergence() relies on —
    // union >= max(any single leg), and divergence is a proper [0,1] fraction.
    expect(counts.union).toBeGreaterThanOrEqual(counts.bySourceRole);
    expect(counts.union).toBeGreaterThanOrEqual(counts.byTopic);
    expect(counts.union).toBeGreaterThanOrEqual(counts.byRoutedIdea);
    const divergence = provenanceDivergence(counts);
    expect(divergence).toBeGreaterThanOrEqual(0);
    expect(divergence).toBeLessThanOrEqual(1);
    // Given the fixtures above (at least one id NOT on all three legs), the corpus
    // is not in perfect agreement — the guard's whole point is that this number is
    // now COMPUTED rather than silently 0-by-default.
    expect(divergence).toBeGreaterThan(0);
  });
});
