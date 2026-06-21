/**
 * plan_revisions workspace scoping — regression for full-app-audit P-008
 * (mig 218 + the workspaceId threading through revisions.ts).
 *
 * Pre-218 the table had no workspace_id and all 7 revisions.ts functions
 * hardcoded DEFAULT_WORKSPACE_ID: two same-slug plans in different
 * workspaces shared ONE seq spine, and every revision was readable from
 * (only) the default workspace context.
 *
 * Live-PG test (same skip pattern as the plans e2e integration suite).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import {
  recordPlanRevision,
  listPlanRevisions,
  countPlanRevisions,
  type RecordPlanRevisionArgs,
} from '../revisions';
import type { AgentIdentity } from '../../coordination/identity';

const RUN = Date.now();
const SLUG = `ws-scope-test-${RUN}`;
const WS_A = `ws-scope-a-${RUN}`;
const WS_B = `ws-scope-b-${RUN}`;

const IDENTITY: AgentIdentity = {
  ownerId: 'revisions-ws-scope-test',
  ownerLabel: 'revisions ws-scope test',
  source: 'static-client',
  workspaceId: null,
  userId: null,
} as AgentIdentity;

function args(workspaceId: string, content: string): RecordPlanRevisionArgs {
  return {
    planSlug: SLUG,
    harnessSlug: 'papercup',
    workspaceId,
    content,
    identity: IDENTITY,
  };
}

async function dbLive(): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('plan_revisions workspace scoping (audit P-008 / mig 218)', async () => {
  const live = await dbLive();

  afterAll(async () => {
    if (!live) return;
    const { sql } = getOrgPg(); // admin — bypasses RLS for cleanup
    await sql`DELETE FROM harness_shared.plan_revisions WHERE plan_slug = ${SLUG}`;
  });

  it.skipIf(!live)('same slug in two workspaces gets two INDEPENDENT seq spines', async () => {
    const a1 = await recordPlanRevision(args(WS_A, 'workspace A, first body'));
    const b1 = await recordPlanRevision(args(WS_B, 'workspace B, first body'));
    const a2 = await recordPlanRevision(args(WS_A, 'workspace A, second body'));

    // Pre-218 these interleaved one global spine (1, 2, 3).
    expect(a1?.seq).toBe(1);
    expect(b1?.seq).toBe(1);
    expect(a2?.seq).toBe(2);
  });

  it.skipIf(!live)('reads are workspace-scoped — each side sees only its own chain', async () => {
    const chainA = await listPlanRevisions(SLUG, { harnessSlug: 'papercup', workspaceId: WS_A });
    const chainB = await listPlanRevisions(SLUG, { harnessSlug: 'papercup', workspaceId: WS_B });

    expect(chainA.map((r) => r.seq)).toEqual([2, 1]); // newest-first
    expect(chainB.map((r) => r.seq)).toEqual([1]);
    expect(await countPlanRevisions(SLUG, { harnessSlug: 'papercup', workspaceId: WS_A })).toBe(2);
    expect(await countPlanRevisions(SLUG, { harnessSlug: 'papercup', workspaceId: WS_B })).toBe(1);
    // The operator-home spine (papercup → PAPERCUSP_WORKSPACE_ID via resolvePlanScope,
    // WI-148 mig-295 cutover — no longer the silent 'default') is untouched by either.
    expect(await countPlanRevisions(SLUG, { harnessSlug: 'papercup' })).toBe(0);
  });

  it('skipped diagnostic when DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
