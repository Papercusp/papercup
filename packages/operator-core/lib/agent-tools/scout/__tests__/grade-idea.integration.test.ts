/**
 * grade-idea.integration.test.ts — EI-15389 recurrence guard against real migrated
 * Postgres. The bug: blender:grade-idea silently no-op'd when keyed by a BARE
 * work-item id (`EI-15375`) instead of the cycle-prefixed ledger idea_id, because
 * a Scout-dispatched row is keyed by the full idea_id and found only via its
 * `routed_ref` (`wi:EI-15375`). Grades vanished; the ungraded backlog grew.
 *
 * This pins the REAL resolution SQL (resolveIdeaIdFromKey, exercised through the
 * default-deps runGradeIdea) — the unit suite mocks that resolver, so only a
 * real-PG test proves the query actually lands the grade on the right row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
// Keep db-org's generated schema exports intact: importing the projected
// blender tool loads agent-mcp bootstrap, which reads generated.* at module
// initialization. Only replace the PG handle used by this real-PG fixture.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { runGradeIdea } = await import('../grade-idea');
const { recordRoutedIdea } = await import('../../../scout/routed-ledger');
const { createOrgTestDb } = await import('../../../../test/_org-test-db');

const WS = 'ws-grade-idea-ei15389';
const HARNESS = 'papercup';

describe('blender:grade-idea by bare work-item id (EI-15389, real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // A Scout-dispatched work-item idea: keyed by the CYCLE-PREFIXED idea_id, found
    // by a caller only via routed_ref 'wi:EI-777' (the exact bug shape).
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-reframing-1-1',
      lens: 'reframing',
      rail: 'improvement',
      routedRef: 'wi:EI-777',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'routed work-item idea',
      workspaceId: WS,
    });
    // A gym idea: routed_ref 'gym:SP-002' — the 'gym:' prefix branch.
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-analogical-2-1',
      lens: 'analogical',
      rail: 'gym',
      routedRef: 'gym:SP-002',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'routed gym idea',
      workspaceId: WS,
    });
    // A fresh row for the identified-SU attribution regression. Keep it
    // separate from SP-002, which the preceding human-grade test intentionally
    // claims for the owner and therefore cannot be regraded by an agent.
    await recordRoutedIdea({
      ideaId: 'scout-1784334639774:scout-idea-constraint-removal-3-1',
      lens: 'constraint-removal',
      rail: 'improvement',
      routedRef: 'wi:SU-003',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'identified SU attribution idea',
      workspaceId: WS,
    });
    // A su re-route row keyed by the BARE work-item id DIRECTLY (route-idea.ts
    // re-route path) — the direct-idea_id branch must still resolve.
    await recordRoutedIdea({
      ideaId: 'EI-888',
      lens: 'su-ideate',
      rail: 'plan',
      routedRef: 'plan:some-plan-2026-07-19',
      harnessSlug: HARNESS,
      sourceHive: HARNESS,
      cycleId: 'c1',
      title: 'su re-routed idea',
      workspaceId: WS,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function humanGradeOf(ideaId: string): Promise<{ human_grade: number | null; graded_by: string | null } | undefined> {
    const rows = await db.adminSql<{ human_grade: number | null; graded_by: string | null }[]>`
      SELECT human_grade, graded_by FROM harness_shared.scout_routed_ideas WHERE idea_id = ${ideaId}`;
    return rows[0];
  }

  it('a bare work-item id (EI-777) resolves via routed_ref and the grade LANDS on the cycle-prefixed row', async () => {
    const out = await runGradeIdea({ ideaId: 'EI-777', grade: 4, feedback: 'sharp reframe' }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-reframing-1-1');

    const row = await humanGradeOf('scout-1784334639774:scout-idea-reframing-1-1');
    expect(row).toBeDefined();
    expect(Number(row!.human_grade)).toBe(4);
    expect(row!.graded_by).toBe('Queen');
  });

  it('a bare gym id (SP-002) resolves via the gym: routed_ref prefix', async () => {
    const out = await runGradeIdea({ ideaId: 'SP-002', grade: 2 }, undefined);
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('scout-1784334639774:scout-idea-analogical-2-1');
    const row = await humanGradeOf('scout-1784334639774:scout-idea-analogical-2-1');
    expect(Number(row!.human_grade)).toBe(2);
    expect(row!.graded_by).toBe('owner');
  });

  it('an identified su caller writes its ownerId, leaving the literal owner for human grades', async () => {
    const out = await runGradeIdea(
      { ideaId: 'SU-003', grade: 4, feedback: 'steward signal' },
      { role: 'operator', ownerId: 'su-steward-grade-1' },
    );
    expect(out.applied).toBe(true);
    expect(out.gradedBy).toBe('su-steward-grade-1');
    const row = await humanGradeOf('scout-1784334639774:scout-idea-constraint-removal-3-1');
    expect(row!.graded_by).toBe('su-steward-grade-1');
  });

  it('a bare id whose row is keyed DIRECTLY by that id (su re-route) still resolves', async () => {
    const out = await runGradeIdea({ ideaId: 'EI-888', grade: 5, feedback: 'love it' }, { role: 'mug' });
    expect(out.applied).toBe(true);
    expect(out.ideaId).toBe('EI-888');
    const row = await humanGradeOf('EI-888');
    expect(Number(row!.human_grade)).toBe(5);
  });

  it('an unresolvable bare id returns a LOUD not-found (never a success-shaped no-op)', async () => {
    const out = await runGradeIdea({ ideaId: 'EI-does-not-exist', grade: 3 }, { role: 'mug' });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('not-found');
    expect(out.ideaId).toBeNull();
  });
});
