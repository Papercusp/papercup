/** EI-22044075415554418 — routed drafts must be activation-auditable immediately. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- reset the test DB URL cache
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { registerHarnessProject } from '../plans/__tests__/_pg-tool-fixture';
import { recordCurrentActivationAudit } from '../../plan-audits';
import { createScoutPlanDraft } from '../../scout/scout-plan-draft';
import type { EngineerIssue } from '../../issues-engineer';
import { runRouteIdea, type RouteIdeaDeps } from './route-idea';

const WS = 'ws-route-idea-revision';
const HARNESS = 'route-idea-revision-it';
const SLUG = 'revision-spine-routed-feature-2026-09-01';

describe('blender:route-idea revision spine', () => {
  let db: OrgTestDb;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = await createOrgTestDb();
    savedEnv.HARNESS_DATABASE_URL = process.env.HARNESS_DATABASE_URL;
    savedEnv.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();
    await registerHarnessProject(db.adminSql, WS, HARNESS);
  }, 180_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetUrlCacheForTests();
    await _resetForTests();
    await db?.cleanup();
  });

  it('records the current bytes + resolved session and immediately admits activation audit', async () => {
    const issue = {
      id: 'EI-route-revision',
      title: 'Revision spine routed feature',
      body: 'Route this feature through the plan rail.',
      payload: { ideation: { lens: 'risk-first' } },
      createdBy: 'su-originator',
    } as EngineerIssue;
    const deps = {
      createPlanDraft: (input) =>
        createScoutPlanDraft({ ...input, date: '2026-09-01' }),
      recordRoutedIdea: vi.fn(async () => undefined),
      getIssue: vi.fn(async () => issue),
      linkIssue: vi.fn(async () => undefined),
      preserveAgentReviewAuthority: vi.fn(async () => ({ preserved: false, reason: 'not-agent-review' as const })),
    } as unknown as RouteIdeaDeps;
    const ctx = {
      isSuperuser: true,
      uiClientId: 'su-route-revision-test',
      workspaceId: WS,
      harnessSlug: HARNESS,
      planRunSessionId: 'session-route-revision-test',
    };

    const routed = await runRouteIdea({ featureId: issue.id, rail: 'plan' }, ctx, deps);
    expect(routed).toMatchObject({ ok: true, created: true, slug: SLUG });

    const revisions = await db.adminSql<Array<{
      seq: number;
      session_id: string | null;
      session_kind: string | null;
      matches_current: boolean;
    }>>`
      SELECT r.seq, r.session_id, r.session_kind,
             (r.content_hash = p.content_hash AND r.content_snapshot = p.content) AS matches_current
        FROM harness_shared.plan_revisions r
        JOIN harness_shared.harness_plans p
          ON p.workspace_id = r.workspace_id AND p.harness_slug = r.harness_slug
         AND p.plan_slug = r.plan_slug
       WHERE r.workspace_id = ${WS} AND r.harness_slug = ${HARNESS} AND r.plan_slug = ${SLUG}
       ORDER BY r.seq`;
    expect(revisions).toEqual([{
      seq: 1,
      session_id: 'session-route-revision-test',
      session_kind: 'plan_run',
      matches_current: true,
    }]);

    const audit = await recordCurrentActivationAudit({
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: SLUG,
      createdBy: 'su-route-revision-test',
      activation: {
        sourceRanges: [{ sourceKind: 'plan_run', sessionId: 'session-route-revision-test', fromTurn: 0, toTurn: 0 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:plan_run:session-route-revision-test:0'],
          requirement: 'The routed feature must create an activation-auditable plan.',
          planTargets: ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: [],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
      summary: 'revision spine exists at route time',
    });
    expect(audit.ok).toBe(true);
    if (audit.ok) expect(audit.auditedPlanRevision.seq).toBe(1);
  }, 180_000);
});
