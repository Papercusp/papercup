/**
 * ei207-stale-revert-revision-spine.integration.test.ts — the EI-207 regression.
 *
 * EI-207 (observed 2026-06-09 23:00 on harnesses-tab-hive-model): a plan's live
 * `harness_shared.harness_plans` row silently REVERTED to an old revision's bytes
 * (byte-identical to the original hand-off) while `plan_revisions` still listed
 * the full chain intact — i.e. the live row diverged BELOW its own recorded
 * revision head, and the reverting write recorded NO revision. The mechanism is
 * the EI-117 stale-replay defect: a LOCAL plan write (via withPlanLock) never
 * stamped `fed_ts`, so a replayed/old federated op LWW-beat the newer local
 * content. The central fix — mig 214's BEFORE-trigger that stamps `fed_ts` +
 * resets `origin` on every local write, plus the projection writers dropping the
 * `OR EXCLUDED.fed_ts IS NULL` clobber disjunct — landed 2026-06-09 23:50, ~50
 * minutes AFTER this incident.
 *
 * The sibling ei117-replay-revert-guard.integration.test.ts proves the guard with
 * RAW local INSERT/UPDATE. THIS test proves it through the surfaces EI-207 named:
 * the REAL `withPlanLock` write path AND the `plan_revisions` spine — that a build
 * of several recorded revisions cannot be reverted below its head by a stale
 * federation replay, and the revision chain stays the authoritative record of the
 * live content.
 *
 * Runs against the integration-tier baseline schema DB (all migrations applied,
 * so the mig-214 stamp trigger is live) via the shared plans fixture.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from '../with-plan-lock';
import { planRevisionCapture, listPlanRevisions, type PlanRevisionCtx } from '../revisions';
import { hashPlanContent } from '../content-hash';
import { getPlanRow } from '../source';
import {
  buildHarnessPlansProjection,
  type HarnessPlanRow,
} from '../../../sync/hyperbee/projections/harness-plans';
import { setupPlanPgFixture, cleanupPlans, type PlanPgFixture } from './_pg-tool-fixture';

// Throwaway harness slug so this never collides with — or deletes — real plan rows.
const HARNESS = `zzz-ei207-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

/** A superuser ctx → a stable `static-client` identity, so planRevisionCapture
 *  records attributable revisions (mirrors how the real set-content handler
 *  resolves a human/agent author). */
const CTX = {
  isSuperuser: true,
  uiClientId: `ei207-regression-${Math.random().toString(36).slice(2, 10)}`,
} as unknown as PlanRevisionCtx;

const planBody = (slug: string, marker: string) => `---
title: ${slug}
slug: ${slug}
status: active
created: 2026-06-09
updated: 2026-06-09
---

# ${slug}

## Now

**State:** ${marker}
**Next:** ${marker}

## Phase 1

- **P-001** \`done\` seed item — ${marker}

## Decisions

### D-001 — seed decision (${marker})
Date: 2026-06-09
${marker}
`;

/** Drive a real recorded plan write through withPlanLock — exactly the shape the
 *  set-content handler uses (afterWrite = planRevisionCapture). Returns the
 *  written body so the test can pin the head content. */
async function recordedWrite(slug: string, body: string): Promise<string> {
  const rev = planRevisionCapture(CTX, slug, `write ${body.length}b`, { harnessSlug: HARNESS });
  const res = await withPlanLock<{ ok: true }>(
    null,
    { slug, intent: 'ei207 write', harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30, afterWrite: rev.afterWrite },
    async () => ({ newBody: body, value: { ok: true } }),
  );
  expect(res.kind).toBe('applied');
  return body;
}

/** The live row's federation columns — `fed_ts` is the mig-214-stamped LWW clock
 *  a stale replay must beat to clobber (and cannot); `origin` proves a local
 *  write left it `local` (getPlanRow does not select either column). */
async function liveFed(slug: string): Promise<{ fedTs: number; origin: string }> {
  const [r] = await admin<Array<{ fed_ts: number | null; origin: string }>>`
    SELECT fed_ts::bigint AS fed_ts, origin FROM harness_shared.harness_plans
     WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(r?.fed_ts).not.toBeNull();
  return { fedTs: Number(r!.fed_ts), origin: r!.origin };
}

/** Apply a federated op for `slug` carrying `content` at wire ts `ts`, through
 *  the REAL whole-blob projection writer (per-part federation forced OFF so the
 *  whole-blob path is authoritative — the path that did the EI-207 revert). */
async function applyRemote(slug: string, content: string, ts: number): Promise<void> {
  const projection = buildHarnessPlansProjection({
    workspaceId: wsId,
    harnessSlug: HARNESS,
    sql: admin,
    isFlagOn: async () => false,
  });
  const row: HarnessPlanRow = {
    harness_slug: HARNESS,
    plan_slug: slug,
    content,
    content_hash: hashPlanContent(content),
    title: slug,
    status: 'active',
    created: '2026-06-09',
    updated: '2026-06-09',
    owner: null,
    supersedes: [],
    superseded_by: null,
    archived: false,
    is_legacy: false,
  };
  await projection.writeToPg(row, { authorPubkey: 'REMOTE-LOG-KEY', origin: 'remote', ts });
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
}, 60_000);

afterEach(async () => {
  await cleanupPlans(admin, wsId, HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('EI-207 — a stale federation replay cannot revert a plan below its recorded revision head', () => {
  it('several recorded writes, then a stale replay of the ORIGINAL bytes → live row stays at head, spine intact', async () => {
    const slug = `zzz-ei207-spine-${Math.random().toString(36).slice(2, 8)}`;

    // Build a revision chain: the ORIGINAL hand-off, then two edits past it.
    const original = await recordedWrite(slug, planBody(slug, 'ORIGINAL-handoff'));
    await recordedWrite(slug, planBody(slug, 'edit-2'));
    const head = await recordedWrite(slug, planBody(slug, 'edit-3-HEAD'));

    // Three recorded revisions; the head revision matches the live content.
    const chainBefore = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(chainBefore.map((r) => r.seq)).toEqual([3, 2, 1]); // newest-first
    expect(chainBefore[0]!.contentHash).toBe(hashPlanContent(head));

    const { fedTs } = await liveFed(slug);

    // THE EI-207 REVERT: a replayed federated op carrying the ORIGINAL bytes,
    // stamped BEFORE the head's local write. Pre-mig-214 this LWW-beat the head
    // (local writes never advanced fed_ts) and silently restored the original.
    await applyRemote(slug, original, fedTs - 10_000);

    // Guard holds: the live row is NOT reverted — still the head, still local.
    const after = await getPlanRow(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(after).not.toBeNull();
    expect(after!.content).toBe(head);
    expect(after!.content).not.toBe(original);
    expect((await liveFed(slug)).origin).toBe('local');

    // The revision spine is the authoritative record: untouched, head == live.
    const chainAfter = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(chainAfter.map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(chainAfter[0]!.contentHash).toBe(hashPlanContent(after!.content));
  }, 60_000);

  it('sanity — a NEWER federated op DOES apply (the guard rejects only stale ops, not all of them)', async () => {
    const slug = `zzz-ei207-newer-${Math.random().toString(36).slice(2, 8)}`;
    await recordedWrite(slug, planBody(slug, 'local-head'));
    const { fedTs } = await liveFed(slug);

    const remoteBody = planBody(slug, 'remote-NEWER');
    await applyRemote(slug, remoteBody, fedTs + 10_000);

    const after = await getPlanRow(slug, { harnessSlug: HARNESS, workspaceId: wsId });
    expect(after!.content).toBe(remoteBody);
  }, 60_000);
});
