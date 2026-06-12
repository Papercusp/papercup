/**
 * interactions.integration.test.ts — the IO leg of the owner preference
 * model (P-043 / FB-15) against a real migrated Postgres: migration 254's
 * owner_interactions stream round-trips, the queue-view throttle holds, the
 * engineer_issues attribute join feeds the bucket counts, and the
 * gradeRoutedIdea seam captures OWNER grades (grade vs regrade) while
 * staying silent for the Queen. The pure model is affinity.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import {
  readOwnerSignal,
  recordOwnerInteraction,
  recordQueueExposure,
} from './interactions';
import { gradeRoutedIdea, recordRoutedIdea } from '../scout/routed-ledger';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const interactionRows = (kind?: string) =>
  kind
    ? h.sql<{ kind: string; subject_id: string; payload: Record<string, unknown> }[]>`
        SELECT kind, subject_id, payload FROM harness_shared.owner_interactions
         WHERE kind = ${kind} ORDER BY ts`
    : h.sql<{ kind: string; subject_id: string; payload: Record<string, unknown> }[]>`
        SELECT kind, subject_id, payload FROM harness_shared.owner_interactions ORDER BY ts`;

describe('owner_interactions write/read (migration 254)', () => {
  it('records an interaction row and reads it back as an attribute-joined engagement', async () => {
    await h.sql`
      INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title, severity, scope)
      VALUES ('default', 'EI-900', 'pref test issue', 'critical', 'operator')`;

    const ok = await recordOwnerInteraction({
      kind: 'grade',
      subjectKind: 'routed-idea',
      subjectId: 'idea-1',
      payload: { grade: 5, routedRef: 'wi:EI-900' },
    });
    expect(ok).toBe(true);

    const signal = await readOwnerSignal();
    expect(signal.engagements).toHaveLength(1);
    expect(signal.engagements[0]).toMatchObject({
      kind: 'grade',
      itemId: 'EI-900',
      severity: 'critical',
      scope: 'operator',
    });
  });

  it('queue-view exposure: first write lands (ids + total), an immediate second is throttled', async () => {
    const first = await recordQueueExposure(['EI-900', 'EI-901'], 'improvements');
    expect(first).toBe(true);
    const second = await recordQueueExposure(['EI-900'], 'improvements');
    expect(second).toBe(false); // throttled — within the 5-min window

    const rows = await interactionRows('queue-view');
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe('improvements');
    expect(rows[0].payload).toMatchObject({ ids: ['EI-900', 'EI-901'], total: 2 });

    // The exposure flows into per-item and (joined) per-bucket counts.
    const signal = await readOwnerSignal();
    expect(signal.exposureCountById.get('EI-900')).toBe(1);
    expect(signal.exposureCountById.get('EI-901')).toBe(1);
    expect(signal.totalExposures).toBe(2);
    // EI-901 has no engineer_issues row → contributes no bucket counts;
    // EI-900 joins to critical/operator.
    expect(signal.exposureCountByBucket.get('severity:critical')).toBe(1);
    expect(signal.exposureCountByBucket.get('scope:operator')).toBe(1);
  });
});

describe('gradeRoutedIdea capture seam (owner grades only)', () => {
  const idea = (ideaId: string, routedRef: string) =>
    recordRoutedIdea({
      ideaId,
      harnessSlug: 'papercup',
      lens: 'reframing',
      rail: 'improvement',
      routedRef,
      title: `idea ${ideaId}`,
    });

  it('an owner grade lands as kind=grade; the owner grading again is a regrade with prevGrade', async () => {
    await idea('idea-own', 'wi:EI-900');

    expect((await gradeRoutedIdea({ ideaId: 'idea-own', grade: 4, gradedBy: 'owner' })).applied).toBe(true);
    await vi.waitFor(async () => {
      expect(await interactionRows('grade')).toHaveLength(2); // 1 from the test above + this one
    });
    const graded = (await interactionRows('grade')).at(-1)!;
    expect(graded.subject_id).toBe('idea-own');
    expect(graded.payload).toMatchObject({ grade: 4, routedRef: 'wi:EI-900', rail: 'improvement' });
    expect(graded.payload).not.toHaveProperty('prevGrade');

    expect((await gradeRoutedIdea({ ideaId: 'idea-own', grade: 2, gradedBy: 'owner' })).applied).toBe(true);
    await vi.waitFor(async () => {
      expect(await interactionRows('regrade')).toHaveLength(1);
    });
    const regraded = (await interactionRows('regrade'))[0];
    expect(regraded.payload).toMatchObject({ grade: 2, prevGrade: 4 });
  });

  it('a Queen grade captures nothing; an owner grade over a Queen grade is a fresh grade, not a regrade', async () => {
    await idea('idea-queen', 'gym:prop-1');

    expect((await gradeRoutedIdea({ ideaId: 'idea-queen', grade: 3, gradedBy: 'Queen' })).applied).toBe(true);
    // Owner grading over the Queen's: applied (owner sovereign), captured as
    // 'grade' — the previous grade was not the OWNER's attention.
    expect((await gradeRoutedIdea({ ideaId: 'idea-queen', grade: 5, gradedBy: 'owner' })).applied).toBe(true);
    await vi.waitFor(async () => {
      const rows = await interactionRows();
      expect(rows.filter((r) => r.subject_id === 'idea-queen')).toHaveLength(1);
    });
    const [row] = (await interactionRows()).filter((r) => r.subject_id === 'idea-queen');
    expect(row.kind).toBe('grade');
    expect(row.payload).toMatchObject({ grade: 5, prevGrade: 3 });

    // Sovereignty unchanged: the Queen cannot overwrite the owner's grade,
    // and the refused write captures nothing.
    const refused = await gradeRoutedIdea({ ideaId: 'idea-queen', grade: 1, gradedBy: 'Queen' });
    expect(refused).toEqual({ applied: false, reason: 'owner-grade-sovereign' });
    await new Promise((r) => setTimeout(r, 150));
    expect((await interactionRows()).filter((r) => r.subject_id === 'idea-queen')).toHaveLength(1);
  });

  it('owner_interactions is append-only for the app role (grant-level enforcement)', async () => {
    const grants = await h.sql<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'harness_shared' AND table_name = 'owner_interactions'
         AND grantee = 'harness_app'`;
    const set = new Set(grants.map((g) => g.privilege_type));
    expect(set.has('SELECT')).toBe(true);
    expect(set.has('INSERT')).toBe(true);
    expect(set.has('UPDATE')).toBe(false);
    expect(set.has('DELETE')).toBe(false);
  });
});
