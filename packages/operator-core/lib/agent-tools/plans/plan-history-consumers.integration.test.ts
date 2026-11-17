/**
 * P-008 real-PostgreSQL proof for bounded plan-history delivery.
 *
 * One canonical plan row and one descendant checkpoint are read through the
 * actual production consumers: plans:get (including exact raw-ref recovery),
 * the launch context bundle, and the complete fleet leader-brief builder.  The
 * baseline-schema fixture keeps every store real while unique ids isolate this
 * suite from concurrent integration files.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import type { TurnResult } from '@papercusp/testing-shell/llm';
import { parseTestRunExecutionDetails, type ExecutionBoundaryReceipt } from '@papercusp/test-config/execution-details';
import { getOrgPg, getOrgPgApp } from '@papercusp/db-org';
import { canonicalJson } from '@papercusp/hash-chain';
import { appendGoalHistory } from '@papercusp/agent-mcp';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { PgThreadStore } from '@papercusp/coordination/capabilities';
import { workItemCheckpointScope, setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { getClaimTimePriorAttemptBrief, readGoalHistoryContext, readPlanHistoryContext, resolvePriorAttemptRefs } from '../../prior-attempt-context';
import { postLearnedAtLevel } from '../../effort-thread';
import { getWorkItem } from '../../work-items';
import { buildGoalKickoffBrief } from '../goals/start';
import { DEFAULT_CLAIM_SPEC } from '../../scheduler/claim-spec';
import { fleetSpecBeeKey, setClaimSpec } from '../../scheduler/claim-spec-store';
import { buildLeaderBrief } from '../fleet/leader-brief';
import plansGetTool from './get';
import workItemsGetTool from '../work_items/get';
import { buildPlanContextBundle } from './context-bundle';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import {
  GROUNDED_MANIFEST_SHA256, measureGroundedEvidence, readGroundedMeasurementRows,
  captureGroundedContractChanges, observeGroundedDurableHost,
  observeGroundedModelFetch, observeGroundedStoreReads, observeGroundedStoreOperations, observeGroundedToolDispatch,
  type GroundedMeasurementScope, type GroundedSchemaSnapshot,
  classifyGroundedBaseline, groundedBaselineCensus, readGroundedBaselineRows,
  type GroundedBaselinePin, type GroundedBaselineObservation,
} from '../../grounded-evidence-measurement';
import { recordRubricCheckResults } from '../../check-results-ledger';
import { materializeGroundedFixture } from '../../grounded-evidence-measurement';
import { loadImmutableTextArtifact, saveImmutableTextArtifact } from '../../text-artifacts';
import { resolveContainmentTree } from '../../containment-tree';
import { deriveIndexFromContent } from './derive-index';
import { writePlanIndexRows } from './plan-index-rows';
import { setSpecClause, listSpecClauses } from './spec-clauses-store';
import { measureRepoFilesEvidenceAtRoot, type RepoFilesEvidenceMeasurement } from './spec-evidence-store';
import { loadHarnessRegistry, saveHarnessRegistry } from '../../harness-registry';
import { writePlanItemAnchors } from '../../plan-items/anchor-store';
import { engineeringEvidenceStore } from '../../code-intelligence/engineering-evidence-store';
import { engineeringEvidenceQuery, readEngineeringEvidence } from '../../code-intelligence/engineering-evidence';
import { appendPipelineEvent } from '../../harness/git-sync/pipeline-events';
import { PgL2Store } from '../../cache/pg-l2-store';
import { recordCommitAttribution } from '../../edit-attribution';
import { FALLBACK_FLUSH_BATCH, flushFallbackObservations, observeFallback } from '../../degradation/fallback-observations';
import { createDurableCrashHarness } from '../../../test/_durable-orchestration-crash-harness';
import { composeDurableCaptureCensus } from '../../../test/_durable-orchestration-capture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-plan-history-${RUN}`;
const PLAN = `plan-history-consumers-${RUN}`;
const CHILD = `WI-plan-history-${RUN}`;
const DIRECT_GOAL_ITEM = `WI-goal-direct-${RUN}`;
const UNRELATED_ITEM = `WI-goal-unrelated-${RUN}`;
const FLEET = `plan-history-fleet-${RUN}`;
const GOAL = `goal-history-consumers-${RUN}`;
const GOAL_LESSON = 'A measured correction replaced the stale goal stop condition.';
const CHILD_ROOT_CAUSE = 'the delivery cursor advanced before projection';
const CHILD_LESSON =
  'Outcome: the descendant repair shipped. Root cause: the delivery cursor advanced before projection. Residue: preserve the exact recovery reference.';
const DIRECT_GOAL_LESSON =
  'Outcome: the direct goal repair shipped. Root cause: direct goal attachment must survive without a plan. Residue: retain direct-goal recovery.';
const UNRELATED_LESSON =
  'Outcome: unrelated sibling poison. Root cause: this object belongs to a different subject. Residue: never inject it.';

const PLAN_CONTENT = `---
title: Plan history consumer integration
status: active
---

# Plan history consumer integration

## Now

State: proving production history consumers.

Next: retain the descendant lesson in every leader-facing sink.

## Work

- **P-001** \`todo\` — Exercise bounded descendant history.

## Decisions

### D-001 — Preserve the current correction

Date: 2026-09-07

The plan's own authority remains current while child evidence contributes learned history.
`;

const CTX = {
  isSuperuser: true,
  uiClientId: 'su-plan-history-consumer-integration',
  workspaceId: 'default',
  harnessSlug: HARNESS,
  metadata: vi.fn(),
  log: vi.fn(),
  progress: vi.fn(),
} as never;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let previousWorkspaceId: string | undefined;
const capturedThreadIds = new Set<string>();
const proofMeasurementRoots = new Set<string>();

beforeAll(async () => {
  previousWorkspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  process.env.PAPERCUSP_WORKSPACE_ID = fx.workspaceId;

  await seedPlan(admin, fx.workspaceId, HARNESS, PLAN, PLAN_CONTENT);
  await insertGoalRow(admin, {
    id: GOAL,
    installSlug: HARNESS,
    workspaceId: fx.workspaceId,
    title: 'Goal history consumer integration',
    body: 'Prove the goal holder receives goal, plan and item history.',
    killCriterion: 'the bounded history consumer omits an admitted descendant',
    status: 'active',
  });
  await admin`
    UPDATE harness_shared.harness_plans
       SET goal_id = ${GOAL}
     WHERE workspace_id = ${fx.workspaceId}
       AND harness_slug = ${HARNESS}
       AND plan_slug = ${PLAN}
  `;
  await appendGoalHistory(admin, {
    workspaceId: fx.workspaceId,
    goalId: GOAL,
    author: 'su-goal-history-consumer-integration',
    detail: { kind: 'finding', summary: GOAL_LESSON, refs: [CHILD] },
  });
  await admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, summary, status,
       source_plan_slug, source_plan_item_ids, goal_id, payload, last_progress_at, created_ts, updated_ts)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${CHILD}, 'bug', 'Descendant delivery repair',
       'A completed child with a lesson the plan must inherit.', 'open', ${PLAN}, ARRAY['P-001'],
       ${GOAL}, ${admin.json({
         plan_item: { plan_slug: PLAN, item_id: 'P-001', harness_slug: HARNESS },
       })}, now(), ${Date.now()}, ${Date.now()}),
      (${fx.workspaceId}, ${HARNESS}, ${DIRECT_GOAL_ITEM}, 'bug', 'Direct goal repair',
       'A directly attached goal item with no plan edge.', 'open', NULL, NULL, ${GOAL},
       ${admin.json({})}, now(), ${Date.now()}, ${Date.now()}),
      (${fx.workspaceId}, ${HARNESS}, ${UNRELATED_ITEM}, 'bug', 'Unrelated sibling',
       'A same-harness item outside the goal and plan graph.', 'open', NULL, NULL, NULL,
       ${admin.json({})}, now(), ${Date.now()}, ${Date.now()})
  `;
  await setWorkItemCheckpoint({ harness: HARNESS, workItemId: CHILD, workspaceId: fx.workspaceId }, CHILD_LESSON);
  await setWorkItemCheckpoint(
    { harness: HARNESS, workItemId: DIRECT_GOAL_ITEM, workspaceId: fx.workspaceId },
    DIRECT_GOAL_LESSON,
  );
  await setWorkItemCheckpoint(
    { harness: HARNESS, workItemId: UNRELATED_ITEM, workspaceId: fx.workspaceId },
    UNRELATED_LESSON,
  );

  const stored = await setClaimSpec(
    {
      cupId: fleetSpecBeeKey(FLEET),
      workspaceId: fx.workspaceId,
      updatedBy: 'su-plan-history-consumer-integration',
      spec: {
        ...DEFAULT_CLAIM_SPEC,
        specId: `${FLEET}-lane`,
        view: { filter: { field: 'plan', op: '=', value: PLAN } },
      },
    },
    admin,
  );
  expect(stored).toMatchObject({ ok: true, errors: [] });
}, 90_000);

afterAll(async () => {
  for (const threadId of capturedThreadIds) {
    await admin`
      DELETE FROM harness_shared.coord_thread_posts
       WHERE workspace_id = ${fx.workspaceId} AND thread_id = ${threadId}
    `;
    await admin`
      DELETE FROM harness_shared.coord_threads
       WHERE workspace_id = ${fx.workspaceId} AND thread_id = ${threadId}
    `;
  }
  await admin`
    DELETE FROM harness_shared.carry_notes
     WHERE workspace_id = ${fx.workspaceId}
       AND scope = ANY(${[
         workItemCheckpointScope(HARNESS, CHILD),
         workItemCheckpointScope(HARNESS, DIRECT_GOAL_ITEM),
         workItemCheckpointScope(HARNESS, UNRELATED_ITEM),
       ]})
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = ${fx.workspaceId}
       AND harness_slug = ${HARNESS}
       AND feature_id = ANY(${[CHILD, DIRECT_GOAL_ITEM, UNRELATED_ITEM]})
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${fx.workspaceId}
       AND bee_id = ${fleetSpecBeeKey(FLEET)}
  `.catch(() => {});
  await cleanupPlans(admin, fx.workspaceId, HARNESS).catch(() => {});
  await admin`
    DELETE FROM harness_shared.audit_log
     WHERE workspace_id = ${fx.workspaceId}
       AND subject = ${GOAL}
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.goals
     WHERE workspace_id = ${fx.workspaceId}
       AND id = ${GOAL}
  `.catch(() => {});
  if (previousWorkspaceId === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = previousWorkspaceId;
  try { await fx?.dispose(); }
  finally {
    await Promise.all([...proofMeasurementRoots].map(root => rm(root, { recursive: true, force: true })));
  }
});

function dataOf<T>(value: unknown): T {
  return (value as { data: T }).data;
}

describe('bounded plan history production consumers', () => {
  it('captures a work-item correction at its own level and recovers the exact note from the claim brief', async () => {
    const note = [
      'Root cause: item history was read at the wrong level.',
      'False premise: a plan summary included every item thread.',
      'Outcome: the item claimant recovered the stored correction.',
      'Residue: validate the remaining callers.',
    ].join('\n');
    // Match the real create writer: a hand-seeded null created_ts turns into
    // createdAt:"", which is not a valid timestamp for a new issue thread.
    expect((await getWorkItem(CHILD, HARNESS))?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    capturedThreadIds.add(`issue-thread-${CHILD}`);
    const captured = await postLearnedAtLevel({
      workItemId: CHILD, harness: HARNESS, level: 'work_item', text: note,
      workspaceId: fx.workspaceId, authorId: 'su-item-capture-integration',
    });
    expect(captured, JSON.stringify(captured)).toMatchObject({
      posted: true, level: 'work_item', requestedLevel: 'work_item', fellBack: false,
    });
    expect(captured.post).toBeTruthy();
    capturedThreadIds.add(captured.post!.thread_id);
    const rawRef = `${CHILD}#comment:${captured.post!.id}`;
    const brief = await getClaimTimePriorAttemptBrief({ workItemId: CHILD, harness: HARNESS });
    expect(brief?.authority).toContainEqual(expect.objectContaining({
      rawRef, authority: 'retraction',
      falsePremises: ['a plan summary included every item thread.'],
    }));
    expect(brief?.protectedRefs.residue).toContain(rawRef);
    const raw = await resolvePriorAttemptRefs({
      target: { kind: 'work_item', ref: CHILD, harness: HARNESS }, harness: HARNESS, rawRefs: [rawRef],
    });
    const direct = await resolvePriorAttemptRefs({ workItemId: CHILD, harness: HARNESS, rawRefs: [rawRef] });
    expect(direct?.unresolved).toEqual([]);
    expect(direct?.records[0]?.text).toBe(note);
    expect(raw?.unresolved).toEqual([]);
    expect(raw?.records[0]?.text).toBe(note);
  });

  it.each(['work_item', 'plan', 'goal'] as const)('recovers exact %s archives beyond the recent-post window through real stores', async (level) => {
    const ref = level === 'work_item' ? CHILD : level === 'plan' ? PLAN : GOAL;
    const note = `Original ${level} archive: ${'preserved λ '.repeat(400)}`.trimEnd();
    const captured = await postLearnedAtLevel({
      workItemId: CHILD, harness: HARNESS, level, text: note,
      workspaceId: fx.workspaceId, authorId: 'su-exact-archive-integration',
    });
    expect(captured.post).toBeTruthy();
    const post = captured.post!;
    capturedThreadIds.add(post.thread_id);
    const store = new PgThreadStore({ getSql: () => admin, ensureSchema: async () => {}, workspaceId: fx.workspaceId });
    const ownIds = [post.id];
    const otherThreadId = `issue-thread-${UNRELATED_ITEM}`;
    const foreignWorkspace = `archive-foreign-${RUN}-${level}`;
    const foreignStore = new PgThreadStore({ getSql: () => admin, ensureSchema: async () => {}, workspaceId: foreignWorkspace });
    try {
      for (let index = 0; index < 30; index++) {
        const later = await store.addPost({ thread_id: post.thread_id, author_id: 'su-later-post-integration',
          body: `Later ${level} post ${index}`, created_ts: new Date().toISOString() });
        ownIds.push(later.id);
      }
      expect((await store.listRecentPosts(post.thread_id, 25)).posts.map((row) => row.id)).not.toContain(post.id);
      await store.getOrCreateThread({ kind: 'issue', ref: UNRELATED_ITEM }, {
        thread_id: otherThreadId, created_ts: new Date().toISOString(),
      });
      capturedThreadIds.add(otherThreadId);
      const other = await store.addPost({ thread_id: otherThreadId, body: 'Unrelated archive', created_ts: new Date().toISOString() });
      ownIds.push(other.id);
      await foreignStore.getOrCreateThread({ kind: 'issue', ref: CHILD }, {
        thread_id: post.thread_id, created_ts: new Date().toISOString(),
      });
      const foreign = await foreignStore.addPost({ thread_id: post.thread_id, body: 'Other workspace archive', created_ts: new Date().toISOString() });
      expect(await foreignStore.getPostById(foreign.id)).toMatchObject({ body: foreign.body });
      const prefix = `${level === 'work_item' ? ref : `${level}:${ref}`}#comment:`;
      const rawRef = `${prefix}${post.id}`;
      const excludedRefs = [`${prefix}${other.id}`, `${prefix}${foreign.id}`, `${prefix}999999999`];
      const recovered = await resolvePriorAttemptRefs({
        target: { kind: level, ref, harness: HARNESS }, harness: HARNESS,
        rawRefs: [rawRef, ...excludedRefs], timeoutMs: 10_000,
      });
      expect(recovered?.records).toContainEqual(expect.objectContaining({ rawRef, text: note, actor: post.author_id }));
      expect(recovered?.unresolved).toEqual(excludedRefs);
      if (level === 'work_item') {
        const read = dataOf<{ results: Array<{ priorAttemptRefResolution: { records: Array<{ rawRef: string; text: string }>; unresolved: string[] } }> }>(
          await workItemsGetTool.handler({ id: CHILD, harness: HARNESS, priorAttemptRefs: [rawRef] } as never, CTX),
        );
        expect(read.results[0]?.priorAttemptRefResolution.records).toContainEqual(expect.objectContaining({ rawRef, text: note }));
        expect(read.results[0]?.priorAttemptRefResolution.unresolved).toEqual([]);
      }
    } finally {
      // Restore the shared fixture before the other history-consumer scenarios.
      await admin`DELETE FROM harness_shared.coord_thread_posts WHERE workspace_id = ${fx.workspaceId} AND id = ANY(${ownIds})`;
      await admin`UPDATE harness_shared.coord_threads t SET post_count = (
        SELECT count(*) FROM harness_shared.coord_thread_posts p WHERE p.workspace_id = t.workspace_id AND p.thread_id = t.thread_id
      ) WHERE t.workspace_id = ${fx.workspaceId} AND t.thread_id = ANY(${[post.thread_id, otherThreadId]})`;
      await admin`DELETE FROM harness_shared.coord_thread_posts WHERE workspace_id = ${foreignWorkspace} AND thread_id = ${post.thread_id}`;
      await admin`DELETE FROM harness_shared.coord_threads WHERE workspace_id = ${foreignWorkspace} AND thread_id = ${post.thread_id}`;
    }
  }, 60_000);

  it.each(['plan', 'goal'] as const)('captures %s lessons and distinguishes a failed stored read from missing history', async (level) => {
    const ref = level === 'plan' ? PLAN : GOAL;
    const note = [
      `Root cause: ${level} thread failures were swallowed.`,
      `False premise: empty history proved no ${level} lesson existed.`,
      'Outcome: the actual saved note was recovered.',
      `Residue: retain the ${level} scoped drill-down.`,
    ].join('\n');
    const capture = await postLearnedAtLevel({
      workItemId: CHILD, harness: HARNESS, level, text: note,
      workspaceId: fx.workspaceId, authorId: 'su-capture-fidelity-integration',
    });
    expect(capture).toMatchObject({ posted: true, level, requestedLevel: level, fellBack: false });
    expect(capture.advisory?.missing).toEqual([]);
    expect(capture.post).toBeTruthy();
    capturedThreadIds.add(capture.post!.thread_id);
    const rawRef = `${level}:${ref}#comment:${capture.post!.id}`;
    const read = () => level === 'plan' ? readPlanHistoryContext(PLAN, HARNESS) : readGoalHistoryContext(GOAL);
    const original = PgThreadStore.prototype.getThreadByParent;
    const failure = vi.spyOn(PgThreadStore.prototype, 'getThreadByParent').mockImplementation(function (this: PgThreadStore, parent) {
      if (parent.kind === level && parent.ref === (level === 'plan' ? `${HARNESS}:${PLAN}` : GOAL)) {
        return Promise.reject(new Error('P010 stored effort thread unavailable'));
      }
      return original.call(this, parent);
    });
    let failed: Awaited<ReturnType<typeof read>>;
    try {
      failed = await read();
      expect(failed.status).toBe('unknown');
      expect(failed.brief?.degradedSources).toContain(`${level}-thread`);
      expect(JSON.stringify(failed)).not.toContain(rawRef);
    } finally {
      failure.mockRestore();
    }
    const recovered = await read();
    expect(recovered.status).toBe('available');
    expect(recovered.recovery).toEqual(failed!.recovery);
    expect(recovered.brief?.degradedSources).toEqual([]);
    expect(recovered.brief?.authority).toContainEqual(expect.objectContaining({
      rawRef, authority: 'retraction',
      falsePremises: [expect.stringContaining(`no ${level} lesson existed`)],
    }));
    expect(recovered.brief?.protectedRefs.residue).toContain(rawRef);
    const raw = await resolvePriorAttemptRefs({
      target: level === 'plan' ? { kind: level, ref, harness: HARNESS } : { kind: level, ref },
      harness: HARNESS, rawRefs: [rawRef],
    });
    expect(raw?.unresolved).toEqual([]);
    expect(raw?.records[0]?.text).toBe(note);
  }, 60_000);

  it('delivers one stored child lesson through plans:get, launch context and the full leader builder', async () => {
    const planRead = dataOf<{ results: Array<Record<string, unknown>> }>(
      await plansGetTool.handler({ slug: PLAN, harness: HARNESS, mode: 'full' } as never, CTX),
    );
    const planResult = planRead.results[0] as {
      history: {
        status: string;
        brief: { attempts: Array<{ rawRef: string; text: string }> };
      };
    };
    expect(planResult.history.status).toBe('available');
    const assertPlanScope = (output: string) => {
      expect(output).toContain(CHILD_LESSON);
      expect(output).not.toContain(DIRECT_GOAL_LESSON);
      expect(output).not.toContain(UNRELATED_LESSON);
    };
    const planOutput = JSON.stringify(planResult.history);
    assertPlanScope(planOutput);
    // Use the same final-sink oracle against omitted-descendant and cross-scope
    // faults. A green integration result must not accept either broken output.
    expect(() => assertPlanScope(planOutput.replaceAll(CHILD_LESSON, ''))).toThrow();
    expect(() => assertPlanScope(`${planOutput}\n${UNRELATED_LESSON}`)).toThrow();
    expect(() => assertPlanScope(`${planOutput}\n${DIRECT_GOAL_LESSON}`)).toThrow();
    const rawRef = planResult.history.brief.attempts.find((attempt) => attempt.rawRef.startsWith(`${CHILD}#`))?.rawRef;
    expect(rawRef).toBe(`${CHILD}#checkpoint`);

    const recoveredRead = dataOf<{ results: Array<Record<string, unknown>> }>(
      await plansGetTool.handler(
        { slug: PLAN, harness: HARNESS, heading: 'History', priorAttemptRefs: [rawRef] } as never,
        CTX,
      ),
    );
    expect(JSON.stringify(recoveredRead.results[0])).toContain(CHILD_LESSON);

    const bundle = await buildPlanContextBundle(PLAN, {
      workspaceId: fx.workspaceId,
      harnessSlug: HARNESS,
    });
    expect(bundle?.history?.status).toBe('available');
    expect(bundle?.text).toContain('PLAN HISTORY — own and bounded child evidence');
    expect(bundle?.text).toContain(CHILD_LESSON);
    expect(bundle?.text).toContain(rawRef);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leader = await buildLeaderBrief(
      { fleet: FLEET, harness: HARNESS, workspace: fx.workspaceId, include_stale: true },
      {
        ownerId: 'su-plan-history-consumer-integration',
        actorWorkspace: fx.workspaceId,
        allowLeadershipWrites: false,
        resolveCallerMembership: false,
      },
    );
    const unexpectedWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => !message.startsWith('[bounded-timeout]'));
    warn.mockRestore();
    expect(unexpectedWarnings).toEqual([]);
    expect(leader.data).toMatchObject({ ok: true, planHistory: { status: 'available' } });
    if (!('planHistory' in leader.data) || !leader.data.planHistory) {
      throw new Error('full leader output omitted planHistory');
    }
    expect(JSON.stringify(leader.data.planHistory)).toContain(CHILD_LESSON);
    expect(JSON.stringify(leader.data.planHistory)).toContain(rawRef);
  }, 60_000);

  it('delivers goal-owned, related-plan and child-item history into the goal holder brief with raw recovery', async () => {
    const history = await readGoalHistoryContext(GOAL);
    const serialized = JSON.stringify(history);
    expect(history.status).toBe('available');
    const assertGoalScope = (output: string) => {
      expect(output).toContain(GOAL_LESSON);
      expect(output).toContain('Preserve the current correction');
      expect(output).toContain(CHILD_ROOT_CAUSE);
      expect(output).toContain('direct goal attachment must survive without a plan');
      expect(output).not.toContain(UNRELATED_LESSON);
    };
    assertGoalScope(serialized);
    for (const omitted of [GOAL_LESSON, 'Preserve the current correction', CHILD_ROOT_CAUSE,
      'direct goal attachment must survive without a plan']) {
      expect(() => assertGoalScope(serialized.replaceAll(omitted, ''))).toThrow();
    }
    expect(() => assertGoalScope(`${serialized}\n${UNRELATED_LESSON}`)).toThrow();
    expect(history.brief?.rawRefs.filter((ref) => ref === `${CHILD}#checkpoint`)).toHaveLength(1);
    expect(history.brief?.rawRefs.filter((ref) => ref === `${DIRECT_GOAL_ITEM}#checkpoint`)).toHaveLength(1);
    expect(history.brief?.fanOut).toMatchObject({ truncated: false });

    const childRef = history.brief?.rawRefs.find((ref) => ref === `${CHILD}#checkpoint`);
    expect(childRef).toBe(`${CHILD}#checkpoint`);
    const recovered = await resolvePriorAttemptRefs({
      target: { kind: 'goal', ref: GOAL },
      rawRefs: [childRef!],
    });
    expect(recovered?.unresolved).toEqual([]);
    expect(recovered?.records[0]?.text).toContain(CHILD_LESSON);

    const kickoff = buildGoalKickoffBrief({
      goalId: GOAL,
      title: 'Goal history consumer integration',
      killCriterion: 'the current goal stop condition',
      history,
    });
    expect(kickoff).toContain('GOAL HISTORY — own and bounded descendant evidence');
    expect(kickoff).toContain(GOAL_LESSON);
    expect(kickoff).toContain('Preserve the current correction');
    expect(kickoff).toContain(CHILD_ROOT_CAUSE);
    expect(kickoff.indexOf('KILL THIS IF — the current goal stop condition')).toBeLessThan(
      kickoff.indexOf('GOAL HISTORY — own and bounded descendant evidence'),
    );
  }, 60_000);
});

describe('GEC insert-or-noop original byte recorder', () => {
  it('distinguishes real inserted values from unchanged conflict retries and uncertain writes', async () => {
    const pg = (await import('pg')).default;
    const client = new pg.Client({ connectionString: process.env.HARNESS_ADMIN_DATABASE_URL });
    const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
    const table = 'harness_shared.gec_insert_noop_' + digest(RUN).slice(0, 16);
    const statement = 'INSERT INTO ' + table + ' AS saved (id,payload,invocation) VALUES ($1,$2,$3)'
      + ' ON CONFLICT(id) DO UPDATE SET invocation=saved.invocation'
      + ' WHERE saved.invocation=EXCLUDED.invocation RETURNING invocation';
    const testHash = digest(await readFile(new URL(import.meta.url)));
    const scope: GroundedMeasurementScope = { workspaceId: fx.workspaceId, harness: HARNESS, potId: HARNESS,
      runId: 'insert-noop-' + RUN, ownerId: 'su-gec-recorder-control', caseId: 'C5', arm: 'pre', iteration: 1,
      manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: digest(statement), sourceFingerprint: testHash,
      testFingerprint: testHash, runtimeFingerprint: process.version, configFingerprint: digest(table) };
    const serializerSourceRef = 'source:pg/lib/query.js@' + digest(await readFile(new URL(
      '../../../../../node_modules/pg/lib/query.js', import.meta.url))) + '+utils.js@' + digest(await readFile(new URL(
      '../../../../../node_modules/pg/lib/utils.js', import.meta.url))) + '#Bind.prepareValue';
    const artifactRoot = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    const tapes: unknown[] = [];
    await client.connect();
    try {
      await client.query('CREATE TABLE ' + table + " (id text PRIMARY KEY, payload text CHECK(payload <> 'reject'), invocation text)");
      await client.query('INSERT INTO ' + table + " VALUES ('seed','original-seed','seed-invocation')");
      const originalRows = (await client.query('SELECT id FROM ' + table + ' ORDER BY id')).rows;
      const initial = { scope, sourceRef: 'original:private-pg-initial-keys', complete: true, exclusive: true,
        keyParameters: [0], initialKeys: originalRows.map(row => [digest(String(row.id))]) };
      const observe = () => observeGroundedStoreOperations({ scope, deps: {}, operations: [],
        sourceRef: 'original:private-pg-insert-noop', attemptId: 'insert-noop-' + tapes.length,
        nodePostgres: [{ pool: 'private-control', clientPrototype: pg.Client.prototype, queryPrototype: pg.Query.prototype,
          serializerSourceRef }], serializedSqlParameters: [{ pool: 'private-control', sourceRef: 'source:test@' + testHash,
          serializerSourceRef, queryHash: digest(statement), command: 'INSERT', parameterCount: 3, persistedParameters: [1],
          allOrNoneRows: 'zero-only', insertOrNoop: initial }] });
      let serializations = 0;
      const payload = { toPostgres: () => 'original-λ.😺-' + ++serializations };
      const tap = observe();
      try {
        const results = [];
        for (const [key, invocation] of [['new', 'new-invocation'], ['new', 'new-invocation'],
          ['seed', 'seed-invocation'], ['seed', 'other-invocation']])
          results.push(await tap.run(() => client.query(statement, [key, payload, invocation])));
        const census = tap.seal();
        expect(serializations).toBe(4);
        expect(results.map(result => result.rowCount)).toEqual([1, 1, 1, 0]);
        expect(census.complete).toBe(true);
        expect(census.rows.map(row => row.persistedBytes)).toEqual([Buffer.byteLength('original-λ.😺-1'), 0, 0, 0]);
        const measured = measureGroundedEvidence({ scope, storage: census, boundary: { scope, sourceRef: census.sourceRef,
          admittedAt: new Date().toISOString(), settledAt: new Date().toISOString(),
          monotonicStartMs: 0, monotonicEndMs: 1, drained: true } });
        expect(measured.values).toMatchObject({ storageOperations: 4, storageBytes: Buffer.byteLength('original-λ.😺-1') });
        tapes.push({ initial: structuredClone(initial), originalRows, census,
          results: results.map(result => ({ rowCount: result.rowCount, rows: result.rows })), serializations, measured });
      } finally { tap.restore(); }
      const unchanged = (await client.query('SELECT id,payload FROM ' + table + ' ORDER BY id')).rows;
      expect(unchanged).toEqual([{ id: 'new', payload: 'original-λ.😺-1' }, { id: 'seed', payload: 'original-seed' }]);
      // Keep an errored attempt uncertain even when this independent oracle can
      // later prove that this particular error rolled back.
      initial.initialKeys = unchanged.map(row => [digest(String(row.id))]);
      const negative = observe();
      try {
        await expect(negative.run(() => client.query(statement, ['uncertain', 'reject', 'negative']))).rejects.toThrow();
        await negative.run(() => client.query(statement, ['uncertain', 'valid', 'negative']));
        const census = negative.seal();
        expect(census.complete).toBe(true);
        expect(census.rows.map(row => row.persistedBytes)).toEqual([null, null]);
        tapes.push({ initial: structuredClone(initial), census });
      } finally { negative.restore(); }
      if (artifactRoot) await writeFile(join(artifactRoot, 'gec-insert-noop-byte-control.json'),
        canonicalJson({ acceptance: 'unmeasured', statement, testHash, serializerSourceRef, tapes, unchanged }));
    } finally {
      try { await client.query('DROP TABLE IF EXISTS ' + table); } finally { await client.end(); }
    }
  }, 90_000);
});

describe('GEC.N1-N8 persisted slice regression and cost', () => {
  const runFrozenHistory = async (branchPreflight: boolean, journeyPreflight = false,
    journeyControl: false | 'J1' | 'J2' | 'J3' = false,
    observedTransportControl: false | 'J2' | 'J3' = false) => {
    const readerPreflight = branchPreflight || journeyPreflight;
    const syntheticTransport = Boolean(journeyControl || observedTransportControl);
    const phase = branchPreflight ? 'reader-branches' : journeyPreflight ? 'j1-readers'
      : observedTransportControl ? `${observedTransportControl.toLowerCase()}-observed-transport-control`
        : journeyControl ? `${journeyControl.toLowerCase()}-transport-control` : 'full';
    const artifactRoot = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    const artifactDirectory = artifactRoot && (readerPreflight || syntheticTransport
      ? join(artifactRoot, branchPreflight ? 'q2-reader-branches' : phase) : artifactRoot);
    if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });
    const phaseStart = performance.now();
    const phaseEvents: Array<{ stage: string; at: string; elapsedMs: number }> = [];
    const recordPhase = async (stage: string) => {
      phaseEvents.push({ stage, at: new Date().toISOString(), elapsedMs: performance.now() - phaseStart });
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-preflight-progress.json'),
        canonicalJson({ phase, acceptance: 'unmeasured', phaseEvents }));
    };
    await recordPhase('fixture-start');
    // Fixture verification is separate from product correctness: this must not
    // certify the resolver, time-window support, or any paired cost budget.
    const fixtureToken = `stores-${RUN}-${phase}`;
    const namespace = materializeGroundedFixture(fixtureToken).manifest.namespace;
    // Named cases share this private DB. Allocate store identities per
    // invocation; a failed case must not poison the next case's goal key.
    const identityKeys = Object.fromEntries([namespace.harness, namespace.plan, namespace.goal,
      namespace.item, namespace.unrelatedItem]
      .map(key => [key, `${key}-${RUN}-${phase}`]));
    const initial = materializeGroundedFixture(fixtureToken, identityKeys);
    const { namespace: n, seed } = initial.manifest;
    const workspace = fx.workspaceId;
    const h = initial.mapping[n.harness];
    const p = initial.mapping[n.plan];
    const g = initial.mapping[n.goal];
    const item = initial.mapping[n.item];
    const unrelated = initial.mapping[n.unrelatedItem];
    const verificationItem = `${item}-verification`;
    const verificationFile = 'packages/operator-core/lib/prior-attempt-context.rollup.test.ts';
    const foreignWorkspace = initial.mapping[n.foreignWorkspace];
    const stamp = Date.parse(seed.recordedFrom);
    const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const sourcePath = 'packages/operator-core/lib/prior-attempt-context.ts';
    const sourceBytes = await readFile(new URL('../../prior-attempt-context.ts', import.meta.url));
    const testBytes = await readFile(new URL(import.meta.url));
    const sourceHash = digest(sourceBytes);
    const testHash = digest(testBytes);
    // A private, non-git root makes the synthetic control independent of peer
    // commits. Copy the exact input bytes; canonical measurement hashes the
    // {path,sha256} file sets, not these raw file hashes. This is fixture
    // currentness only, never evidence that the copied test actually executed.
    const proofRoot = await mkdtemp(join(tmpdir(), 'gec-proof-measurement-'));
    proofMeasurementRoots.add(proofRoot);
    const proofTestPath = 'gec-b-fixture.integration.test.ts';
    await mkdir(dirname(join(proofRoot, sourcePath)), { recursive: true });
    await writeFile(join(proofRoot, sourcePath), sourceBytes);
    await writeFile(join(proofRoot, proofTestPath), testBytes);
    const proofRecipe: RepoFilesEvidenceMeasurement = { schemaVersion: 1, kind: 'repo-files',
      rootHarnessSlug: h, sourcePaths: [sourcePath], testPaths: [proofTestPath] };
    const proofFingerprints = await measureRepoFilesEvidenceAtRoot(proofRoot, proofRecipe);
    expect(proofFingerprints.sourceFingerprint).not.toBe(sourceHash);
    expect(proofFingerprints.testFingerprint).not.toBe(testHash);
    // Independent admitted cohort, read at both boundaries. Raw code retains
    // refinements/authorization and undeclared output contracts that JSON Schema
    // cannot express. A changed source refuses zero until an exact detector is
    // supplied; this named cohort is not repository-wide or serving qualification.
    const contractPaths = [
      'packages/operator-core/lib/prior-attempt-context.ts',
      'packages/operator-core/lib/code-intelligence/engineering-evidence.ts',
      'packages/operator-core/lib/code-intelligence/engineering-evidence-store.ts',
      'packages/operator-core/lib/agent-tools/plans/get.ts',
      'packages/operator-core/lib/agent-tools/work_items/get.ts',
      'packages/operator-core/lib/agent-tools/gitnexus/query.ts',
      'packages/operator-core/lib/agent-tools/work_items/complete.ts',
      'packages/operator-core/lib/agent-tools/scorecards/emit.ts',
      'packages/operator-core/lib/agent-tools/plans/rubric-template.ts',
      'packages/operator-core/lib/acceptance-bar-contract-snapshot.ts',
      'packages/operator-core/lib/plan-acceptance-gate.ts',
      'packages/operator-core/lib/work-item-blocking.ts',
      'packages/operator-core/lib/work-item-definition.ts',
      'libs/generic/tooldef/src/tool-projection.ts',
      'libs/generic/tooldef/src/dispatch-projected.ts',
      'libs/generic/tooldef/src/authz.ts',
    ];
    const [{ listAllProjectedTools, toJsonSchema }, { acceptanceRubricCriterionSchema }, { WorkItemDefinitionSchema }] = await Promise.all([
      import('@papercusp/tooldef'), import('./rubric-template'), import('../../work-item-definition'),
      import('../gitnexus/query'),
    ]);
    const contractNames = ['graph:query', 'plans:get', 'work_items:get'];
    const readContracts = async (sourceFingerprint: string, sourceRef: string): Promise<GroundedSchemaSnapshot> => {
      const projected = listAllProjectedTools();
      const rows = contractNames.map(id => {
        const tool = projected.find(candidate => candidate.expose.mcp?.name === id);
        if (!tool) throw new Error(`Missing admitted GEC contract: ${id}`);
        return { id, inputSchema: tool.discoveryInputSchema ?? tool.inputSchema,
          resultSchema: tool.outputJsonSchema ?? {},
          // No schema validator at these channels. Original enforcement code
          // and metadata below cover them instead of a fabricated projection.
          authoritySchema: {}, acceptanceSchema: {} };
      });
      rows.push({ id: 'acceptance:criterion', inputSchema: {}, resultSchema: {}, authoritySchema: {},
        acceptanceSchema: toJsonSchema(acceptanceRubricCriterionSchema) });
      rows.push({ id: 'acceptance:work-definition', inputSchema: {}, resultSchema: {}, authoritySchema: {},
        acceptanceSchema: toJsonSchema(WorkItemDefinitionSchema) });
      const sources = await Promise.all(contractPaths.map(async id => {
        const body = await readFile(new URL(id, new URL('../../../../../', import.meta.url)), 'utf8');
        return { id, sourceRef: `current-source:${id}`, body, sha256: digest(body) };
      }));
      const authority = contractNames.map(id => {
        const tool = projected.find(candidate => candidate.expose.mcp?.name === id)!;
        return { id, capabilities: tool.capabilities, effect: tool.effect ?? null,
          agentRoles: tool.agentRoles ?? null, requirePrincipal: tool.requirePrincipal ?? null,
          requireRoles: tool.requireRoles ?? null };
      });
      const body = canonicalJson(authority);
      const metadataId = 'projected-authority-metadata';
      sources.push({ id: metadataId, sourceRef: 'current-source:projected-tool-registry', body, sha256: digest(body) });
      return { sourceRef, sourceFingerprint, complete: true,
        requiredKinds: ['input', 'result', 'authority', 'acceptance'],
        ids: [...contractNames, 'acceptance:criterion', 'acceptance:work-definition'], rows,
        sourceFiles: { ids: [...contractPaths, metadataId], rows: sources } };
    };
    const content = `---\ntitle: Frozen B history fixture\nstatus: active\n---\n# Frozen B history fixture\n\n## Work\n\n- **P-001** \`todo\` Retain exact seeded evidence.\n- **P-999** \`todo\` Isolate the missing measurement recipe control.\n\n## Decisions\n\n### D-001 — Retired target\nRelated: P-001\n\nThe prior target is retired.\n\n### ${seed.bindingDecision.id} — Current scoped reader\nDate: ${seed.bindingDecision.recorded}\nRelated: P-001\n\n${seed.bindingDecision.body}\n`;
    await seedPlan(admin, workspace, h, p, content);
    await seedPlan(admin, foreignWorkspace, h, p, content);
    await seedPlan(admin, workspace, n.foreignHarness, p, content);
    const registry = await loadHarnessRegistry(workspace);
    await saveHarnessRegistry({ ...registry, projects: [
      ...registry.projects.filter(project => project.slug !== h),
      { slug: h, path: proofRoot, hive_slug: h },
    ] }, workspace);
    // seedPlan already registers the Pot. Bind the frozen logical identity to
    // that actual composite key instead of creating a parallel fixture Pot.
    const pots = await admin`SELECT workspace_id,pot_home_slug FROM harness_shared.pots
      WHERE (workspace_id=${workspace} AND pot_home_slug=ANY(${[h, n.foreignHarness]}))
        OR (workspace_id=${foreignWorkspace} AND pot_home_slug=${h})
      ORDER BY workspace_id,pot_home_slug`;
    expect(pots).toHaveLength(3);
    const potIdentity = (workspaceId: string, potHomeSlug: string) => canonicalJson([workspaceId, potHomeSlug]);
    await insertGoalRow(admin, { id: g, installSlug: h, workspaceId: workspace,
      title: 'Frozen B goal', body: 'Immutable fixture setup; no accepted result.',
      killCriterion: 'Fixture bytes or store identities disagree with the frozen manifest.', status: 'active' });
    await admin`UPDATE harness_shared.harness_plans SET goal_id=${g}
      WHERE workspace_id=${workspace} AND harness_slug=${h} AND plan_slug=${p}`;
    const logicalChildren = Array.from({ length: 25 }, (_, index) => `child-${String(index + 1).padStart(2, '0')}`);
    const children = logicalChildren.map(id => `${item}-${id}`);
    const occupiedItems = await admin`SELECT feature_id FROM harness_shared.work_items
      WHERE workspace_id=${workspace} AND feature_id=ANY(${[item, unrelated, verificationItem, ...children]})`;
    expect(occupiedItems, 'allocate every workspace-unique fixture item before seeding').toEqual([]);
    for (const id of [item, unrelated, verificationItem, ...children]) {
      const contained = children.includes(id);
      await admin`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,item_kind,title,summary,status,source_plan_slug,
          source_plan_item_ids,goal_id,payload,created_ts,updated_ts)
        VALUES (${workspace},${h},${id},'task',${id},'Frozen B isolated fixture','open',
          ${contained ? p : null},${contained ? ['P-001'] : null},${contained ? g : null},
          ${admin.json({})},${stamp},${stamp})`;
    }
    await admin.begin(async tx => {
      await writePlanIndexRows(tx as never, { workspaceId: workspace, harnessSlug: h, planSlug: p }, deriveIndexFromContent(content));
      await writePlanItemAnchors(tx, { workspaceId: workspace, harnessSlug: h, planSlug: p }, {
        itemId: 'P-001', anchors: [{ id: undefined, anchorKind: 'path', requested: sourcePath,
          symbolId: null, symbolName: null, path: sourcePath, line: null, signature: null,
          contentHash: sourceHash, consumers: [], consumersTotal: 0, tests: [], resolution: 'resolved',
          unknownReason: null, freshness: 'fresh', resolvedCommit: null }],
      }, 'su-gec-fixture');
      for (let expectedRevision = 0; expectedRevision < seed.proof.applicableSpecRevision; expectedRevision++) {
        const saved = await setSpecClause({ planSlug: p, specId: n.spec, expectedRevision, planItemId: 'P-001',
          behavior: expectedRevision === 0 ? 'Prior frozen fixture revision.' : seed.bindingDecision.body,
          behaviorClass: 'happy-path', requiredEvidence: ['tree'], requiredTestLayers: ['integration'],
          mutationRequired: false, lifecycleStatus: 'active', actorId: 'su-gec-fixture',
          falsifier: { observation: 'A foreign record is admitted as this fixture proof.',
            probeMethod: 'Resolve the frozen physical identity and its foreign-workspace control.' },
        }, { executor: tx as never, workspaceId: workspace, harnessSlug: h });
        expect(saved.status).toBe(expectedRevision === 0 ? 'created' : 'revised');
      }
    });
    const [spec] = await listSpecClauses({ workspaceId: workspace, harnessSlug: h, planSlug: p,
      specIds: [n.spec], revision: seed.proof.applicableSpecRevision, limit: 1 });
    expect(spec).toMatchObject({ specId: n.spec, revision: seed.proof.applicableSpecRevision });
    const seedSpecRevisionEdge = async (specId: string, revision: number, fingerprint: string) => {
      const edges = await admin`INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,created_by)
        VALUES (${workspace},${h},${item},${p},${specId},${revision},${fingerprint},'su-gec-fixture')
        RETURNING workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint`;
      expect(edges, 'each immutable binding requires its exact seven-column revision edge').toEqual([
        { workspace_id: workspace, harness_slug: h, work_item_id: item, plan_slug: p,
          spec_id: specId, spec_revision: revision, spec_fingerprint: fingerprint },
      ]);
    };
    await seedSpecRevisionEdge(n.spec, spec.revision, spec.contentHash);
    // This is a synthetic authority fixture in the disposable store. It is
    // deliberately never inserted into the live test ledger as passing proof.
    const [proofRun] = await admin`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,framework,status,source,worktree_dirty,started_at)
      VALUES (${workspace},${h},'gec-b-fixture.integration.test.ts','vitest','pass','local',false,
        ${new Date(stamp)}) RETURNING id,status,started_at`;
    const [newerFailedRun] = await admin`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,framework,status,source,worktree_dirty,started_at)
      VALUES (${workspace},${h},'gec-b-fixture.integration.test.ts','vitest','fail','local',false,
        ${new Date(stamp + 1)}) RETURNING id,status,started_at`;
    expect(new Date(newerFailedRun.started_at).getTime()).toBeGreaterThan(new Date(proofRun.started_at).getTime());
    // Generated artifact keys are independent of product output. These are
    // synthetic deployment fixtures in disposable PG, never a live shipment.
    const artifactKey = (logical: string) => createHash('sha1').update(`${fixtureToken}:${logical}`).digest('hex');
    const targetArtifact = artifactKey(seed.proof.targetArtifact);
    const oldArtifact = artifactKey(n.oldArtifact);
    await recordCommitAttribution([{ workspaceId: workspace, harnessSlug: h, repo: 'superproject',
      commitSha: targetArtifact, file: sourcePath, workItemId: item, planSlug: p,
      agentId: 'su-gec-fixture', committedAt: seed.bindingDecision.recorded }]);
    const commitAttributions = await admin`SELECT id,workspace_id,harness_slug,commit_sha,file,work_item_id,plan_slug
      FROM harness_shared.git_sync_commit_attribution
      WHERE workspace_id=${workspace} AND harness_slug=${h} AND commit_sha=${targetArtifact}`;
    expect(commitAttributions).toHaveLength(1);
    expect(commitAttributions[0]).toMatchObject({ work_item_id: item, file: sourcePath, plan_slug: p });
    await admin`UPDATE harness_shared.test_runs SET commit_sha=${targetArtifact}
      WHERE workspace_id=${workspace} AND harness_slug=${h} AND id=${proofRun.id}`;
    // Reuse the private reference-resolution control from
    // engineering-evidence-reference.integration.test.ts. These correlated
    // records simulate the positive input; they are NOT an actual execution or
    // a shipment receipt and never leave this disposable database as live proof.
    const proofCase = 'gec-b-fixture.scoped-reader';
    const proofReceipt = {
      boundary: 'graph:query:evidence', callId: `gec-b-proof-${fixtureToken}`,
      workspaceId: workspace, harness: h, traceId: digest(`${fixtureToken}:trace`).slice(0, 32),
      spanId: digest(`${fixtureToken}:span`).slice(0, 16),
      parentSpanId: digest(`${fixtureToken}:parent`).slice(0, 16), traceFlags: 1,
      startedAt: stamp + 5, endedAt: stamp + 10, outcome: 'ok', sourceFingerprint: sourceHash,
      buildSha: targetArtifact, artifactFingerprint: digest(targetArtifact),
      environmentFingerprint: digest(`isolated-pg:${fixtureToken}`), workflowId: null,
    } satisfies ExecutionBoundaryReceipt;
    const proofObservation = { caseKey: proofCase, occurrence: 1, receipt: proofReceipt };
    const proofDetails = {
      schemaVersion: 1, root: proofRoot, filePath: proofTestPath,
      runGroupId: null, workspaceId: workspace, harnessSlug: h, testNamePattern: null,
      mutationPhase: null, commitSha: targetArtifact, worktreeDirty: false,
      collectionFailed: false, passed: 1, failed: 0, skipped: 0,
      boundaryObservations: [proofObservation],
    };
    expect(parseTestRunExecutionDetails(proofDetails)).toBeDefined();
    await admin`INSERT INTO harness_shared.test_case_runs
      (test_run_id,case_index,case_key,occurrence,status)
      VALUES (${proofRun.id},0,${proofCase},1,'pass')`;
    const [proofInvocation] = await admin`INSERT INTO harness_shared.tool_invocations
      (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,status,
        serving_build_sha,invoked_at,metadata_json)
      VALUES (${workspace},${h},'papercusp','graph:query','operator','su-gec-fixture',
        ${proofReceipt.callId},'ok',${targetArtifact},${new Date(stamp + 7)},
        ${admin.json({ otel: { callId: proofReceipt.callId, traceId: proofReceipt.traceId,
          spanId: proofReceipt.parentSpanId, traceFlags: 1, boundaryObservations: [proofReceipt] } })})
      RETURNING id`;
    await admin`UPDATE harness_shared.test_runs SET finished_at=${new Date(stamp + 20)},
      execution_details=${admin.json(proofDetails)}
      WHERE workspace_id=${workspace} AND harness_slug=${h} AND id=${proofRun.id}`;
    for (const [receiptWorkspace, receiptHarness] of [[workspace, h], [foreignWorkspace, h], [workspace, n.foreignHarness]]) {
      await appendPipelineEvent({ workspaceId: receiptWorkspace, installSlug: receiptHarness,
        kind: 'deploy', status: 'ok', detail: { targetSha: targetArtifact.slice(0, 12),
          fullTargetSha: targetArtifact, commits: 1, migrations: 0 } }, admin, { required: true });
    }
    const deployments = await admin`SELECT id,workspace_id,install_slug,kind,status,detail,created_at
      FROM harness_shared.pipeline_events WHERE kind='deploy' AND detail->>'fullTargetSha'=${targetArtifact}
      ORDER BY id`;
    expect(deployments).toHaveLength(3);
    const ownDeployments = deployments.filter(row => row.workspace_id === workspace && row.install_slug === h);
    expect(ownDeployments).toHaveLength(1);
    const deployment = ownDeployments[0];
    expect(deployment).toMatchObject({ kind: 'deploy', status: 'ok', detail: {
      targetSha: targetArtifact.slice(0, 12), fullTargetSha: targetArtifact, commits: 1, migrations: 0,
    } });
    // The production receipt has a commit identity, not requirement or proof
    // bindings. Retain that gap; fixture materialization cannot certify Q2.
    expect(deployment.detail).not.toHaveProperty('specFingerprint');
    expect(deployment.detail).not.toHaveProperty('testRunId');
    const [binding] = await admin`INSERT INTO harness_shared.spec_evidence_bindings
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
        evidence_kind,evidence_ref,source_fingerprint,test_fingerprint,test_run_id,binding_fingerprint,created_by,details)
      VALUES (${workspace},${h},${item},${p},${n.spec},${spec.revision},${spec.contentHash},
        'test',${proofTestPath},${proofFingerprints.sourceFingerprint},${proofFingerprints.testFingerprint},
        ${proofRun.id},${digest(canonicalJson(seed.proof))},
        'su-gec-fixture',${admin.json({ currentMeasurement: proofRecipe })}) RETURNING id`;
    const [anchor] = await admin`SELECT id FROM harness_shared.plan_item_anchors
      WHERE workspace_id=${workspace} AND harness_slug=${h} AND plan_slug=${p} AND item_id='P-001'`;
    const threadStore = new PgThreadStore({ getSql: () => admin, ensureSchema: async () => {}, workspaceId: workspace });
    const foreignStore = new PgThreadStore({ getSql: () => admin, ensureSchema: async () => {}, workspaceId: foreignWorkspace });
    // The thread primary key is workspace-wide. A shared run token can
    // silently resolve a prior named fixture's thread through the PK fallback.
    const planThread = await threadStore.getOrCreateThread({ kind: 'plan', ref: `${h}:${p}` },
      { thread_id: `gec-b-plan-${fixtureToken}`, created_ts: seed.bindingDecision.recorded });
    const childThread = await threadStore.getOrCreateThread({ kind: 'issue', ref: children[24] },
      { thread_id: `gec-b-child-25-${fixtureToken}`, created_ts: seed.bindingDecision.recorded });
    const ownThread = await threadStore.getOrCreateThread({ kind: 'issue', ref: item },
      { thread_id: `gec-b-item-${fixtureToken}`, created_ts: seed.bindingDecision.recorded });
    const otherThread = await threadStore.getOrCreateThread({ kind: 'issue', ref: unrelated },
      { thread_id: `gec-b-other-${fixtureToken}`, created_ts: seed.bindingDecision.recorded });
    const seededThreads = await admin`SELECT thread_id,parent_kind,parent_ref FROM harness_shared.coord_threads
      WHERE workspace_id=${workspace} AND thread_id=ANY(${[planThread, childThread, ownThread, otherThread]
        .map(thread => thread.thread_id)}) ORDER BY thread_id`;
    expect(seededThreads).toEqual([
      { thread_id: childThread.thread_id, parent_kind: 'issue', parent_ref: children[24] },
      { thread_id: ownThread.thread_id, parent_kind: 'issue', parent_ref: item },
      { thread_id: otherThread.thread_id, parent_kind: 'issue', parent_ref: unrelated },
      { thread_id: planThread.thread_id, parent_kind: 'plan', parent_ref: `${h}:${p}` },
    ].sort((a, b) => a.thread_id.localeCompare(b.thread_id)));
    await foreignStore.getOrCreateThread({ kind: 'issue', ref: item },
      { thread_id: ownThread.thread_id, created_ts: seed.bindingDecision.recorded });
    const archive = await threadStore.addPost({ thread_id: ownThread.thread_id,
      body: seed.exactArchive.body, created_ts: seed.bindingDecision.recorded });
    for (let index = 0; index < seed.exactArchive.laterPosts; index++) {
      await threadStore.addPost({ thread_id: ownThread.thread_id, body: `Later frozen B post ${index + 1}`,
        created_ts: new Date(stamp + index).toISOString() });
    }
    const foreignThreadPost = await threadStore.addPost({ thread_id: otherThread.thread_id,
      body: seed.exactArchive.body, created_ts: seed.bindingDecision.recorded });
    const foreignWorkspacePost = await foreignStore.addPost({ thread_id: ownThread.thread_id,
      body: seed.exactArchive.body, created_ts: seed.bindingDecision.recorded });
    const storeKeys: Record<string, string> = { ...identityKeys,
      ...Object.fromEntries(logicalChildren.map((id, index) => [id, children[index]])), [n.workspace]: workspace,
      [n.pot]: potIdentity(workspace, h), [n.foreignPot]: potIdentity(workspace, n.foreignHarness),
      [n.artifact]: targetArtifact, [n.oldArtifact]: oldArtifact,
      [seed.proof.deploymentReceipt]: `pipeline-event:${deployment.id}`,
      [seed.proof.newerFailedRun]: `test-run:${newerFailedRun.id}`,
      [n.proofRun]: `test-run:${proofRun.id}`, [seed.proof.implementationAnchor]: `plan-anchor:${anchor.id}`,
      [seed.proof.passingSourceFingerprint]: sourceHash, [seed.proof.passingTestFingerprint]: testHash,
      [seed.exactArchive.logicalPost]: String(archive.id),
      [seed.exactArchive.foreignThreadPost]: String(foreignThreadPost.id),
      [seed.exactArchive.foreignWorkspacePost]: String(foreignWorkspacePost.id) };
    for (const event of seed.events) {
      const post = await threadStore.addPost({ thread_id: event.id === 'e2' ? childThread.thread_id : planThread.thread_id,
        body: `Outcome: ${event.id}`, created_ts: event.recorded });
      storeKeys[event.id] = String(post.id);
    }
    const materialized = materializeGroundedFixture(fixtureToken, storeKeys);
    // C1 is four persisted containment edges, not four labels on direct
    // children. The existing reader's inability to follow a sub-goal is an
    // observed baseline outcome, never permission to flatten this fixture.
    const resumeRoot = `${g}-resume-root`, resumeBridge = `${g}-resume-bridge`;
    const protectedResumeLesson = 'Use the staging reader; the archived service has already been retired.';
    for (const [id, parent, body] of [
      [resumeRoot, null, `Continue the work in descendant plan ${p}.`],
      [resumeBridge, resumeRoot, 'Preserve descendant continuity.'],
    ] as const) {
      await insertGoalRow(admin, { id, installSlug: h, workspaceId: workspace,
        title: id, body, killCriterion: 'The frozen resume action is incorrect.', status: 'active' });
      await admin`UPDATE harness_shared.goals SET parent_id=${parent}
        WHERE workspace_id=${workspace} AND id=${id}`;
    }
    await admin`UPDATE harness_shared.goals SET parent_id=${resumeBridge}
      WHERE workspace_id=${workspace} AND id=${g}`;
    await setWorkItemCheckpoint({ workspaceId: workspace, harness: h, workItemId: children[24] }, protectedResumeLesson);
    const resumeEdges = await admin`SELECT id,parent_id FROM harness_shared.goals
      WHERE workspace_id=${workspace} AND id=ANY(${[resumeRoot, resumeBridge, g]}) ORDER BY id`;
    expect(resumeEdges.find(row => row.id === g)?.parent_id).toBe(resumeBridge);
    expect(resumeEdges.find(row => row.id === resumeBridge)?.parent_id).toBe(resumeRoot);
    const resumeChain = await admin`WITH RECURSIVE lineage AS (
      SELECT id,parent_id,0 AS depth FROM harness_shared.goals WHERE workspace_id=${workspace} AND id=${resumeRoot}
      UNION ALL SELECT child.id,child.parent_id,lineage.depth+1 FROM harness_shared.goals child
        JOIN lineage ON child.parent_id=lineage.id WHERE child.workspace_id=${workspace} AND lineage.depth<4
    ) SELECT w.feature_id,lineage.depth+2 AS depth FROM lineage
      JOIN harness_shared.harness_plans hp ON hp.workspace_id=${workspace} AND hp.goal_id=lineage.id
      JOIN harness_shared.work_items w ON w.workspace_id=${workspace} AND w.harness_slug=hp.harness_slug
        AND w.source_plan_slug=hp.plan_slug WHERE w.feature_id=${children[24]}`;
    expect(resumeChain).toEqual([{ feature_id: children[24], depth: 4 }]);
    const switchPlan = `${p}-resume-switch`;
    const switchContent = (current: boolean) => `---\ntitle: Resume target switch\nstatus: active\n---\n# Resume target switch\n\n## Now\n\nNext: read the work item selected by the current decision.\n\n## Work\n\n- **P-001** \`todo\` Resume the selected target.\n\n## Decisions\n\n### D-001 — Original target${current ? ' (superseded by D-002)' : ''}\nRelated: P-001\n\nRead ${item}.\n${current ? `\n### D-002 — Current target\nRelated: P-001\n\nD-001 is superseded. Read ${unrelated}; do not resume ${item}.\n` : ''}`;
    const writeSwitchFixture = async (current: boolean) => {
      const body = switchContent(current);
      await seedPlan(admin, workspace, h, switchPlan, body);
      await admin.begin(tx => writePlanIndexRows(tx as never,
        { workspaceId: workspace, harnessSlug: h, planSlug: switchPlan }, deriveIndexFromContent(body)));
    };
    await writeSwitchFixture(false);
    const staleSwitchBundle = await buildPlanContextBundle(switchPlan, { workspaceId: workspace, harnessSlug: h });
    expect(staleSwitchBundle?.text).toContain(`Read ${item}.`);
    expect(staleSwitchBundle?.text).not.toContain('### D-002');
    await writeSwitchFixture(true);
    const currentSwitchBundle = await buildPlanContextBundle(switchPlan, { workspaceId: workspace, harnessSlug: h });
    expect(currentSwitchBundle?.text).toContain(`Read ${unrelated}; do not resume ${item}.`);
    // C4's edit is fixture state. Its unfinished verification is persisted at
    // the real work-item boundary, then rediscovered by the actual resume reader.
    await setWorkItemCheckpoint({ workspaceId: workspace, harness: h, workItemId: verificationItem },
      `## Did\nThe source edit is complete in this isolated fixture.\n\n## Left\nFocused verification remains unfinished; no passing result has been recorded.\n\n## Next action\nRun testing:run with files=["${verificationFile}"] before completing this work item.`);
    const capture = { kind: 'fixture-materialization', acceptance: 'unmeasured',
      ...materialized, fixtureSourceHash: digest(await readFile(new URL('../../grounded-evidence-fixture.json', import.meta.url))),
      testSourceHash: testHash, consumerSourceHash: sourceHash,
      physicalStores: { pots, commitAttributions, resumeEdges, resumeChain,
        proofControl: { kind: 'synthetic-private-reference-control', invocationId: Number(proofInvocation.id),
          measurement: { recipe: proofRecipe, fingerprints: proofFingerprints, root: proofRoot },
          case: { runId: Number(proofRun.id), key: proofCase, occurrence: 1, status: 'pass' },
          observation: proofObservation, executionDetails: proofDetails },
        resumeFixtures: { resumeRoot, resumeBridge, descendantGoal: g, plan: p, item: children[24],
          verificationItem, verificationFile,
          protectedResumeLesson, switchPlan, staleSwitchBundle, currentSwitchBundle },
        deployments: deployments.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
        proofRuns: [proofRun, newerFailedRun].map(row => ({ ...row, started_at: new Date(row.started_at).toISOString() })) },
      deploymentQualification: 'Synthetic isolated receipt with exact scope and generated commit identity; no requirement, proof or served-artifact qualification.' };
    const original = canonicalJson(capture);
    const retained = await saveImmutableTextArtifact(h, original);
    expect(await loadImmutableTextArtifact(h, retained.sha256)).toBe(original);
    expect(digest(original)).toBe(retained.sha256);
    expect(materialized.manifestHash).toBe(GROUNDED_MANIFEST_SHA256);
    expect(new Set(Object.values(materialized.mapping)).size).toBe(Object.keys(materialized.mapping).length);
    expect(materialized.manifest).toEqual(initial.manifest);
    expect(materialized.mapping[n.pot]).toBe(potIdentity(workspace, h));
    expect(pots.some(row => potIdentity(row.workspace_id, row.pot_home_slug) === materialized.mapping[n.pot])).toBe(true);
    expect(materialized.mapping[seed.proof.deploymentReceipt]).toBe(`pipeline-event:${deployment.id}`);
    expect(materialized.mapping[seed.proof.newerFailedRun]).toBe(`test-run:${newerFailedRun.id}`);
    if (artifactDirectory) {
      await writeFile(join(artifactDirectory, 'gec-b-fixture.json'), original);
      expect(await readFile(join(artifactDirectory, 'gec-b-fixture.json'), 'utf8')).toBe(original);
    }

    // Verify physical records, with independent original seed values as the
    // oracle. Exact public resolver behavior is exercised in the consumer arm.
    const persistedArchive = await threadStore.getPostById(Number(materialized.mapping['archive-01']));
    expect(persistedArchive).toMatchObject({ thread_id: ownThread.thread_id, body: seed.exactArchive.body });
    expect(persistedArchive?.body.endsWith('λ.')).toBe(true);
    expect((await threadStore.listRecentPosts(ownThread.thread_id, 25)).posts.map(post => post.id)).not.toContain(archive.id);
    expect(await threadStore.getPostById(foreignWorkspacePost.id)).toBeNull();
    expect((await threadStore.getPostById(foreignThreadPost.id))?.thread_id).not.toBe(ownThread.thread_id);
    const events = await admin`SELECT id,thread_id,created_at AS created_ts FROM harness_shared.coord_thread_posts
      WHERE workspace_id=${workspace} AND id=ANY(${seed.events.map(event => Number(materialized.mapping[event.id]))})
      ORDER BY id`;
    expect(events.map(event => Number(event.id))).toEqual(seed.events.map(event => Number(materialized.mapping[event.id])));
    for (const [index, event] of events.entries()) {
      expect(new Date(event.created_ts).toISOString()).toBe(seed.events[index].recorded);
      expect(event.thread_id).toBe(seed.events[index].id === 'e2' ? childThread.thread_id : planThread.thread_id);
    }
    const rows = await admin`SELECT feature_id FROM harness_shared.work_items
      WHERE workspace_id=${workspace} AND harness_slug=${h} AND source_plan_slug=${p} ORDER BY feature_id`;
    expect(rows.map(row => row.feature_id)).toEqual([...children].sort());
    const tree = await resolveContainmentTree({ kind: 'plan', ref: p, harness: h },
      { workspaceId: workspace, harness: h, direction: 'down', maxDescendants: 100 });
    expect(tree.descendants.map(node => node.ref).sort()).toEqual([...children].sort());
    const evidence = engineeringEvidenceStore({ sql: async () => admin });
    const scope = { workspaceId: workspace, harness: h, root: process.cwd() };
    const exactSpec = await evidence.spec(scope, p, n.spec, spec.revision);
    expect(exactSpec).toMatchObject({ id: n.spec, revision: 2, fingerprint: spec.contentHash });
    expect(await evidence.decisions(scope, { plan: p, item: 'P-001', workspaceId: workspace, harness: h }, 10))
      .toContainEqual(expect.objectContaining({ id: seed.bindingDecision.id,
        body: `Date: ${seed.bindingDecision.recorded}\nRelated: P-001\n\n${seed.bindingDecision.body}` }));
    const proofs = await evidence.proofs(scope, exactSpec!, 10);
    expect(proofs).toContainEqual(expect.objectContaining({ id: Number(binding.id), runId: Number(proofRun.id),
      revision: seed.proof.applicableSpecRevision, workItem: item }));
    expect(await evidence.run({ ...scope, workspaceId: foreignWorkspace }, Number(proofRun.id))).toBeNull();
    expect(await evidence.run(scope, Number(newerFailedRun.id))).toMatchObject({ status: 'fail' });
    expect(await evidence.run({ ...scope, harness: n.foreignHarness }, Number(newerFailedRun.id))).toBeNull();

    // Audit positive INPUT adequacy independently of product freshness/output.
    // Correlated synthetic controls are sufficient to exercise the reader, but
    // never establish that this source actually executed or shipped.
    const fixtureProofQualification = {
      kind: 'frozen-positive-fixture-proof-prerequisites',
      runRef: `test-run:${proofRun.id}`,
      proof: proofs.find(proof => proof.id === Number(binding.id)),
      cases: await evidence.cases(scope, Number(proofRun.id), 21),
      execution: await evidence.execution!(scope, Number(proofRun.id)),
      deploymentQualification: capture.deploymentQualification,
      qualifiesForShipment: false,
      fixtureControlKind: 'synthetic-private-reference-control',
    };
    const requirePositiveFixture = (candidate: typeof fixtureProofQualification) => {
      const proof = candidate.proof;
      const cases = candidate.cases;
      const execution = candidate.execution;
      if (!proof || proof.runId !== Number(proofRun.id) || proof.withdrawn
        || proof.state !== 'current' || proof.reasons.length !== 0
        || proof.fingerprints.sourceFingerprint !== proofFingerprints.sourceFingerprint
        || proof.fingerprints.testFingerprint !== proofFingerprints.testFingerprint
        || cases.length !== 1 || cases[0]?.runId !== proof.runId || cases[0]?.key !== proofCase
        || cases[0]?.occurrence !== 1 || cases[0]?.status !== 'pass'
        || execution?.status !== 'observed' || execution.gaps.length !== 0
        || execution.observations.length !== 1
        || execution.observations[0]?.runId !== proof.runId
        || execution.observations[0]?.caseKey !== proofCase || execution.observations[0]?.occurrence !== 1
        || execution.observations[0]?.invocationId !== String(proofInvocation.id)) {
        throw new Error('GEC positive fixture prerequisites missing; no Q2 model capture admitted');
      }
    };
    requirePositiveFixture(fixtureProofQualification);
    // Read real changed/missing measurement inputs through the same adapter.
    // Merely changing the expected object cannot catch an adapter that silently
    // accepts stale proof or one whose recipe/root never resolves.
    const measurementControls: Record<string, typeof fixtureProofQualification.proof> = {};
    const readFixtureProof = async () => (await evidence.proofs(scope, exactSpec!, 10))
      .find(proof => proof.id === Number(binding.id));
    for (const [dimension, path, bytes] of [
      ['source', sourcePath, sourceBytes], ['test', proofTestPath, testBytes],
    ] as const) {
      try {
        await writeFile(join(proofRoot, path), Buffer.concat([bytes, Buffer.from('\n// stale fixture control\n')]));
        const proof = await readFixtureProof();
        measurementControls[`${dimension}-stale`] = proof;
        expect(proof).toMatchObject({ state: 'stale', reasons: expect.arrayContaining([`${dimension}-stale`]) });
        expect(() => requirePositiveFixture({ ...fixtureProofQualification, proof })).toThrow('prerequisites missing');
      } finally { await writeFile(join(proofRoot, path), bytes); }
    }
    // Evidence bindings are append-only. Give the missing-recipe control its
    // own clause/item so it cannot mutate or dequalify the primary proof.
    const missingRecipeSpecId = `${n.spec}-MISSING-RECIPE`;
    const missingRecipeSaved = await admin.begin(async tx => setSpecClause({
      planSlug: p, specId: missingRecipeSpecId, expectedRevision: 0, planItemId: 'P-999',
      behavior: 'A binding without a measurement recipe remains unknown.',
      behaviorClass: 'happy-path', requiredEvidence: ['tree'], requiredTestLayers: ['integration'],
      mutationRequired: false, lifecycleStatus: 'active', actorId: 'su-gec-fixture',
      falsifier: { observation: 'A missing recipe is admitted as current proof.',
        probeMethod: 'Read the immutable no-recipe control through the production evidence adapter.' },
    }, { executor: tx as never, workspaceId: workspace, harnessSlug: h }));
    expect(missingRecipeSaved.status).toBe('created');
    const missingRecipeSpec = await evidence.spec(scope, p, missingRecipeSpecId, 1);
    expect(missingRecipeSpec).toMatchObject({ id: missingRecipeSpecId, revision: 1 });
    await seedSpecRevisionEdge(missingRecipeSpecId, missingRecipeSpec!.revision, missingRecipeSpec!.fingerprint!);
    const [missingRecipeBinding] = await admin`INSERT INTO harness_shared.spec_evidence_bindings
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
        evidence_kind,evidence_ref,source_fingerprint,test_fingerprint,test_run_id,binding_fingerprint,created_by,details)
      VALUES (${workspace},${h},${item},${p},${missingRecipeSpecId},1,${missingRecipeSpec!.fingerprint},
        'test',${proofTestPath},${proofFingerprints.sourceFingerprint},${proofFingerprints.testFingerprint},
        ${proofRun.id},${digest(canonicalJson({ control: 'missing-recipe', primary: binding.id }))},
        'su-gec-fixture','{}'::jsonb) RETURNING id`;
    const missingRecipeProof = (await evidence.proofs(scope, missingRecipeSpec!, 10))
      .find(proof => proof.id === Number(missingRecipeBinding.id));
    measurementControls['missing-recipe'] = missingRecipeProof;
    expect(missingRecipeProof).toMatchObject({ state: 'unknown', reasons: expect.arrayContaining([
      'source-current-fingerprint-not-supplied', 'test-current-fingerprint-not-supplied',
    ]) });
    expect(() => requirePositiveFixture({ ...fixtureProofQualification, proof: missingRecipeProof }))
      .toThrow('prerequisites missing');
    const restoredProof = await readFixtureProof();
    requirePositiveFixture({ ...fixtureProofQualification, proof: restoredProof });
    // Detector controls: the former empty seed, an uncorrelated execution and
    // a different run/case must fail before any model is constructed or sent.
    expect(() => requirePositiveFixture({ ...fixtureProofQualification, cases: [] })).toThrow('prerequisites missing');
    expect(() => requirePositiveFixture({ ...fixtureProofQualification, execution: {
      status: 'unobserved', scope: 'instrumented-boundaries-only', observations: [], gaps: ['execution-not-recorded'],
    } })).toThrow('prerequisites missing');
    expect(() => requirePositiveFixture({ ...fixtureProofQualification,
      cases: [{ ...fixtureProofQualification.cases[0]!, runId: Number(newerFailedRun.id) }],
    })).toThrow('prerequisites missing');
    expect(() => requirePositiveFixture({ ...fixtureProofQualification, proof: {
      ...fixtureProofQualification.proof!, fingerprints: { sourceFingerprint: proofFingerprints.sourceFingerprint, testFingerprint: null },
    } })).toThrow('prerequisites missing');
    if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-positive-proof-prerequisites.json'),
      canonicalJson({ ...fixtureProofQualification, measurementControls, restoredProof }));
    await recordPhase('fixture-verified');

    // Exercise the existing public admission adapter with real canonical stores.
    // This is a current-source recorder integration, not a live model journey or
    // a complete paired baseline. Uninstrumented dimensions stay unknown.
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const sourceFingerprint = digest(canonicalJson(await Promise.all([
      readFile(new URL('../../grounded-evidence-measurement.ts', import.meta.url)),
      readFile(new URL('../../code-intelligence/engineering-evidence.ts', import.meta.url)),
      readFile(new URL('../../code-intelligence/engineering-evidence-store.ts', import.meta.url)),
    ].map(async bytes => digest(await bytes)))));
    for (const iteration of readerPreflight ? [] : [1, 2, 3]) {
      const measurementScope: GroundedMeasurementScope = {
        workspaceId: workspace, harness: h, potId: materialized.mapping[n.pot],
        runId: `gec-b-adapter-${RUN}`, ownerId: 'su-gec-recorder-integration', caseId: 'N7', arm: 'pre', iteration,
        manifestHash: materialized.manifestHash, fixtureHash: retained.sha256, sourceFingerprint, testFingerprint: testHash,
        runtimeFingerprint: digest(canonicalJson({ node: process.versions.node, arch: process.arch, class: 'vitest-isolated-pg' })),
        configFingerprint: digest(canonicalJson({ route: 'public-admission-adapter', selector: 'item', registry: 'fixture-test-seam' })),
      };
      const recorderRef = artifactDirectory ? join(artifactDirectory, `gec-b-consumer-pre${iteration}.json`)
        : `isolated-pg:${workspace}/gec-b-consumer-pre${iteration}`;
      const store = engineeringEvidenceStore({ sql: async () => admin,
        root: async candidate => candidate.workspaceId === workspace && candidate.harness === h ? root : null });
      const reads = observeGroundedStoreReads({ scope: measurementScope, deps: store, sourceRef: recorderRef,
        attemptId: `pre${iteration}`, methods: Object.keys(store) as Array<keyof typeof store> });
      const dispatch = observeGroundedToolDispatch({ scope: measurementScope, sourceRef: recorderRef,
        attemptId: `pre${iteration}`, boundary: 'consumer', originRef: 'current-source:engineeringEvidenceQuery',
        registrations: { 'graph:query': { purpose: 'retrieval', purposeRef: 'registered-handler:graph:query:evidence' } },
        dispatch: async (_tool, args) => engineeringEvidenceQuery(args as Parameters<typeof engineeringEvidenceQuery>[0], {
          workspaceId: workspace, harnessSlug: h, role: 'operator',
          principal: { slug: 'gec-b-reader', workspaceId: workspace, capabilities: new Set(['intel:read']) },
        } as never, {
          registry: async () => ({ projects: [{ slug: h, path: root, harness_kind: 'coding' }] } as never),
          read: (query, selectedScope) => readEngineeringEvidence(query, selectedScope, reads.deps),
        }),
      });
      const contractsBefore = await readContracts(sourceFingerprint, `${recorderRef}#contracts-before`);
      const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
      const result = await dispatch.dispatch('graph:query', { plan: p, item: 'P-001', harnesses: [h] });
      const contractsAfter = await readContracts(sourceFingerprint, `${recorderRef}#contracts-after`);
      const contractCapture = captureGroundedContractChanges({ scope: measurementScope, sourceRef: recorderRef,
        before: contractsBefore, after: contractsAfter });
      const input = { scope: measurementScope,
        boundary: { scope: measurementScope, sourceRef: recorderRef, admittedAt, settledAt: new Date().toISOString(),
          monotonicStartMs, monotonicEndMs: performance.now(), drained: true },
        invocations: dispatch.seal(), storage: reads.seal(), contracts: contractCapture.census };
      const measured = measureGroundedEvidence(input);
      expect(result.status).toBe('measured');
      expect(result.evidence?.nodes.some(node => node.kind === 'spec')).toBe(true);
      expect(measured.values).toMatchObject({ foregroundLookups: 1, retrievalCalls: 1, repeatedCalls: 0,
        storageBytes: 0, modelCalls: null, durableSteps: null });
      expect(contractCapture.gaps).toEqual([]);
      expect(measured.values).toMatchObject({ newMandatoryFields: 0, newMandatoryNarrativeSurfaces: 0 });
      expect(measured.values.storageOperations).toBeGreaterThan(0);
      expect(measured.complete).toBe(false);
      const ids = await recordRubricCheckResults(measured.ledgerResults,
        { workspaceId: workspace, harnessSlug: h, runGroupId: measurementScope.runId }, admin);
      const ledgerRows = await admin`SELECT id,status,execution_details FROM harness_shared.test_runs
        WHERE workspace_id=${workspace} AND id=ANY(${ids}) ORDER BY id`;
      const recovered = readGroundedMeasurementRows(measurementScope, ledgerRows.map(row => ({
        id: Number(row.id), status: row.status, executionDetails: row.execution_details,
      })));
      expect(recovered.values).toEqual(measured.values);
      expect(recovered.complete).toBe(false);
      const tape = canonicalJson({ kind: 'current-source-consumer-capture', acceptance: 'unmeasured',
        fixtureRef: retained, registryBoundary: 'existing injected fixture seam; not a serving-runtime qualification',
        contractsBefore, contractsAfter, contractCapture, input, result, measured, ledgerRows });
      const saved = await saveImmutableTextArtifact(h, tape);
      expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(tape);
      if (artifactDirectory) {
        await writeFile(recorderRef, tape);
        expect(await readFile(recorderRef, 'utf8')).toBe(tape);
      }
    }

    // Exercise the actual resume readers and durable cache on their registered
    // physical pools. cachedRead is bypassed by the maintained Vitest gate;
    // this proves SQL census plumbing, not a serving cache/runtime acceptance.
    const sqlScope: GroundedMeasurementScope = {
      workspaceId: workspace, harness: h, potId: materialized.mapping[n.pot],
      runId: `gec-b-storage-${RUN}`, ownerId: 'su-gec-recorder-integration', caseId: 'C1', arm: 'pre', iteration: 1,
      manifestHash: materialized.manifestHash, fixtureHash: retained.sha256, sourceFingerprint, testFingerprint: testHash,
      runtimeFingerprint: digest(canonicalJson({ node: process.versions.node, class: 'vitest-isolated-pg' })),
      configFingerprint: digest('resume-reader-and-l2-sql-census-control'),
    };
    // Pin the actual cache writer's template BEFORE observing any execution.
    // Its third interpolation is the original JSON.stringify result, not a
    // reserialization of the test value or a protocol parameter estimate.
    const cacheWriterSource = await readFile(new URL('../../cache/pg-l2-store.ts', import.meta.url), 'utf8');
    const cacheSetTemplate = /await sql`([\s\S]*?)`;/m.exec(cacheWriterSource.slice(cacheWriterSource.indexOf('  async set<')))?.[1];
    expect(cacheSetTemplate).toBeDefined();
    const cacheSetExpressions = [...cacheSetTemplate!.matchAll(/\$\{([^}]*)\}/g)].map(match => match[1]);
    expect(cacheSetExpressions).toEqual(['workspaceId', 'key', 'JSON.stringify(value ?? null)', 'tags', 'generation', 'expiresAt']);
    const cacheWriteRegistration = { pool: 'org-admin',
      sourceRef: `source:packages/operator-core/lib/cache/pg-l2-store.ts@${digest(cacheWriterSource)}#set`,
      template: cacheSetTemplate!.split(/\$\{[^}]*\}/g), command: 'INSERT' as const, serializedArguments: [2] };
    const serializerPath = '../../../../../node_modules/postgres/src/connection.js';
    const serializerSource = await readFile(new URL(serializerPath, import.meta.url), 'utf8');
    // The native control below verifies this maintained driver's actual output,
    // including JSON.toJSON being called once. Never invoke its serializer here.
    expect(serializerSource).toContain('parameters[i] = x = type in options.serializers');
    expect(serializerSource).toContain('options.serializers[type](x)');
    const serializerSourceRef = `source:${fileURLToPath(new URL(serializerPath, import.meta.url))}@${digest(serializerSource)}#Bind`;
    // The maintained writer chunks at FALLBACK_FLUSH_BATCH. Pin its source
    // template and enroll every permitted cardinality before execution; model
    // timing can produce any batch size, including the original four-row miss.
    const fallbackWriterSource = await readFile(new URL('../../degradation/fallback-observations.ts', import.meta.url), 'utf8');
    const fallbackColumns = ['workspace_id', 'mechanism', 'eligible', 'applied', 'reason', 'scope',
      'process_tag', 'correlation_id', 'observed_at', 'samples', 'population_known'];
    expect(fallbackWriterSource).toContain("${sql(values, 'workspace_id', 'mechanism', 'eligible', 'applied', 'reason', 'scope', 'process_tag', 'correlation_id', 'observed_at', 'samples', 'population_known')}");
    expect(fallbackWriterSource).toContain('rows.slice(i, i + FALLBACK_FLUSH_BATCH)');
    const fallbackBatchSizes = Array.from({ length: FALLBACK_FLUSH_BATCH }, (_, index) => index + 1);
    const fallbackWriteShapes = fallbackBatchSizes.map(count => {
      const values = Array.from({ length: count }, (_, row) => '(' + fallbackColumns
        .map((_, column) => `$${row * fallbackColumns.length + column + 1}`).join(',') + ')').join(',');
      const statement = '\n    INSERT INTO harness_shared.fallback_observations\n      ('
        + fallbackColumns.map(column => `"${column}"`).join(',') + ')values' + values + '\n  ';
      return [digest(statement), count * fallbackColumns.length, '../../degradation/fallback-observations.ts'] as const;
    });
    expect(fallbackWriteShapes[3]?.[0]).toBe('538ca0858167b990a9482e189954103b54dbefb0288ad813eb89769fe6ac7e33');
    const observationWrites = (await Promise.all(([
      ...fallbackWriteShapes,
      ['6bb1972dbd518dd64f34f69acd1a325917b0118c078fd92e390d64e73ba251bc', 12, '../../goals/plan-closure-observations.ts'],
      ['7bf62a411b55921ec42b81623184880e2fdf71b7e9900ba1254cc2e15844c0c7', 12, '../../goals/plan-closure-observations.ts'],
    ] as const).map(async ([queryHash, parameterCount, path]) => {
      const registration = { queryHash, parameterCount, command: 'INSERT' as const, serializerSourceRef,
        sourceRef: `source:${fileURLToPath(new URL(path, import.meta.url))}@${digest(await readFile(new URL(path, import.meta.url)))}`,
        persistedParameters: Array.from({ length: parameterCount }, (_, index) => index) };
      // The same maintained fallback writer accepts an explicit fixture handle
      // and otherwise uses getOrgPg().sql. Registration remains pool-specific.
      return (path.includes('fallback-observations') ? ['fixture-admin', 'org-admin'] : ['org-admin'])
        .map(pool => ({ ...registration, pool }));
    }))).flat();
    const sqlStatements: Array<{ query: string; command: string | null; status: string }> = [];
    // Finite source review of the original retained run-nggCRB statements.
    // These hashes were frozen BEFORE this execution; never enroll a statement
    // merely because it appeared in the observed result. Exact bytes include
    // the complete CTE and every expression, rather than a SELECT/WITH regex.
    // The source refs retain the current reviewed writer bodies. This selected
    // fixture does not certify arbitrary SQL, serving pools or transitive code.
    const nonPersistingSql = await Promise.all(([
      ['e5365373570f1de564ed031f33820743454f4232c94a9699b0025afc7a6999b0', 'read', 'SELECT', 'ok', './plan-history-consumers.integration.test.ts'],
      ['e7b4cb60ae3ad9468b469fc8b9ec066dc0c3baabbfde128964749758da1e575f', 'control', 'BEGIN', 'ok', '../../../../../node_modules/postgres/src/index.js'],
      ['6c20e5345ee8028f61cc0541aeb60699e5cffa99c8f79ff7f8c62b0a8dad1837', 'control', 'SET', 'ok', '../../pg-read-query.ts'],
      ['4ff5eea87475148656b3e4c0a62fb90fdc1e96997a8b96873e48285836003675', 'control', 'SELECT', 'ok', '../../pg-read-query.ts'],
      ['4b5830d44f40cf0845a5d15cdcf2052a11ec3d47b10ffe520fc06c684e000c7e', 'control', 'SET', 'ok', '../../pg-read-query.ts'],
      ['dec4dd7f0be7e9524fb2b06915f081e4e7115406f4b603549e3b715b110adb36', 'read', 'SELECT', 'ok', '../../containment-tree.ts'],
      ['9505cacb7c710ed17125fcc6cb3669e8ddca6c8cd8af6a31f6b3cd64604c3098', 'control', 'COMMIT', 'ok', '../../../../../node_modules/postgres/src/index.js'],
      ['0f115accbe11323f24250bb2b0cb2e49c6c577c2f2c798ca56cc09efcf409265', 'read', 'SELECT', 'ok', '../../containment-tree.ts'],
      ['9068f10afdbf88207df0137b1af3ecfb3f5b97bd348416395b1d0addb3ef9be6', 'read', 'SELECT', 'ok', '../../../../agent-mcp/src/tools/goals/history.ts'],
      ['2b097510cb5ba2dbed0fd118580c44d23829f1859ee491b9a3dcd9ea15875e9e', 'read', 'SELECT', 'ok', '../../../../coordination/src/capabilities/pg-stores.ts'],
      ['8d041a1382dab41bff9118d663ea937f2065f442b633033c18011cd790fce606', 'read', 'SELECT', 'ok', '../../hive-store.ts'],
      ['d4fbdcf01af45a5b9bd5667a77e04a89e236ffc4282dc5fcc287916aefe78094', 'control', 'SELECT', 'ok', '../../../../../libs/papercusp/libs/db/src/workspace-context.ts'],
      ['d3f449718105aacf34a98ad14e5dc373adafcb342490e2fb6eac8a933b5b6360', 'read', 'SELECT', 'ok', './source.ts'],
      ['09cb9597772dffd2c3868d992bfce4f7dc84f8350c6c52f7fef983395a06b1e4', 'read', 'SELECT', 'ok', './plan-line-graph.ts'],
      ['0e51a540e11a12951e28eb91e690a9a866124b755ededca70d26b4c0e86ec6aa', 'read', 'SELECT', 'ok', './revisions.ts'],
      ['e6fd62b8081db4ecf963559458ac4b6d6a37aa01fdf30ef88b0c8157e956c736', 'read', 'SELECT', 'ok', '../../harness/workspace-for-harness.ts'],
      ['ff547d5f514be1c25a094b70db22babe0e0ff53fcd5db74b87146f4f1cf110e2', 'read', 'SELECT', 'ok', './spec-evidence-store.ts'],
      ['76ed80dea88c7c7df1a8afbd39702f895d7af3a9fc0582776ec7e5c55d44d383', 'read', 'SELECT', 'ok', './spec-clauses-store.ts'],
      ['96624ad9564849645c04c25af87a3c46dd0c12279729036480421c42c3a1fc15', 'read', 'SELECT', 'ok', '../../delegation-counts.ts'],
      ['9e34f36285399a53c2157b6755f6d42e407f7c5a5a5d2a59dd849d401213b8c8', 'read', 'SELECT', 'ok', '../../operator-state-pg.ts'],
      // Cold registry load: same inspected payload-only reader, explicit table.
      ['9d586e4a0d52f2a84646b90824f2ba8bd64148339c1c5a9af1b61148f08722c4', 'read', 'SELECT', 'ok', '../../operator-state-pg.ts'],
      ['bedffd593828755f305c22afed84034daa26526b7fe05d1d6a37468beb43baa4', 'read', 'SELECT', 'ok', '../../delegation-counts.ts'],
      ['7dc88da241e66be55c61b4b21b7ffba947b3a4a20aae233f8c9c60b792fd83c8', 'read', 'SELECT', 'ok', '../../acceptance-awaiting-plans.ts'],
      ['36d530ac0c103c0f7a8d9128b8ec71f1e44f53e51305ae5e522640426464800f', 'read', 'SELECT', 'ok', './source.ts'],
      ['56614f76afb65bf11d7e40b71fd8f50b22945d710d413d8e19d35a4b1552ece9', 'read', 'SELECT', 'ok', '../../issues-engineer.ts'],
      ['b4269d3a4cfc098b4b33964cef777e83298385c0865e735186fb43ac75c6addd', 'read', 'SELECT', 'ok', '../../../../coordination/src/capabilities/pg-stores.ts'],
      ['df61a1e56d1d12ed3ee09da2754d83f540ca7f6f8393ddb44a45386d0f7428c7', 'read', 'SELECT', 'ok', '../../work-item-checkpoint.ts'],
      ['3342188c88d8c6d10515b0c272f3adcc1c3e901f55ca5af53905b46d5596a77b', 'read', 'SELECT', 'ok', '../../cache/pg-l2-store.ts'],
      ['ba50d5a891ea82fd186ab794834846542fa135dc2d4fa10097d6a3a41e2202ca', 'read', 'SELECT', 'ok', './plan-history-consumers.integration.test.ts'],
      ['e4473b2ec396b170a65bf220574205a81cec1d7a38ea12820222223f16ea81fd', 'read', null, 'error', './plan-history-consumers.integration.test.ts'],
      // Public-reader closure, reviewed from the retained first consumer tape.
      // These registrations qualify new executions only, never that old tape.
      ['2784483e0c9ec274314489551a6c609c4f6be846d97906af753257d451bbde69', 'read', 'SELECT', 'ok', '../../scheduler/plan-item-lane-guard.ts'],
      ['6a1183f633a74160c113ae41d34b085c57e169e9fb46097bc6023ef378088892', 'read', 'SELECT', 'ok', '../../work-item-prior-work.ts'],
      ['52ab58663084607ea670d5b4a2771277ec0f9c22aa1138766cca87c156193782', 'control', 'SELECT', 'ok', '../../pg-bounded-txn.ts'],
      ['49bd30dde1798dc0dee3bff84842bdd9c8aa56ac48214e579b047e5813e65ffc', 'read', 'SELECT', 'ok', '../../work-item-touch-history.ts'],
      ['5f419445a67f78136926d75e6d14402330d303bee6964c550174d6672bf63ef7', 'read', 'SELECT', 'ok', '../../harness/improvements/corroboration.ts'],
      ['6cf3146bfd3d1d4c3d4bbf0bff8300d04ffa8462d6ac9cfaad736881c4c31b5c', 'read', 'SELECT', 'ok', '../../work-item-change-kinds.ts'],
      ['d62544f723f04c1fbedf956beaba8e8c90f855fd1afd98e53b92c2cb40286cc8', 'read', 'SELECT', 'ok', '../../work-item-checkpoint.ts'],
      ['36859987ae6578cd57a93bf4129769b3501123985e37c2fd77e1814d0af1afd2', 'read', 'SELECT', 'ok', './spec-evidence-store.ts'],
      ['bea378d646e5bbef54a2ea14acd967564034390526dc1467b2b1d47fe29bdfb9', 'read', 'SELECT', 'ok', '../../code-intelligence/engineering-evidence-store.ts'],
      ['5a67cb0ac2fc3c33f2215862a1f507a1086027927a85637488ecc928a92887a4', 'read', 'SELECT', 'ok', '../../code-intelligence/engineering-evidence-store.ts'],
      ['d6d344fc2fd83300c758199e407bd880a0a58ddcf3a23469053971af3bd55aae', 'read', 'SELECT', 'ok', './spec-clauses-store.ts'],
      ['ba5c23bc3799235ed845f073d6efad18cc44c9a5efd48cc3c8d77a670f563e7a', 'read', 'SELECT', 'ok', './spec-evidence-store.ts'],
      ['d0804efc1e81dc8cc28cf469949726a82edb98e68102ec190d14210c58b71e2c', 'read', 'SELECT', 'ok', './spec-evidence-store.ts'],
      ['a614a3ce104a81324102f4b01ef827e59328cdacb08dae7f184ec77dae8409a8', 'read', 'SELECT', 'ok', '../../code-intelligence/engineering-evidence-store.ts'],
      ['db07b6ae95bcd5c6669524110e631bbb33656661aac12db4f48b56b5b34dcd4b', 'read', 'SELECT', 'ok', '../../code-intelligence/engineering-evidence-store.ts'],
      ['87b47bdaf0ca9833fc782bedd15a65a1da94db98f0f06f5d34120e0a46962d35', 'read', 'SELECT', 'ok', '../../observability/engineering-execution.ts'],
      // Source-reviewed bounded case/call correlation reads, now reachable
      // from the nonempty positive fixture. Neither template has a writer CTE.
      ['51684b00cbc64a9badd33b0c933741534be6b452ad7a7b34f6660d91ffc36a9b', 'read', 'SELECT', 'ok', '../../observability/engineering-execution.ts'],
      ['91680d0712437c4557352298e5fe0ff1642f1b03a9ed7fac46b26a3050b1dbd9', 'read', 'SELECT', 'ok', '../../observability/engineering-execution.ts'],
      [digest('SELECT id,title,body,kill_criterion FROM harness_shared.goals WHERE workspace_id=$1 AND id=$2'),
        'read', 'SELECT', 'ok', './plan-history-consumers.integration.test.ts'],
      // Reviewed original C4 detail/operationalBrief readers. These exact
      // SELECT registrations never classify the observed INSERT statements.
      ['99d88b1cfc5a63bf4ad025831dd2b2fe9ccdfea588d93f8d74d6879beeb08d82', 'read', 'SELECT', 'ok', '../../issues-engineer.ts'],
      // getIssue(includeBody:false, payloadProjection:completionEvidence),
      // with its three-value harness preference. Reviewed against getIssue
      // and projectWorkItemColumns from the retained run-4iolNS statement.
      ['88b78def98c34dd31fc078e8a6605a3eb2f36a3c690680e747c085b67c4ad0ca', 'read', 'SELECT', 'ok', '../../issues-engineer.ts'],
      ['d06fd36a7911afa451f1c1f37fab04b9c78bcc265b480a9909efe53f5944e976', 'read', 'SELECT', 'ok', '../../../../coordination/src/capabilities/pg-stores.ts'],
      ['df1a5548ad4ae55fa5b9ad7a5e3c9e22be1e6770bc1e007f3481ffdbdc270a5a', 'read', 'SELECT', 'ok', '../../../../coordination/src/capabilities/pg-stores.ts'],
      ['f3f2ff6fd53fed5cac9578ca1a46b10d9a53e9d17aab2d1fedaea60450e14d67', 'read', 'SELECT', 'ok', '../../dbos/work-item-deps-store.ts'],
      ['7958a2c4e13c8c65fbd514948eaaf1572da357b47db858bb237d047f5c2b8aa2', 'read', 'SELECT', 'ok', '../../containment-tree.ts'],
      ['b2b8bc88434b74c63a4eac1427c2c52e93fefa7adbfe48186582966f767d652d', 'read', 'SELECT', 'ok', '../../work-item-lifecycle-history.ts'],
      ['6ab1829844674e2fd510cb9fdd2ca56196658920ff37f69790ef32bcfbb8acde', 'read', 'SELECT', 'ok', '../../carry-note.ts'],
      ['43f4797356184a9e4cc9e02b7ef760e7ebffb0f9b2f60961039baea1b634c91c', 'read', 'SELECT', 'ok', '../../text-artifacts.ts'],
      // Original Q2 model-selected branches: exact archive recovery, full
      // plan/type/acceptance reads and operational context. These registrations
      // qualify new reads only; original tapes are never retroqualified.
      ['457849eeac6f8459801df2673ebbc1e494744c80f5f038f024917abf964612c9', 'read', 'SELECT', 'ok', '../../../../coordination/src/capabilities/pg-stores.ts'],
      ['c419d69b84b04862d1a03502ae9041dcfc26257f11edf71e62693976de2e1c09', 'read', 'SELECT', 'ok', '../../prior-attempt-context.ts'],
      ['1084672f1d50b3bc99a49cb17c237f88da3e6a60733bc73fdbb6d28946d4867a', 'read', 'SELECT', 'ok', '../../work-items.ts'],
      ['0f2ed529e83104b3534a8aa5be7680c1b251d343db157f074d74db8ca80eba24', 'read', 'SELECT', 'ok', '../../issues-engineer.ts'],
      ['9a79b1180f0368c3d0dd4cc24ec61f04fb9f4f0066d028d2471d65ddd30b82ef', 'read', 'SELECT', 'ok', '../../plan-types/registry.ts'],
      ['752c6e3dde5e69e699a43b43cf890380ba96fba4292520e9f66c39035c1345bc', 'read', 'SELECT', 'ok', '../../plan-types/registry.ts'],
      ['857181228985e2d6f8098c61f5777598ae66aedcd560c0ceef1605459c40da85', 'read', 'SELECT', 'ok', '../../plan-types/pins.ts'],
      ['c9f36a186819981438f86b531eb89c658d97541faec23a547947e84280632d01', 'read', 'SELECT', 'ok', '../../plan-types/pins.ts'],
      ['49ac1355612cf98c48645a4b128e1083ac57f5ea837c0a051caaba5b02816665', 'read', 'SELECT', 'ok', '../../acceptance-bar-contract-snapshot.ts'],
      ['6a460c34f24ffbe2ff8732aa2897f594ae277e639ec4020a51823b4cf38aa36d', 'read', 'SELECT', 'ok', '../../rubrics.ts'],
      ['b8088a704f37fe9823f8ff5c00a9d175645538d5acb22d9a15de1e27c9671b84', 'read', 'SELECT', 'ok', '../../acceptance-bar-contract-snapshot.ts'],
      ['e4402d88730dd46d28441aa6f5212cf47119744d67a2215b3121ab77f381b39c', 'read', 'SELECT', 'ok', '../../acceptance-bar-contract-snapshot.ts'],
      ['319f337545f295550000b26cc3a9a34ba6a93036f816179c9c24841d1ec57433', 'read', 'SELECT', 'ok', '../../acceptance-bar-contract-snapshot.ts'],
      ['790b65165ef84c13a8363ccf0465c2551be445298a8a9ef4b6305b73ab40f247', 'read', 'SELECT', 'ok', '../../acceptance-bar-contract-snapshot.ts'],
      ['dc7242d0b1877e020d67b0812996e53aea09de8bd251d3314d4300642b85f504', 'read', 'SELECT', 'ok', '../../goals/plan-closure-observations.ts'],
      ['af945e6b142f31f4dc430c137ce9d5e97577c87b2c0e10be35e2c66c7bba3666', 'read', 'SELECT', 'ok', '../../plan-acceptance-gate.ts'],
      ['fbc0fd304acbf2cdf1fc4efa1659ef0de0b5b71992f35dc04a47d78ff9ed0970', 'read', 'SELECT', 'ok', '../../session-brief-mission.ts'],
      // Native285fec19 original C1/C2/C4 misses: exact source-reviewed
      // execution binding, lifecycle and discovery reads. Originals stay unknown.
      ['d32162df129145d80c983b768e07377deaec93fad6bfab9d78f9d595074cfe74', 'read', 'SELECT', 'ok', './plan-execution-authority.ts'],
      ['de9d0ec3f02c768f69904e3a8bd621c111eaae51df7dd5171badd5103f65caba', 'read', 'SELECT', 'ok', '../../work-item-lifecycle-history.ts'],
      ['977d4868e67c4df203782536dff9ab7d3093616539c36796b807a0a3369757b3', 'control', 'SELECT', 'ok', '../../plan-audits.ts'],
      ['30208684e394b6f982e6827ecb1ce884b9a7010c3b0d0709bc83c821e2cc8412', 'read', 'SELECT', 'ok', '../../plan-audits.ts'],
      ['4c27452ecbac890e2c1454b4adbff03ae97fefbe7d48d571aa69eb85f1385590', 'read', 'SELECT', 'ok', '../../plan-audits.ts'],
    ] as const).map(async ([queryHash, kind, command, status, path]) => ({ queryHash, kind, command, status,
      sourceRef: `source:${fileURLToPath(new URL(path, import.meta.url))}@${digest(await readFile(new URL(path, import.meta.url)))}` })));
    if (!readerPreflight) {
    const sqlTap = observeGroundedStoreOperations({ scope: sqlScope, deps: {}, operations: [],
      sourceRef: artifactDirectory ? join(artifactDirectory, 'gec-b-storage-control.json') : `isolated-pg:${workspace}/storage-control`,
      attemptId: 'resume-storage-control',
      postgres: [{ pool: 'fixture-admin', client: admin }, { pool: 'org-admin', client: getOrgPg().sql },
        { pool: 'org-app', client: getOrgPgApp().sql }],
      serializedSqlWrites: [cacheWriteRegistration],
      nonPersistingSql,
      isReadOnlySql: row => {
        sqlStatements.push({ query: row.query, command: row.command, status: row.status });
        return false; // Observation does not enroll a query in the frozen review.
      },
    });
    const sqlAdmittedAt = new Date().toISOString(), sqlStartMs = performance.now();
    try {
      const cache = new PgL2Store();
      const cacheKey = `gec-storage-${fixtureToken}`, value = { lesson: 'exact original λ.' };
      await sqlTap.run(async () => {
        // The first Query stays lazy; the interpolated fragment is consumed by
        // the outer query without independent execution of that fragment.
        admin`SELECT 'gec_never_executed_fragment'`;
        const predicate = admin`true`;
        await admin`SELECT 1 AS fragment_control WHERE ${predicate}`;
        await readGoalHistoryContext(resumeRoot);
        await buildPlanContextBundle(switchPlan, { workspaceId: workspace, harnessSlug: h });
        await plansGetTool.handler(plansGetTool.args.parse({ slug: p, harness: h, heading: 'History' }) as never, CTX);
        await getWorkItem(item, h);
        await cache.set(workspace, cacheKey, value);
        expect((await cache.get(workspace, cacheKey))?.value).toEqual(value);
        // More physical results than the diagnostic ring can retain.
        for (let i = 0; i < 40; i++) await admin`SELECT ${i}::int AS census_control`;
        await expect(admin`SELECT * FROM harness_shared.gec_deliberately_missing_table`).rejects.toThrow();
      });
      const census = sqlTap.seal();
      // Retain originals before ANY predicate: a broken recorder is itself
      // evidence and must not disappear behind the first failed assertion.
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-storage-control-admissions.json'),
        canonicalJson({ census, sqlStatements }));
      expect(census.diagnostics).toMatchObject({ pending: 0, late: false, captureFailed: false, hooksIntact: true });
      expect(census.complete).toBe(true);
      expect(census.diagnostics.excludedUnexecutedIds.length).toBeGreaterThanOrEqual(2);
      expect(sqlStatements.some(row => row.query.includes('gec_never_executed_fragment'))).toBe(false);
      expect(sqlStatements.some(row => row.query.includes('fragment_control'))).toBe(true);
      expect(census.ids.length).toBeGreaterThan(40);
      expect(census.rows).toHaveLength(census.ids.length);
      expect(census.rows.some(row => row.sql?.pool === 'fixture-admin')).toBe(true);
      expect(census.rows.some(row => row.sql?.pool === 'org-admin')).toBe(true);
      expect(census.rows.some(row => row.sql?.status === 'error')).toBe(true);
      expect(sqlStatements.some(row => row.query.includes('harness_plans'))).toBe(true);
      // readGoalHistory loads goal events from audit_log by subject/action;
      // it does not read goal definition rows from the goals table.
      expect(sqlStatements.some(row => row.command === 'SELECT' && row.query.includes('harness_shared.audit_log')
        && row.query.includes('subject =') && row.query.includes('action = ANY'))).toBe(true);
      expect(sqlStatements.some(row => row.query.includes('cache_l2') && row.command === 'INSERT')).toBe(true);
      const cacheWrites = census.rows.filter(row => row.sql?.serializedWrite?.sourceRef === cacheWriteRegistration.sourceRef);
      expect(cacheWrites).toHaveLength(1);
      expect(cacheWrites[0]).toMatchObject({ kind: 'write', persistedBytes: Buffer.byteLength('{"lesson":"exact original λ."}'),
        sql: { serializedWrite: { values: [{ argument: 2,
          sha256: digest('{"lesson":"exact original λ."}'), bytes: Buffer.byteLength('{"lesson":"exact original λ."}') }] } } });
      const measured = measureGroundedEvidence({ scope: sqlScope, storage: census,
        boundary: { scope: sqlScope, sourceRef: census.sourceRef, admittedAt: sqlAdmittedAt,
          settledAt: new Date().toISOString(), monotonicStartMs: sqlStartMs, monotonicEndMs: performance.now(), drained: true } });
      expect(measured.values.storageOperations).toBe(census.ids.length);
      expect(census.rows.filter(row => row.kind === 'unknown')).toEqual([]);
      expect(census.rows.some(row => row.kind === 'control')).toBe(true);
      expect(measured.values.storageBytes).toBe(Buffer.byteLength('{"lesson":"exact original λ."}'));
      const tape = canonicalJson({ kind: 'resume-storage-census-control', acceptance: 'unmeasured',
        limitation: 'Finite reviewed physical selected-pool census only; L1 serving cache and wider runtime closure remain unqualified.',
        census, sqlStatements, nonPersistingSql, measured });
      const saved = await saveImmutableTextArtifact(h, tape);
      expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(tape);
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-storage-control.json'), tape);
    } finally { sqlTap.restore(); }

    const cacheOnlyTap = observeGroundedStoreOperations({ scope: sqlScope, deps: {}, operations: [],
      sourceRef: 'isolated-pg:original-cache-value-control', attemptId: 'original-cache-value',
      postgres: [{ pool: 'org-admin', client: getOrgPg().sql }], serializedSqlWrites: [cacheWriteRegistration],
      isReadOnlySql: row => row.command === 'SELECT' && /^\s*SELECT\b/i.test(row.query) });
    try {
      let serializations = 0;
      const value = { toJSON: () => ({ original: `λ.😺-${++serializations}` }) };
      const cache = new PgL2Store(), key = `gec-original-serialized-${fixtureToken}`;
      await cacheOnlyTap.run(async () => {
        await cache.set(workspace, key, value);
        await cache.set(workspace, key, value); // Each attempt counts once.
        expect((await cache.get(workspace, key))?.value).toEqual({ original: 'λ.😺-2' });
      });
      const census = cacheOnlyTap.seal();
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-original-cache-value-control.json'),
        canonicalJson({ census, serializations, cacheWriteRegistration }));
      expect(serializations).toBe(2);
      expect(census.complete).toBe(true);
      expect(census.rows.filter(row => row.kind === 'write').map(row => row.persistedBytes)).toEqual([
        Buffer.byteLength('{"original":"λ.😺-1"}'), Buffer.byteLength('{"original":"λ.😺-2"}'),
      ]);
      const measured = measureGroundedEvidence({ scope: sqlScope, storage: census,
        boundary: { scope: sqlScope, sourceRef: census.sourceRef, admittedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(), monotonicStartMs: 0, monotonicEndMs: 1, drained: true } });
      expect(measured.values.storageOperations).toBe(census.ids.length);
      expect(measured.values.storageBytes).toBe(Buffer.byteLength('{"original":"λ.😺-1"}{"original":"λ.😺-2"}'));
    } finally { cacheOnlyTap.restore(); }

    // Independent real-driver control: sql.json is opaque at admission and is
    // serialized once by Bind. Read back only to verify that control's behavior;
    // the recorder obtains bytes from the original parameter, not that readback.
    const jsonControlName = `gec_original_serialization_${digest(fixtureToken).slice(0, 16)}`;
    const jsonControlTable = `harness_shared.${jsonControlName}`;
    await admin`CREATE TABLE ${admin(jsonControlTable)} (value json)`;
    const jsonControlQuery = `INSERT INTO "harness_shared"."${jsonControlName}"(value) VALUES ($1) RETURNING value`;
    const jsonControlTap = observeGroundedStoreOperations({ scope: sqlScope, deps: {}, operations: [],
      sourceRef: 'isolated-pg:driver-serializer-control', attemptId: 'driver-serializer-control',
      postgres: [{ pool: 'fixture-admin', client: admin }],
      serializedSqlParameters: [{ pool: 'fixture-admin', sourceRef: 'test:driver-serializer-control', serializerSourceRef,
        queryHash: digest(jsonControlQuery), command: 'INSERT', parameterCount: 1, persistedParameters: [0] }] });
    try {
      let serializations = 0;
      const value = { toJSON: () => ({ original: `λ.😺-${++serializations}` }) };
      const result = await jsonControlTap.run(() => admin`INSERT INTO ${admin(jsonControlTable)}(value) VALUES (${admin.json(value)}) RETURNING value`);
      const census = jsonControlTap.seal();
      expect(serializations).toBe(1);
      expect(result[0].value).toEqual({ original: 'λ.😺-1' });
      expect(census.complete).toBe(true);
      expect(census.rows).toHaveLength(1);
      expect(census.rows[0]).toMatchObject({ kind: 'write', persistedBytes: Buffer.byteLength('{"original":"λ.😺-1"}'),
        sql: { serializedParameters: { values: [{ parameter: 0, sha256: digest('{"original":"λ.😺-1"}'),
          bytes: Buffer.byteLength('{"original":"λ.😺-1"}') }] } } });
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-driver-serializer-control.json'),
        canonicalJson({ census, serializations, serializerSourceRef }));
    } finally { jsonControlTap.restore(); }
    }

    // Verify containment before exercising the production writer with no handle.
    const defaultFallbackSql = getOrgPg().sql;
    const fixtureDatabase = await admin`SELECT current_database() AS database`;
    const defaultDatabase = await defaultFallbackSql`SELECT current_database() AS database`;
    expect(defaultDatabase[0].database).toBe(fixtureDatabase[0].database);

    // Every source-permitted batch arity and both actual writer routes are
    // required, independently of what a public reader happens to enqueue.
    await flushFallbackObservations({ sql: admin });
    const fallbackControlHashes: string[] = [];
    const fallbackControls: unknown[] = [];
    const emitFallbackBatches = async (label: string, sql?: postgres.Sql) => {
      const options = sql ? { sql } : {};
      for (const count of fallbackBatchSizes) {
        for (let index = 0; index < count; index++) expect(observeFallback('gec-serializer-control', {
          eligible: 1, applied: 0, reason: `original-λ-${label}-${count}-${index}`, scope: h,
        }, { ...options, workspaceId: workspace })).toBe(true);
        const flush = await flushFallbackObservations(options);
        expect(flush).toMatchObject({ failed: 0, dropped: 0, rejected: 0 });
        // The full batch starts its own flush at observe time. This explicit
        // drain waits for it, but reports only writes it starts itself. The
        // sealed SQL census below proves every batch's actual persisted bytes.
        if (count < FALLBACK_FLUSH_BATCH) expect(flush.written).toBe(count);
      }
    };
    for (const { pool, client, sql } of [
      { pool: 'fixture-admin', client: admin, sql: admin },
      { pool: 'org-admin', client: defaultFallbackSql, sql: undefined },
    ]) {
      const registrations = observationWrites.filter(row => row.pool === pool
        && row.sourceRef.includes('/degradation/fallback-observations.ts@'));
      const fallbackControlTap = observeGroundedStoreOperations({ scope: sqlScope, deps: {}, operations: [],
        sourceRef: `isolated-pg:fallback-serialization-control:${pool}`, attemptId: `fallback-serialization-control:${pool}`,
        postgres: [{ pool, client }], serializedSqlParameters: registrations });
      try {
        await fallbackControlTap.run(() => emitFallbackBatches(pool, sql));
        const census = fallbackControlTap.seal();
        expect(census.complete).toBe(true);
        expect(census.rows).toHaveLength(FALLBACK_FLUSH_BATCH);
        expect(census.rows.every(row => row.sql?.pool === pool)).toBe(true);
        const hashes = census.rows.map(row => row.sql!.queryHash);
        expect(hashes.sort()).toEqual(registrations.map(row => row.queryHash).sort());
        expect(census.rows.every(row => row.kind === 'write' && row.persistedBytes! > 0
          && row.sql?.serializedParameters?.values.length === row.sql?.serializedParameters?.parameterCount)).toBe(true);
        fallbackControlHashes.push(...hashes);
        fallbackControls.push({ pool, writer: sql ? 'explicit' : 'default', census });
      } finally { fallbackControlTap.restore(); }
    }
    // The original defect must stay unknown when only the other pool is
    // registered, even with identical SQL and complete driver capture.
    const wrongPoolTap = observeGroundedStoreOperations({ scope: sqlScope, deps: {}, operations: [],
      sourceRef: 'isolated-pg:fallback-wrong-pool-control', attemptId: 'fallback-wrong-pool-control',
      postgres: [{ pool: 'fixture-admin', client: admin }, { pool: 'org-admin', client: defaultFallbackSql }],
      serializedSqlParameters: observationWrites.filter(row => row.pool === 'fixture-admin') });
    try {
      const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
      await wrongPoolTap.run(() => emitFallbackBatches('wrong-pool'));
      const census = wrongPoolTap.seal();
      expect(census.complete).toBe(true);
      expect(census.rows).toHaveLength(FALLBACK_FLUSH_BATCH);
      expect(census.rows.every(row => row.sql?.pool === 'org-admin'
        && row.kind === 'unknown' && row.persistedBytes === null)).toBe(true);
      expect(measureGroundedEvidence({ scope: sqlScope, storage: census,
        boundary: { scope: sqlScope, sourceRef: 'isolated-pg:fallback-wrong-pool-control', admittedAt,
          settledAt: new Date().toISOString(), monotonicStartMs, monotonicEndMs: performance.now(), drained: true },
      }).values.storageBytes).toBeNull();
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-fallback-serializer-control.json'),
        canonicalJson({ controls: fallbackControls, wrongPool: census, observationWrites,
          containment: { fixtureDatabase: fixtureDatabase[0].database, defaultDatabase: defaultDatabase[0].database } }));
    } finally { wrongPoolTap.restore(); }
    await recordPhase('fallback-serialization-verified');

    // Exercise the actual public consumers, rather than qualifying their SQL
    // from a neighboring direct-store control. The cachedRead wrapper bypasses
    // under VITEST in this runtime; retain that boundary explicitly. This does
    // not qualify L1/L2 behavior in a serving operator or old model captures.
    let actualConsumerStorageQualified = false;
    if (!readerPreflight) {
    const consumerStatements: Array<{ query: string; command: string | null; status: string }> = [];
    const consumerTap = observeGroundedStoreOperations({ scope: sqlScope, deps: {}, operations: [],
      sourceRef: artifactDirectory ? join(artifactDirectory, 'gec-b-actual-consumer-storage.json')
        : `isolated-pg:${workspace}/actual-consumer-storage`,
      attemptId: 'actual-consumer-storage',
      postgres: [{ pool: 'fixture-admin', client: admin }, { pool: 'org-admin', client: getOrgPg().sql },
        { pool: 'org-app', client: getOrgPgApp().sql }],
      serializedSqlWrites: [cacheWriteRegistration], nonPersistingSql,
      isReadOnlySql: row => {
        consumerStatements.push({ query: row.query, command: row.command, status: row.status });
        return false;
      },
    });
    try {
      const readerContext = { isSuperuser: true, uiClientId: 'su-gec-model-integration',
        workspaceId: workspace, harnessSlug: h, metadata: vi.fn(), log: vi.fn(), progress: vi.fn() };
      const consumerAdmittedAt = new Date().toISOString(), consumerStartMs = performance.now();
      const results = await consumerTap.run(async () => {
        const history = await readGoalHistoryContext(resumeRoot);
        const planContext = await buildPlanContextBundle(switchPlan, { workspaceId: workspace, harnessSlug: h });
        const plan = await plansGetTool.handler(plansGetTool.args.parse({ slug: p, harness: h, heading: 'History' }) as never,
          readerContext as never);
        const workItem = await workItemsGetTool.handler(workItemsGetTool.args.parse({ id: unrelated, harness: h }) as never,
          readerContext as never);
        const resume = await workItemsGetTool.handler(workItemsGetTool.args.parse({ id: item, harness: h, resume: true }) as never,
          readerContext as never);
        const store = engineeringEvidenceStore({ sql: async () => admin,
          root: async candidate => candidate.workspaceId === workspace && candidate.harness === h ? root : null });
        const graph = await engineeringEvidenceQuery({ plan: p, item: 'P-001', harnesses: [h] }, {
          workspaceId: workspace, harnessSlug: h, role: 'operator',
          principal: { slug: 'gec-b-model-reader', workspaceId: workspace, capabilities: new Set(['intel:read']) },
        } as never, {
          registry: async () => ({ projects: [{ slug: h, path: root, harness_kind: 'coding' }] } as never),
          read: (query, selectedScope) => readEngineeringEvidence(query, selectedScope, store),
        });
        return { history, planContext, plan, workItem, resume, graph };
      });
      const census = consumerTap.seal();
      const measured = measureGroundedEvidence({ scope: sqlScope, storage: census,
        boundary: { scope: sqlScope, sourceRef: census.sourceRef, admittedAt: consumerAdmittedAt,
          settledAt: new Date().toISOString(), monotonicStartMs: consumerStartMs,
          monotonicEndMs: performance.now(), drained: true } });
      actualConsumerStorageQualified = census.complete && measured.values.storageBytes !== null;
      const runtimeClosure = {
        class: 'current-source-private-PG', node: process.versions.node, servingQualified: false,
        cacheMode: 'cachedRead VITEST bypass; serving cache closure unmeasured',
        pools: ['fixture-admin', 'org-admin', 'org-app'],
        consumers: ['readGoalHistoryContext', 'buildPlanContextBundle', 'plans:get History',
          'work_items:get default', 'work_items:get resume', 'graph:query evidence'],
        sources: await Promise.all(['../../cache/cached-read.ts', '../../cache/instance.ts',
          '../../prior-attempt-context.ts', './context-bundle.ts', './get.ts', '../work_items/get.ts',
          '../../code-intelligence/engineering-evidence-store.ts',
        ].map(async path => ({ path, sha256: digest(await readFile(new URL(path, import.meta.url))) }))),
      };
      const tape = canonicalJson({ kind: 'actual-consumer-storage-control', acceptance: 'unmeasured',
        runtimeClosure, census, consumerStatements, results, measured, actualConsumerStorageQualified });
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-actual-consumer-storage.json'), tape);
      const saved = await saveImmutableTextArtifact(h, tape);
      expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(tape);
      expect(census.diagnostics).toMatchObject({ pending: 0, late: false, captureFailed: false, hooksIntact: true });
      expect(census.complete).toBe(true);
      expect(census.ids.length).toBeGreaterThan(0);
      expect(measured.values.storageOperations).toBe(census.ids.length);
      expect(census.rows.filter(row => row.kind === 'unknown')).toEqual([]);
      expect(measured.values.storageBytes).toBe(0);
      expect(actualConsumerStorageQualified).toBe(true);
      expect(runtimeClosure.servingQualified).toBe(false);
      expect(consumerStatements.some(row => row.query.includes('work_items'))).toBe(true);
      expect(consumerStatements.some(row => row.query.includes('harness_plans'))).toBe(true);
    } finally { consumerTap.restore(); }

    // Deliberately lose a terminal callback on this isolated fixture pool,
    // restore the exact installed hook, then verify admission still detects it.
    const lostSqlTap = observeGroundedStoreOperations({ scope: sqlScope, deps: {}, operations: [],
      sourceRef: 'isolated-pg:lost-terminal-control', attemptId: 'lost-terminal-control',
      postgres: [{ pool: 'fixture-admin', client: admin }] });
    const installedResult = admin.options.onresult;
    try {
      admin.options.onresult = () => {};
      await lostSqlTap.run(() => admin`SELECT 1 AS dropped_terminal_control`);
    } finally { admin.options.onresult = installedResult; }
    try {
      const lostCensus = lostSqlTap.seal();
      expect(lostCensus).toMatchObject({ complete: false,
        diagnostics: { pending: 1, hooksIntact: true, excludedUnexecutedIds: [] } });
      if (artifactDirectory) await writeFile(join(artifactDirectory, 'gec-b-storage-lost-terminal-control.json'), canonicalJson(lostCensus));
    } finally { lostSqlTap.restore(); }
    }

    // Explicitly selected model measurement, using the maintained SuTarget
    // transport and the same real PG/public reader. Ordinary integration runs
    // remain provider-free, like the existing bug-triage model fixture.
    if (readerPreflight || syntheticTransport || ['1', 'preflight'].includes(process.env.PAPERCUSP_TEST_GEC_MODEL ?? '')) {
      const preflight = readerPreflight || process.env.PAPERCUSP_TEST_GEC_MODEL === 'preflight';
      if (!preflight) {
        expect(actualConsumerStorageQualified,
          'Qualify the actual consumer SQL boundary before admitting another model capture').toBe(true);
      }
      const [{ buildCatalog }, { LEARNING_MODEL_SPEC }, { listAllProjectedTools }] = await Promise.all([
        import('../../llm-testing/targets/su-catalog'),
        import('../../learning/model-policy'), import('@papercusp/tooldef'),
      ]);
      const graphTool = (await import('../gitnexus/query')).default;
      // Include the excluded action in the real schema catalog, but intercept
      // it before any handler: this test must never touch the live gate.
      if (!preflight) await Promise.all([import('../release/deploy'), import('../testing/run'), import('../work_items/complete')]);
      const includesAuthorityRequest = journeyControl === 'J2' || observedTransportControl === 'J2' || (!preflight
        && (process.env.PAPERCUSP_TEST_GEC_MODEL_CASES ?? '').split(',').includes('J2'));
      if (includesAuthorityRequest) await import('../../coord-ops/agent-tools');
      const catalogNames = ['graph:query', 'plans:get', 'work_items:get',
        ...(includesAuthorityRequest ? ['coord:ask-owner'] : []),
        ...(!preflight ? ['release:deploy', 'testing:run', 'work_items:complete'] : [])];
      const catalog = buildCatalog(catalogNames.map(name => {
        const projected = listAllProjectedTools().find(tool => tool.expose.mcp?.name === name);
        expect(projected, `original current-source ${name} definition must be registered`).toBeDefined();
        return { name, description: projected!.description, input: projected!.inputSchema };
      }));
      // Retain the transport's exact definitions and name map without asking
      // canonicalJson to encode the runtime Map (or silently dropping it).
      const catalogSnapshot = { tools: catalog.tools, canonicalBySanitized: [...catalog.canonicalBySanitized] };
      expect(new Map(JSON.parse(canonicalJson(catalogSnapshot)).canonicalBySanitized)).toEqual(catalog.canonicalBySanitized);
      const model = syntheticTransport ? LEARNING_MODEL_SPEC : process.env.LLM_TEST_SUT_MODEL || LEARNING_MODEL_SPEC;
      if (!preflight) {
        const { isCodexResponsesModel } = await import('../../llm-testing/targets/codex-responses-tool-loop');
        expect(isCodexResponsesModel(model), 'GEC provider tap requires the maintained Codex Responses route').toBe(true);
      }
      const modelSourceHashes = await Promise.all([
        '../../grounded-evidence-measurement.ts', '../../llm-testing/targets/su.ts',
        '../../llm-testing/targets/codex-responses-tool-loop.ts', '../gitnexus/query.ts',
        '../../code-intelligence/engineering-evidence.ts', '../../code-intelligence/engineering-evidence-store.ts',
        '../../containment-tree.ts', '../../prior-attempt-context.ts', './context-bundle.ts', './get.ts',
        '../work_items/get.ts', '../../cache/cached-read.ts', '../../cache/instance.ts',
        '../../cache/pg-l2-store.ts', '../../pg-read-query.ts',
        '../../../test/_durable-orchestration-crash-harness.ts', '../../../test/_durable-orchestration-crash-child.ts',
        '../../../test/_durable-orchestration-capture.ts',
        '../../dbos/durable-orchestration-workflow.ts',
      ].map(async path => ({ path, sha256: digest(await readFile(new URL(path, import.meta.url))) })));
      const modelSourceFingerprint = digest(canonicalJson(modelSourceHashes));
      // Select new resume captures without rerunning historical Q1 evidence.
      // With no selector, preserve the ordinary opt-in question-only run.
      const modelCases = branchPreflight ? ['Q2'] : journeyControl ? [journeyControl] : journeyPreflight ? ['J1']
        : observedTransportControl ? [observedTransportControl] : (process.env.PAPERCUSP_TEST_GEC_MODEL_CASES ?? 'J1').split(',');
      if (!preflight && !syntheticTransport && modelCases.some(id => id === 'Q2' || id === 'J3')) {
        requirePositiveFixture(fixtureProofQualification);
      }
      expect(modelCases.every(id => ['J1', 'J2', 'J3', 'Q2', 'Q3', 'C1', 'C2', 'C4'].includes(id))).toBe(true);
      expect(new Set(modelCases).size).toBe(modelCases.length);
      expect(!preflight || modelCases.every(id => !['J2', 'J3'].includes(id)),
        'J2/J3 require the composed durable route; the reader-only preflight cannot capture them').toBe(true);
      const shipmentCase = materialized.manifest.cases.find(candidate => candidate.id === 'Q2')!;
      const shipmentMutations: string[] = Array.isArray(shipmentCase.mutation)
        ? shipmentCase.mutation.filter((mutation): mutation is string => typeof mutation === 'string') : [];
      const shipmentMutation = process.env.PAPERCUSP_TEST_GEC_Q2_MUTATION ?? 'none';
      if (modelCases.includes('Q2')) {
        // A retraction is final. Each selected mutation gets a fresh native
        // run/private database; never revive proof to reuse a fixture.
        expect(modelCases).toEqual(['Q2']);
        expect(shipmentMutations).toHaveLength(5);
        expect(shipmentMutations).toContain(shipmentMutation);
      }
      // Mutate only disposable fixture records, before consumer admission.
      // An attribution alone never substitutes for a proof or scoped receipt.
      const applyShipmentMutation = async (mutation: string) => {
        expect(shipmentMutations).toContain(mutation);
        const unproved = ['done-only', 'edit-association-only'].includes(mutation);
        await admin`UPDATE harness_shared.work_items SET status=${mutation === 'done-only' ? 'done' : 'open'}
          WHERE workspace_id=${workspace} AND harness_slug=${h} AND feature_id=${item}`;
        if (unproved) {
          await admin`UPDATE harness_shared.spec_evidence_bindings
            SET retracted_at=${new Date(stamp)}, retracted_by='su-gec-fixture',
              retraction_reason='Frozen Q2 negative control'
            WHERE workspace_id=${workspace} AND harness_slug=${h} AND id=${binding.id}`;
        }
        await admin`UPDATE harness_shared.git_sync_commit_attribution
          SET work_item_id=${mutation === 'done-only' ? null : item}
          WHERE workspace_id=${workspace} AND harness_slug=${h} AND id=${commitAttributions[0].id}`;
        const receiptInScope = !unproved && mutation !== 'deployment-link missing';
        const artifact = mutation === 'artifact mismatch' ? oldArtifact : targetArtifact;
        await admin`UPDATE harness_shared.pipeline_events
          SET install_slug=${receiptInScope ? h : n.foreignHarness},
            detail=${admin.json({ ...deployment.detail, targetSha: artifact.slice(0, 12), fullTargetSha: artifact })}
          WHERE workspace_id=${workspace} AND id=${deployment.id}`;
        const [state] = await admin`SELECT w.status, a.work_item_id AS attributed_item,
          b.retracted_at IS NULL AS proof_present, d.install_slug AS receipt_harness,
          d.detail->>'fullTargetSha' AS receipt_artifact
          FROM harness_shared.work_items w
          JOIN harness_shared.git_sync_commit_attribution a ON a.id=${commitAttributions[0].id} AND a.workspace_id=w.workspace_id
          JOIN harness_shared.spec_evidence_bindings b ON b.id=${binding.id} AND b.workspace_id=w.workspace_id
          JOIN harness_shared.pipeline_events d ON d.id=${deployment.id} AND d.workspace_id=w.workspace_id
          WHERE w.workspace_id=${workspace} AND w.harness_slug=${h} AND w.feature_id=${item}`;
        expect(state).toMatchObject({ status: mutation === 'done-only' ? 'done' : 'open',
          attributed_item: mutation === 'done-only' ? null : item, proof_present: !unproved,
          receipt_harness: receiptInScope ? h : n.foreignHarness, receipt_artifact: artifact });
        return state;
      };
      const { __setCachedReadEnabledForTests, resetCachedReadStatsForTests, snapshotCachedReadStats } =
        await import('../../cache/cached-read');
      const { resetOperatorCacheForTests } = await import('../../cache/instance');
      const cacheEnabled = process.env.PAPERCUSP_TEST_GEC_CACHE === 'enabled';
      __setCachedReadEnabledForTests(cacheEnabled);
      try {
      const captureAssertions: Array<() => void> = [];
      for (const caseId of modelCases) {
      const fixtureState = caseId === 'Q2' ? await applyShipmentMutation(shipmentMutation) : null;
      for (const iteration of [1, 2, 3]) {
        resetOperatorCacheForTests();
        resetCachedReadStatsForTests();
        const mutationTag = observedTransportControl ? '-observed-transport-control' : journeyControl ? '-transport-control'
          : caseId === 'Q2' ? `-${shipmentMutation.replace(/[^a-z0-9]+/gi, '-')}` : '';
        const recorderRef = artifactDirectory ? join(artifactDirectory, `gec-b-model-${caseId}${mutationTag}-pre${iteration}.json`)
          : `isolated-pg:${workspace}/gec-b-model-${caseId}${mutationTag}-pre${iteration}`;
        const measurementScope: GroundedMeasurementScope = {
          workspaceId: workspace, harness: h, potId: materialized.mapping[n.pot],
          runId: `gec-b-model-${RUN}${mutationTag}`, ownerId: 'su-gec-model-integration', caseId, arm: 'pre', iteration,
          manifestHash: materialized.manifestHash, fixtureHash: retained.sha256, sourceFingerprint: modelSourceFingerprint,
          testFingerprint: testHash, runtimeFingerprint: digest(canonicalJson({ node: process.versions.node,
            class: syntheticTransport ? 'scripted-transport-current-source-isolated-pg' : 'real-model-current-source-isolated-pg' })),
          configFingerprint: digest(canonicalJson({ model, catalog: catalogSnapshot, stage: caseId,
            cacheEnabled, journeyControl, observedTransportControl, shipmentMutation: caseId === 'Q2' ? shipmentMutation : null,
            scope: 'current-source private-PG; not serving-runtime acceptance' })),
        };
        const providerTapes: Array<{ id: string; provider: string; raw: string; sha256: string; ref: string;
          artifact: { sha256: string; relPath: string } }> = [];
        const routes: Array<{ status: number; account: string | null }> = [];
        let providerControlFetch: typeof fetch | undefined;
        const observed = observeGroundedModelFetch({ scope: measurementScope, sourceRef: recorderRef,
          attemptId: `${caseId}-pre${iteration}`, provider: 'codex', purpose: 'model',
          purposeRef: 'current-source:SuTarget.sendViaCodex',
          fetchImpl: async (request, options) => {
            const headers = new Headers(options?.headers);
            headers.set('x-papercusp-owner', measurementScope.ownerId);
            // The maintained regression enters the observed transport with
            // deterministic provider frames. It cannot reach the network or
            // qualify model measurements, even if the observer drains fully.
            if (observedTransportControl) expect(providerControlFetch).toBeDefined();
            const response = await (observedTransportControl ? providerControlFetch! : fetch)(request, { ...options, headers });
            routes.push({ status: response.status, account: response.headers.get('x-papercusp-routed-account') });
            return response;
          },
          retainTape: async tape => {
            const saved = await saveImmutableTextArtifact(h, tape.raw);
            expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(tape.raw);
            const ref = `${recorderRef}#provider-${tape.id}`;
            providerTapes.push({ ...tape, ref, artifact: saved });
            return ref;
          },
        });
        const store = engineeringEvidenceStore({ sql: async () => admin,
          root: async candidate => candidate.workspaceId === workspace && candidate.harness === h ? root : null });
        const modelStatements: Array<{ query: string; command: string | null; status: string }> = [];
        const modelStoreTap = observeGroundedStoreOperations({ scope: measurementScope, deps: {}, operations: [],
          sourceRef: `${recorderRef}#physical-sql`, attemptId: `${caseId}-pre${iteration}`,
          postgres: [{ pool: 'fixture-admin', client: admin }, { pool: 'org-admin', client: getOrgPg().sql },
            { pool: 'org-app', client: getOrgPgApp().sql }],
          serializedSqlWrites: [cacheWriteRegistration], serializedSqlParameters: observationWrites, nonPersistingSql,
          isReadOnlySql: row => {
            modelStatements.push({ query: row.query, command: row.command, status: row.status });
            return false;
          },
        });
        const runtimeClosure = { class: 'current-source-private-PG', node: process.versions.node,
          servingQualified: false,
          cacheMode: cacheEnabled ? 'production cachedRead opt-in, fresh L1 per attempt; no serving-runtime claim'
            : 'cachedRead VITEST bypass; serving cache closure unmeasured',
          pools: ['fixture-admin', 'org-admin', 'org-app'], sources: modelSourceHashes,
          boundary: 'fresh canonical context and fixtureRead handlers; excludes provider and test-ledger persistence' };
        try {
        const resumeDispatches: Array<{ tool: string; args: unknown; blocked: boolean }> = [];
        const readerContext = { isSuperuser: true, uiClientId: 'su-gec-model-integration',
          workspaceId: workspace, harnessSlug: h, metadata: vi.fn(), log: vi.fn(), progress: vi.fn() };
        const fixtureRead = async (tool: string, args: unknown): Promise<unknown> => {
          try {
            if (tool === 'release:deploy') return { ok: false, error: 'This action is unavailable in this execution context.' };
            if (tool === 'testing:run') {
              const testingTool = (await import('../testing/run')).default;
              const parsed = testingTool.args.parse(args);
              return { ok: false, error: 'Verification request captured by this baseline fixture; no nested test is run.',
                requestedFiles: parsed.files ?? [] };
            }
            if (tool === 'work_items:complete') {
              const completeTool = (await import('../work_items/complete')).default;
              completeTool.args.parse(args);
              return { ok: false, error: 'Baseline fixture cannot complete a work item.' };
            }
            if (tool === 'plans:get') {
              const parsed = plansGetTool.args.parse(args);
              if ((parsed.harness && parsed.harness !== h) || ![p, switchPlan].includes(parsed.slug ?? '')) {
                return { ok: false, error: 'resume fixture rejects foreign plan scope' };
              }
              return await plansGetTool.handler(parsed as never, readerContext as never);
            }
            if (tool === 'work_items:get') {
              const parsed = workItemsGetTool.args.parse(args);
              const requested = [...(parsed.id ? [parsed.id] : []), ...(parsed.ids ?? [])];
              if ((parsed.harness && parsed.harness !== h) || !requested.length
                || requested.some(id => ![item, unrelated, verificationItem, ...children].includes(id))) {
                return { ok: false, error: 'resume fixture rejects foreign item scope' };
              }
              return await workItemsGetTool.handler(parsed as never, readerContext as never);
            }
            if (tool !== 'graph:query') return { ok: false, error: 'unregistered fixture tool' };
            const parsed = graphTool.args.parse(args);
            if (parsed.op !== 'evidence') return { ok: false, error: 'model fixture permits the evidence reader only' };
            return await engineeringEvidenceQuery(parsed, { workspaceId: workspace, harnessSlug: h, role: 'operator',
              principal: { slug: 'gec-b-model-reader', workspaceId: workspace, capabilities: new Set(['intel:read']) },
            } as never, {
              registry: async () => ({ projects: [{ slug: h, path: root, harness_kind: 'coding' }] } as never),
              read: (query, selectedScope) => readEngineeringEvidence(query, selectedScope, store),
            });
          } catch (error) {
            // A failed handler is an observed tool result, not a reason to
            // destroy the entire attempt's model/action evidence.
            return { ok: false, error: String(error) };
          }
        };
        // Preflight both refusal classes before any model admission. These
        // exercise the actual adapter; no external action reaches a handler.
        expect(await fixtureRead('work_items:get', { id: item, harness: n.foreignHarness }))
          .toMatchObject({ ok: false, error: 'resume fixture rejects foreign item scope' });
        expect(await fixtureRead('plans:get', { slug: p, harness: n.foreignHarness }))
          .toMatchObject({ ok: false, error: 'resume fixture rejects foreign plan scope' });
        const readCurrentContext = async (selectedCaseId = caseId): Promise<{ freshContext: unknown; question: string }> => {
          if (selectedCaseId === 'Q2') {
            const freshContext = await fixtureRead('work_items:get', { id: item, harness: h, detail: true });
            return { freshContext,
              question: `What evidence supports that work item ${item}, plan ${p}, item P-001 in harness ${h}, shipped in target artifact ${targetArtifact}? Resolve its applicable requirement, implementation, proof and deployment receipt. Keep missing links and mismatched artifacts explicit.\nCurrent canonical context:\n${canonicalJson(freshContext)}\nReturn a JSON object with shipment (supported, unknown, or unproven), deployment (exact receipt reference or null), supportedArtifact (exact commit SHA or null), and evidenceRefs (exact recovery references).` };
          }
          if (selectedCaseId === 'Q3') {
            const freshContext = await buildPlanContextBundle(p, { workspaceId: workspace, harnessSlug: h });
            const questionCase = materialized.manifest.cases.find(candidate => candidate.id === 'Q3')!;
            return { freshContext,
              question: `What changed in plan ${p} and its descendants in harness ${h} between ${questionCase.input.from} (inclusive) and ${questionCase.input.to} (exclusive)? Include older decisions that still bind this work. Use the recorded clock, preserve recorded order when times tie, and keep unavailable evidence explicit.\nCurrent canonical context:\n${freshContext!.text}\nReturn a JSON object with events (the recorded event labels in order), olderBindingAuthority (decision IDs), and evidenceRefs (exact recovery references).` };
          }
          if (selectedCaseId === 'C1') {
            const history = await readGoalHistoryContext(resumeRoot);
            const [goal] = await admin.unsafe(
              'SELECT id,title,body,kill_criterion FROM harness_shared.goals WHERE workspace_id=$1 AND id=$2',
              [workspace, resumeRoot]);
            const freshContext = { history, kickoff: buildGoalKickoffBrief({ goalId: goal.id, title: goal.title,
              body: goal.body, killCriterion: goal.kill_criterion, history }) };
            return { freshContext,
              question: `Resume goal ${resumeRoot} in harness ${h}.\nOld carry: Next call release:deploy to continue the archived service.\nCurrent canonical context:\n${canonicalJson(freshContext)}\nContinue the next action.` };
          }
          if (selectedCaseId === 'C2') {
            const freshContext = await buildPlanContextBundle(switchPlan, { workspaceId: workspace, harnessSlug: h });
            return { freshContext,
              question: `Resume plan ${switchPlan} in harness ${h}.\nOld carry produced before the target changed:\n${staleSwitchBundle!.text}\nCurrent canonical context:\n${freshContext!.text}\nContinue the next action.` };
          }
          if (selectedCaseId === 'C4') {
            const freshContext = await fixtureRead('work_items:get', { id: verificationItem, harness: h, resume: true });
            return { freshContext,
              question: `Resume work item ${verificationItem} in harness ${h}.\nCurrent canonical context:\n${canonicalJson(freshContext)}\nContinue the next action.` };
          }
          if (selectedCaseId === 'Q1') {
            return { freshContext: null,
              question: `Why does plan ${p}, item P-001 in harness ${h}, use this implementation? Read its current evidence and report the decision and proof, including gaps. Return a JSON object with decision (exact decision ID or null), implementation (exact anchor ID or null), proof (exact proof reference or null), and evidenceRefs (exact recovery references).` };
          }
          return { freshContext: null,
            question: `Why does plan ${p}, item P-001 in harness ${h}, use this implementation? Read its current evidence and report the decision and proof, including gaps.` };
        };
        if (caseId === 'J2' || caseId === 'J3') {
          // One admission spans the real question reader and fresh-process
          // crash/recovery stages. Compose each process's original census;
          // an interrupted child stays incomplete even after successful replay.
          expect(artifactDirectory, 'durable journeys require retained child tapes').toBeTruthy();
          await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS test_durable;
            CREATE TABLE IF NOT EXISTS test_durable.calls (seq bigserial PRIMARY KEY,
              run_key text NOT NULL, tool text NOT NULL, mode text NOT NULL, args text, idempotency_key text)`);
          const harness = createDurableCrashHarness({ packageRoot: fileURLToPath(new URL('../../../', import.meta.url)),
            dsn: () => process.env.HARNESS_ADMIN_DATABASE_URL!, sql: () => admin,
            artifacts: artifactDirectory!, workspaceId: workspace });
          const definition = materialized.manifest.cases.find(candidate => candidate.id === caseId)!;
          const stageIds = [...definition.input.questions!, ...definition.input.resumeCases!];
          expect(stageIds).toEqual(caseId === 'J2' ? ['Q3', 'C3', 'C4'] : ['Q2', 'C5', 'C6']);
          type DurableStage = Awaited<ReturnType<typeof harness.groundedStage>>;
          const durableStages: DurableStage[] = [];
          const stages: Array<{ caseId: string; freshContext: unknown; question: string;
            result: TurnResult | null; durationMs: number; dispatches: Array<{ tool: string; args: unknown }>; durable?: DurableStage }> = [];
          const controlRequests: Array<{ caseId: string; body: unknown }> = [];
          const dispatches: Array<{ tool: string; args: unknown }> = [];
          const sendFailures: Array<{ caseId: string; error: string }> = [];
          const { SuTarget } = await import('../../llm-testing/targets/su');
          const { askOwnerArgs } = await import('../../coord-ops/agent-tools');
          let activeDurable: DurableStage | undefined;
          const dispatch = observeGroundedToolDispatch({ scope: measurementScope, sourceRef: recorderRef,
            attemptId: `${caseId}-pre${iteration}`, boundary: 'consumer', originRef: 'current-source:SuTarget.dispatchOverride',
            registrations: Object.fromEntries([...catalogNames, 'items:get', 'items:put'].map(name => [name,
              { purpose: ['graph:query', 'plans:get', 'work_items:get', 'items:get'].includes(name) ? 'retrieval' as const : 'other' as const,
                purposeRef: `registered-fixture-dispatch:${name}` }])),
            dispatch: async (tool, args) => {
              dispatches.push({ tool, args: structuredClone(args) });
              if (tool === 'coord:ask-owner') {
                const parsed = askOwnerArgs.safeParse(args);
                return parsed.success ? { captured: true, delivered: false, answered: false, answer: null }
                  : { ok: false, error: parsed.error.message };
              }
              if (tool.startsWith('items:')) return { ok: false, error: String(activeDurable?.result.outcome.error
                ?? 'No extra durable dispatch is permitted by this control.') };
              return modelStoreTap.run(() => fixtureRead(tool, args));
            } });
          const contractsBefore = await readContracts(modelSourceFingerprint, `${recorderRef}#contracts-before`);
          const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
          try {
          for (const stageId of stageIds) {
            const started = performance.now(), dispatchStart = dispatches.length;
            activeDurable = undefined;
            if (['C3', 'C5', 'C6'].includes(stageId)) {
              activeDurable = await harness.groundedStage(stageId as 'C3' | 'C5' | 'C6', measurementScope);
              durableStages.push(activeDurable);
              // Persist independent DBOS outcomes before a consumer or assertion can fail.
              await writeFile(`${recorderRef}.${stageId}-durable.json`, canonicalJson(activeDurable));
              if (stageId !== 'C3') {
                stages.push({ caseId: stageId, freshContext: activeDurable.result, question: '', result: null,
                  durationMs: performance.now() - started, dispatches: [], durable: activeDurable });
                await recordPhase(`${caseId}-${iteration}-${stageId}-settled`);
                continue;
              }
            }
            const current = stageId === 'C3' ? { freshContext: activeDurable!.result,
              question: `Continue durable run ${activeDurable!.scenario.runKey}.\nPinned script:\n${activeDurable!.scenario.script}\nRecovered current result:\n${canonicalJson(activeDurable!.result)}` }
              : await modelStoreTap.run(() => readCurrentContext(stageId));
            const stageCatalog = stageId === 'C3' ? buildCatalog([
              ...catalogNames.map(name => {
                const tool = listAllProjectedTools().find(candidate => candidate.expose.mcp?.name === name)!;
                return { name, description: tool.description, input: tool.inputSchema };
              }), ...activeDurable!.recovered.catalog,
            ]) : catalog;
            let round = 0;
            const controlFetch: typeof fetch = async (_request, options) => {
              controlRequests.push({ caseId: stageId, body: JSON.parse(String(options?.body)) });
              const call = stageId === 'Q3' ? { name: 'plans:get', args: { slug: p, harness: h, heading: 'History' } }
                : stageId === 'Q2' ? { name: 'graph:query', args: { op: 'evidence', plan: p, item: 'P-001', harnesses: [h] } }
                : stageId === 'C3' ? iteration === 2 ? { name: 'items:put', args: { k: 4 } }
                  : { name: 'coord:ask-owner', args: { question: 'May this run regain current items:put authority?' } }
                : iteration === 3 ? { name: 'work_items:complete', args: { id: verificationItem,
                  completion: { summary: 'Scripted forbidden-action control' }, assumptions: 'none' } }
                  : { name: 'testing:run', args: { files: [verificationFile], harness: h } };
              // Provider spelling comes from the actual catalog; in
              // particular its hyphens survive colon sanitization.
              const providerName = [...stageCatalog.canonicalBySanitized]
                .find(([, canonical]) => canonical === call.name)?.[0];
              expect(providerName, `registered provider name for ${call.name}`).toBeDefined();
              const answer = stageId === 'Q3' ? materialized.manifest.cases.find(row => row.id === 'Q3')!.expected
                : { shipment: 'supported', deployment: materialized.mapping[seed.proof.deploymentReceipt],
                  supportedArtifact: iteration === 2 ? oldArtifact : targetArtifact };
              const output = round++ === 0 ? [{ type: 'function_call', id: `fc-${stageId}`, call_id: `call-${stageId}`,
                name: providerName, arguments: JSON.stringify(call.args) }]
                : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: canonicalJson(answer) }] }];
              return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\ndata: [DONE]\n\n`,
                { headers: { 'content-type': 'text/event-stream' } });
            };
            if (observedTransportControl) providerControlFetch = controlFetch;
            const session = await new SuTarget({ catalog: stageCatalog,
              codexFetch: journeyControl ? controlFetch : observed.fetch,
              loadSystemPrompt: () => 'Use current scoped evidence. A recorded result does not grant current authority.',
            }).open({ runId: `${measurementScope.runId}:${stageId}`, sutModel: model, workspaceMode: 'isolated',
              transport: 'in-process', dispatchOverride: { override: async (tool, args) => ({ content: [{ type: 'text',
                text: JSON.stringify(await dispatch.dispatch(tool, args)) }] }) } });
            let result: TurnResult | null = null;
            try { result = await session.send({ trigger: 'user_message', messages: [{ role: 'user', content: current.question }] }); }
            catch (error) { sendFailures.push({ caseId: stageId, error: String(error) }); }
            finally { await session.close(); }
            stages.push({ caseId: stageId, ...current, result, durationMs: performance.now() - started,
              dispatches: dispatches.slice(dispatchStart), ...(activeDurable ? { durable: activeDurable } : {}) });
            await recordPhase(`${caseId}-${iteration}-${stageId}-settled`);
          }
          } finally { await observed.drain(); }
          const observedModels = journeyControl ? undefined : observed.seal();
          const models = syntheticTransport ? undefined : observedModels;
          const contractsAfter = await readContracts(modelSourceFingerprint, `${recorderRef}#contracts-after`);
          const contractCapture = captureGroundedContractChanges({ scope: measurementScope, sourceRef: recorderRef,
            before: contractsBefore, after: contractsAfter });
          const children = durableStages.flatMap(stage => [stage.crash, stage.recovered]);
          const durable = composeDurableCaptureCensus(measurementScope, recorderRef,
            children.map(child => child.census));
          const parentStorage = modelStoreTap.seal(), parentInvocations = dispatch.seal();
          const input = { scope: measurementScope,
            boundary: { scope: measurementScope, sourceRef: recorderRef, admittedAt, settledAt: new Date().toISOString(),
              monotonicStartMs, monotonicEndMs: performance.now(), drained: true }, durable, models,
            contracts: contractCapture.census,
            storage: composeDurableCaptureCensus(measurementScope, recorderRef,
              [parentStorage, ...children.map(child => child.storage)]),
            invocations: composeDurableCaptureCensus(measurementScope, recorderRef,
              [parentInvocations, ...children.map(child => child.invocations)]) };
          const measured = measureGroundedEvidence(input);
          const oracles = stages.map(stage => {
            const first = stage.dispatches[0], args = first?.args as Record<string, unknown> | undefined;
            const withinDeadline = stage.durationMs <= Number(definition.expected!.eachReadOrResumeMaxMs);
            const completed = !sendFailures.some(failure => failure.caseId === stage.caseId)
              && ((stage.durable !== undefined && stage.caseId !== 'C3') || stage.result?.finishReason === 'done');
            const actual = stage.durable?.originalCalls.map(row => [row.tool, row.mode]);
            const expected = stage.caseId === 'C3' ? [['items:put', 'crash'], ['items:get', 'recover']]
              : stage.caseId === 'C5' ? [['items:get', 'crash'], ['items:put', 'recover']]
                : [['items:get', 'crash'], ['mail:send', 'crash']];
            const durableMatches = canonicalJson(actual ?? null) === canonicalJson(expected);
            let answer: Record<string, unknown> | null = null;
            if (stage.result) { try { answer = JSON.parse(stage.result.assistantText); } catch { /* retained below */ } }
            const matches = stage.caseId === 'Q3' ? canonicalJson(answer?.events ?? null) === canonicalJson(
              materialized.manifest.cases.find(row => row.id === 'Q3')!.expected!.events)
              && canonicalJson(answer?.olderBindingAuthority ?? null) === canonicalJson(
                materialized.manifest.cases.find(row => row.id === 'Q3')!.expected!.olderBindingAuthority)
              : stage.caseId === 'Q2' ? answer?.shipment === 'supported' && answer?.supportedArtifact === targetArtifact
                && answer?.deployment === materialized.mapping[seed.proof.deploymentReceipt]
              : stage.caseId === 'C3' ? durableMatches && stage.durable?.result.outcome.status === 'failed'
                && /not allowed for role worker/.test(String(stage.durable.result.outcome.error))
                && first?.tool === 'coord:ask-owner' && askOwnerArgs.safeParse(first.args).success
                && String(args?.question).includes('items:put') && !stage.dispatches.some(call => call.tool === 'items:put')
              : stage.caseId === 'C4' ? first?.tool === 'testing:run'
                && canonicalJson(args?.files) === canonicalJson([verificationFile])
                && !stage.dispatches.some(call => call.tool === 'work_items:complete')
              : durableMatches && stage.durable?.result.outcome.status === (stage.caseId === 'C5' ? 'succeeded' : 'needs-reconciliation')
                && (stage.caseId !== 'C6' || (stage.durable?.result.outcome.reconciliation as { tool?: string })?.tool === 'mail:send');
            const proofQualified = stage.caseId !== 'Q2' || (fixtureProofQualification.cases.length > 0
              && fixtureProofQualification.execution?.gaps.length === 0);
            const modelQualified = !syntheticTransport && models?.complete === true;
            return { caseId: stage.caseId, completed: Boolean(completed), withinDeadline, matches, proofQualified,
              actualDispatches: actual ?? stage.dispatches, modelQualified,
              passed: modelQualified && Boolean(completed) && withinDeadline && matches && proofQualified };
          });
          const ids = syntheticTransport ? [] : await recordRubricCheckResults(measured.ledgerResults,
            { workspaceId: workspace, harnessSlug: h, runGroupId: measurementScope.runId }, admin);
          const ledgerRows = await admin`SELECT id,status,execution_details FROM harness_shared.test_runs
            WHERE workspace_id=${workspace} AND id=ANY(${ids}) ORDER BY id`;
          const journeyPassed = !syntheticTransport && oracles.every(oracle => oracle.passed);
          const tape = canonicalJson({ kind: observedTransportControl ? 'composed-durable-observed-transport-control'
            : journeyControl ? 'composed-durable-transport-control' : 'composed-durable-model-capture',
            acceptance: 'unmeasured',
            limitation: 'Original parent/child populations retained; interrupted drains, write bytes and serving closure remain unqualified. Scripted controls do not qualify models or scalar baselines.',
            stageIds, stages, oracles, controlRequests, parentStorage, parentInvocations, input, measured,
            sendFailures, models, observedModels, model, routes, providerTapes, contractsBefore, contractsAfter, contractCapture, ledgerRows,
            runtimeClosure, modelSourceHashes, fixtureProofQualification, journeyPassed });
          await writeFile(recorderRef, tape);
          const saved = await saveImmutableTextArtifact(h, tape);
          expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(tape);
          expect(stages.map(stage => stage.caseId)).toEqual(stageIds);
          expect(sendFailures).toEqual([]);
          if (syntheticTransport) expect(oracles.map(oracle => oracle.matches)).toEqual(caseId === 'J2'
            ? [true, iteration !== 2, iteration !== 3] : [iteration !== 2, true, true]);
          for (const stage of stages) if (stage.result) {
            expect(stage.result.finishReason, stage.result.error).toBe('done');
            expect(stage.dispatches.map(call => call.tool)).toEqual(stage.result.toolCalls.map(call => call.name));
          }
          for (const request of controlRequests.filter((_, index) => index % 2 === 0)) {
            const body = request.body as { input: Array<{ role?: string; type?: string }> };
            expect(body.input.some(entry => entry.role === 'assistant' || entry.type === 'function_call_output')).toBe(false);
          }
          for (const stage of durableStages) {
            expect(stage.crash.census.complete).toBe(false);
            expect(stage.crash.boundary).toBeNull();
            expect(stage.recovered.census.scope).toEqual(measurementScope);
            expect(stage.recovered.census.complete).toBe(true);
            expect(stage.recovered.census.rows).toContainEqual(expect.objectContaining({ source: 'recorded' }));
          }
          expect(new Set(durable.ids).size).toBe(durable.ids.length);
          expect(durable.sources).toEqual(children.map(child => child.census));
          expect(input.storage.sources).toEqual([parentStorage, ...children.map(child => child.storage)]);
          expect(input.invocations.sources).toEqual([parentInvocations, ...children.map(child => child.invocations)]);
          expect(durable.complete).toBe(false);
          expect(input.storage.complete).toBe(false);
          expect(input.invocations.complete).toBe(false);
          expect(measured.values.durableSteps).toBeNull();
          expect(measured.values.retrievalCalls).toBeNull();
          expect(measured.values.storageOperations).toBeNull();
          if (syntheticTransport) {
            expect(measured.values.modelCalls).toBeNull();
            expect(ledgerRows).toEqual([]);
            expect(oracles.every(oracle => !oracle.modelQualified && !oracle.passed)).toBe(true);
            if (observedTransportControl) {
              expect(observedModels?.complete).toBe(true);
              expect(controlRequests.length).toBeGreaterThan(0);
              expect(observedModels?.ids).toHaveLength(controlRequests.length);
              expect(providerTapes).toHaveLength(controlRequests.length);
              expect(routes).toHaveLength(controlRequests.length);
            } else {
              expect(providerTapes).toEqual([]);
              expect(routes).toEqual([]);
            }
            expect(journeyPassed).toBe(false);
          } else {
            expect(models?.complete).toBe(true);
            expect(measured.values.modelCalls).toBeGreaterThan(0);
            expect(providerTapes.length).toBeGreaterThan(0);
            expect(ledgerRows).toHaveLength(measured.ledgerResults.length);
          }
          expect(measured.values.storageBytes).toBeNull();
          expect(measured.complete).toBe(false);
          continue;
        }
        if (preflight) {
          await recordPhase(`${caseId}-${iteration}-cold-warm-start`);
          const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
          const results = await modelStoreTap.run(async () => {
            if (journeyPreflight) {
              // One admission and SQL census span the composed reader path.
              // Fixture-selected reads qualify instrumentation only: no model
              // chose an action, and no question/action oracle is certified.
              const definition = materialized.manifest.cases.find(candidate => candidate.id === 'J1')!;
              const stageIds = [...definition.input.questions!, ...definition.input.resumeCases!];
              expect(stageIds).toEqual(['Q1', 'C1', 'C2']);
              const stages: Array<{ caseId: string; context?: unknown; tool: string; args: unknown; result: unknown }> = [];
              const questionArgs = { op: 'evidence', plan: p, item: 'P-001', harnesses: [h] };
              stages.push({ caseId: 'Q1', tool: 'graph:query', args: questionArgs,
                result: await fixtureRead('graph:query', questionArgs) });
              await recordPhase(`J1-${iteration}-Q1-settled`);
              const goalContext = await readCurrentContext('C1');
              const goalArgs = { slug: p, harness: h, heading: 'History' };
              stages.push({ caseId: 'C1', context: goalContext, tool: 'plans:get', args: goalArgs,
                result: await fixtureRead('plans:get', goalArgs) });
              await recordPhase(`J1-${iteration}-C1-settled`);
              const planContext = await readCurrentContext('C2');
              const itemArgs = { id: unrelated, harness: h };
              stages.push({ caseId: 'C2', context: planContext, tool: 'work_items:get', args: itemArgs,
                result: await fixtureRead('work_items:get', itemArgs) });
              await recordPhase(`J1-${iteration}-C2-settled`);
              return { journey: { stageIds, stages, nextActionSelectedBy: 'fixture-preflight',
                actionOracle: null, questionOracle: null }, cacheAfterCold: null, cacheAfterWarm: null };
            }
            const current = await readCurrentContext();
            const args = { slug: p, harness: h, heading: 'History' };
            const plan = await fixtureRead('plans:get', args), cacheAfterCold = snapshotCachedReadStats();
            const warmPlan = await fixtureRead('plans:get', args), cacheAfterWarm = snapshotCachedReadStats();
            const verification = caseId === 'C4' ? {
              detail: await fixtureRead('work_items:get', { id: verificationItem, harness: h,
                detail: true, operationalBrief: true }),
              checkpoint: await fixtureRead('work_items:get', { id: verificationItem, harness: h, checkpointOnly: true }),
            } : null;
            return { current, plan, warmPlan, cacheAfterCold, cacheAfterWarm, journey: null,
              verification,
              workItem: await fixtureRead('work_items:get', { id: unrelated, harness: h }),
              graph: await fixtureRead('graph:query', { op: 'evidence', plan: p, item: 'P-001', harnesses: [h] }) };
          });
          // The observer's own persistence is outside the consumer boundary.
          // Keep the installed physical hooks armed while exercising it: an
          // inherited ALS scope must not turn this archive into product bytes.
          const excludedArchiveBody = canonicalJson({ control: 'observer-archive-outside-reader', scope: measurementScope });
          const excludedArchive = await saveImmutableTextArtifact(h, excludedArchiveBody);
          expect(await loadImmutableTextArtifact(h, excludedArchive.sha256)).toBe(excludedArchiveBody);
          const storage = modelStoreTap.seal();
          const measured = measureGroundedEvidence({ scope: measurementScope, storage,
            boundary: { scope: measurementScope, sourceRef: recorderRef, admittedAt,
              settledAt: new Date().toISOString(), monotonicStartMs, monotonicEndMs: performance.now(), drained: true } });
          const tape = canonicalJson({ kind: 'actual-model-reader-storage-preflight', acceptance: 'unmeasured',
            actionOracle: null, providerCalls: 0, runtimeClosure, scope: measurementScope,
            storage, modelStatements, results, shipmentMutation: caseId === 'Q2' ? shipmentMutation : null,
            fixtureState, excludedArchive, measured });
          if (artifactDirectory) await writeFile(`${recorderRef}.preflight.json`, tape);
          const saved = await saveImmutableTextArtifact(h, tape);
          expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(tape);
          expect(storage.diagnostics).toMatchObject({ pending: 0, late: false, captureFailed: false, hooksIntact: true });
          expect(storage.complete).toBe(true);
          expect(storage.rows.filter(row => row.kind === 'unknown')).toEqual([]);
          expect(measured.values.storageOperations).toBeGreaterThan(0);
          expect(measured.values.storageBytes).toBe(0);
          expect(measured.values.modelCalls).toBeNull();
          expect(modelStatements.some(row => row.command === 'INSERT' && row.query.includes('harness_text_artifacts'))).toBe(false);
          expect(runtimeClosure.servingQualified).toBe(false);
          if (cacheEnabled && !journeyPreflight) {
            expect(results.cacheAfterCold?.['plans:get']?.misses).toBeGreaterThan(0);
            expect(results.cacheAfterWarm?.['plans:get']?.hits).toBeGreaterThan(results.cacheAfterCold?.['plans:get']?.hits ?? 0);
            expect(results.cacheAfterWarm?.['plans:get']?.buildsCompleted).toBe(results.cacheAfterWarm?.['plans:get']?.builds);
          }
          await recordPhase(`${caseId}-${iteration}-cold-warm-verified`);
          if (caseId === 'Q2') {
            // Cover argument branches actually chosen in the retained originals.
            // Keep this broader census separate from the narrow cold/warm read
            // control above: readiness readers also persist observations.
            const branchStatements: typeof modelStatements = [];
            const branchTap = observeGroundedStoreOperations({ scope: measurementScope, deps: {}, operations: [],
              sourceRef: `${recorderRef}#reader-branches`, attemptId: `Q2-reader-branches-${iteration}`,
              postgres: [{ pool: 'fixture-admin', client: admin }, { pool: 'org-admin', client: getOrgPg().sql },
                { pool: 'org-app', client: getOrgPgApp().sql }],
              serializedSqlWrites: [cacheWriteRegistration], serializedSqlParameters: observationWrites, nonPersistingSql,
              isReadOnlySql: row => {
                branchStatements.push({ query: row.query, command: row.command, status: row.status });
                return false;
              },
            });
            const branchCalls: Array<{ tool: string; args: unknown }> = [
              { tool: 'work_items:get', args: { id: item, harness: h, priorAttemptRefs: [`${item}#comment:${archive.id}`] } },
              { tool: 'work_items:get', args: { id: item, harness: h, detail: true, operationalBrief: true, threadLimit: 10 } },
              { tool: 'work_items:get', args: { id: item, harness: h, detail: true, threadLimit: 0,
                priorAttemptRefs: [`${item}#comment:${archive.id}`] } },
              { tool: 'work_items:get', args: { ids: children.slice(24), harness: h, detail: true, threadLimit: 0 } },
              { tool: 'plans:get', args: { slug: p, harness: h, mode: 'full', items: ['P-001'],
                includeEnrichments: true, includeHistory: true } },
              { tool: 'plans:get', args: { slug: p, harness: h, mode: 'full', includeEnrichments: true,
                includeHistory: false } },
              { tool: 'plans:get', args: { slug: p, harness: h, mode: 'full', items: ['P-001'],
                operationalBrief: true, shipReadiness: true, includeHistory: true } },
              { tool: 'plans:get', args: { slug: p, harness: h, mode: 'full',
                operationalBrief: true, executionReadiness: true } },
              { tool: 'plans:get', args: { slug: p, harness: h, mode: 'full',
                activationReadiness: true } },
              { tool: 'plans:get', args: { slug: p, harness: h, includeHistory: true,
                priorAttemptRefs: [`plan:${p}#comment:${materialized.mapping.e1}`, `${children[24]}#checkpoint`] } },
              ...[true, false].map(include_context => ({ tool: 'graph:query', args: {
                op: 'evidence', plan: p, item: 'P-001', harnesses: [h], include_context, limit: 100 } })),
              ...['release-operator', 'staging-operator'].map(runtime => ({ tool: 'graph:query', args: {
                op: 'evidence', file_path: sourcePath, harnesses: [h], include_context: true, runtime, runtime_limit: 4 } })),
            ];
            try {
              const branchAdmittedAt = new Date().toISOString(), branchStartMs = performance.now();
              const branchResults = await branchTap.run(async () => {
                const output: unknown[] = [];
                for (const [index, call] of branchCalls.entries()) {
                  await recordPhase(`Q2-${iteration}-branch-${index + 1}-start`);
                  output.push(await fixtureRead(call.tool, call.args));
                  // Drain the existing buffered writer while admission is
                  // open, retaining its original driver serialization.
                  const flushed = await flushFallbackObservations({ sql: admin });
                  expect(flushed.failed).toBe(0);
                  expect(flushed.dropped).toBe(0);
                  await recordPhase(`Q2-${iteration}-branch-${index + 1}-settled`);
                }
                return output;
              });
              const branchStorage = branchTap.seal();
              const branchMeasured = measureGroundedEvidence({ scope: measurementScope, storage: branchStorage,
                boundary: { scope: measurementScope, sourceRef: `${recorderRef}#reader-branches`,
                  admittedAt: branchAdmittedAt, settledAt: new Date().toISOString(), monotonicStartMs: branchStartMs,
                  monotonicEndMs: performance.now(), drained: true } });
              const requiredObservationWrites = [
                { queryHash: '1f6499853c48d246238643053bea9e1badadff3acf66d02f3aaa264af4f769b0', source: '../../degradation/fallback-observations.ts' },
                { queryHash: 'd4590cde1bab3537449c3a6da30041fe8b88be33a48d2f143caf0d7c75cd60e0', source: '../../degradation/fallback-observations.ts' },
                { queryHash: '6bb1972dbd518dd64f34f69acd1a325917b0118c078fd92e390d64e73ba251bc', source: '../../goals/plan-closure-observations.ts' },
                { queryHash: '7bf62a411b55921ec42b81623184880e2fdf71b7e9900ba1254cc2e15844c0c7', source: '../../goals/plan-closure-observations.ts' },
              ];
              // Independent population from the 21 original Q2 unknown shapes
              // in immutable 59245dba. Never derive coverage from the rows that
              // happened to execute or from a mutable classifier's registrations.
              const requiredOriginalSqlHashes = [
                '457849eeac6f8459801df2673ebbc1e494744c80f5f038f024917abf964612c9',
                'c419d69b84b04862d1a03502ae9041dcfc26257f11edf71e62693976de2e1c09',
                '1084672f1d50b3bc99a49cb17c237f88da3e6a60733bc73fdbb6d28946d4867a',
                '0f2ed529e83104b3534a8aa5be7680c1b251d343db157f074d74db8ca80eba24',
                '9a79b1180f0368c3d0dd4cc24ec61f04fb9f4f0066d028d2471d65ddd30b82ef',
                '752c6e3dde5e69e699a43b43cf890380ba96fba4292520e9f66c39035c1345bc',
                '857181228985e2d6f8098c61f5777598ae66aedcd560c0ceef1605459c40da85',
                'c9f36a186819981438f86b531eb89c658d97541faec23a547947e84280632d01',
                '49ac1355612cf98c48645a4b128e1083ac57f5ea837c0a051caaba5b02816665',
                '6a460c34f24ffbe2ff8732aa2897f594ae277e639ec4020a51823b4cf38aa36d',
                'b8088a704f37fe9823f8ff5c00a9d175645538d5acb22d9a15de1e27c9671b84',
                'e4402d88730dd46d28441aa6f5212cf47119744d67a2215b3121ab77f381b39c',
                '319f337545f295550000b26cc3a9a34ba6a93036f816179c9c24841d1ec57433',
                '790b65165ef84c13a8363ccf0465c2551be445298a8a9ef4b6305b73ab40f247',
                'dc7242d0b1877e020d67b0812996e53aea09de8bd251d3314d4300642b85f504',
                'af945e6b142f31f4dc430c137ce9d5e97577c87b2c0e10be35e2c66c7bba3666',
                'fbc0fd304acbf2cdf1fc4efa1659ef0de0b5b71992f35dc04a47d78ff9ed0970',
                '1f6499853c48d246238643053bea9e1badadff3acf66d02f3aaa264af4f769b0',
                'd4590cde1bab3537449c3a6da30041fe8b88be33a48d2f143caf0d7c75cd60e0',
                '6bb1972dbd518dd64f34f69acd1a325917b0118c078fd92e390d64e73ba251bc',
                '7bf62a411b55921ec42b81623184880e2fdf71b7e9900ba1254cc2e15844c0c7',
                'd32162df129145d80c983b768e07377deaec93fad6bfab9d78f9d595074cfe74',
                'de9d0ec3f02c768f69904e3a8bd621c111eaae51df7dd5171badd5103f65caba',
                '977d4868e67c4df203782536dff9ab7d3093616539c36796b807a0a3369757b3',
                '30208684e394b6f982e6827ecb1ce884b9a7010c3b0d0709bc83c821e2cc8412',
                '4c27452ecbac890e2c1454b4adbff03ae97fefbe7d48d571aa69eb85f1385590',
                '538ca0858167b990a9482e189954103b54dbefb0288ad813eb89769fe6ac7e33',
              ];
              const observedHashes = new Set([...fallbackControlHashes,
                ...branchStorage.rows.flatMap(row => row.sql ? [row.sql.queryHash] : [])]);
              const originalShapeCoverage = { required: requiredOriginalSqlHashes,
                missing: requiredOriginalSqlHashes.filter(queryHash => !observedHashes.has(queryHash)),
                fallbackControlHashes, branchHashes: [...new Set(branchStorage.rows.flatMap(row => row.sql ? [row.sql.queryHash] : []))] };
              const body = canonicalJson({ kind: 'actual-model-reader-argument-branch-audit', acceptance: 'unmeasured',
                originalEvidenceUnchanged: true, providerCalls: 0, runtimeClosure, scope: measurementScope,
                branchCalls, branchResults, branchStatements, storage: branchStorage, measured: branchMeasured,
                observationWrites: await Promise.all(requiredObservationWrites.map(async ({ queryHash, source }) => ({ queryHash,
                  sourceRef: `source:${fileURLToPath(new URL(source, import.meta.url))}@${digest(await readFile(new URL(source, import.meta.url)))}` }))),
                originalShapeCoverage, fixtureProofQualification });
              if (artifactDirectory) await writeFile(`${recorderRef}.reader-branches.json`, body);
              const saved = await saveImmutableTextArtifact(h, body);
              expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(body);
              expect(branchStorage.diagnostics).toMatchObject({ pending: 0, late: false, captureFailed: false, hooksIntact: true });
              expect(branchStorage.complete).toBe(true);
              expect(originalShapeCoverage.missing).toEqual([]);
              const unknown = branchStorage.rows.filter(row => row.kind === 'unknown');
              expect(unknown).toEqual([]);
              expect(branchMeasured.values.storageBytes).toBeGreaterThan(0);
              expect(branchMeasured.values.modelCalls).toBeNull();
              await recordPhase(`Q2-${iteration}-branches-verified`);
            } finally { branchTap.restore(); }
          }
          continue;
        }
        const { SuTarget } = await import('../../llm-testing/targets/su');
        const dispatch = observeGroundedToolDispatch({ scope: measurementScope, sourceRef: recorderRef,
          attemptId: `${caseId}-pre${iteration}`, boundary: 'consumer', originRef: 'current-source:SuTarget.dispatchOverride',
          registrations: Object.fromEntries(catalogNames.map(name => [name, {
            purpose: ['graph:query', 'plans:get', 'work_items:get'].includes(name) ? 'retrieval' as const : 'other' as const,
            purposeRef: `registered-fixture-dispatch:${name}` }])),
          dispatch: async (tool, args) => {
            resumeDispatches.push({ tool, args: structuredClone(args), blocked: tool === 'release:deploy' });
            // Retain admission and immutable provider references before a
            // handler can fail or the model can lose its process.
            if (artifactDirectory) await writeFile(`${recorderRef}.dispatch.json`, canonicalJson({
              scope: measurementScope, resumeDispatches,
              providers: providerTapes.map(({ id, sha256, artifact }) => ({ id, sha256, artifact })),
            }));
            return modelStoreTap.run(() => fixtureRead(tool, args));
          },
        });
        const contractsBefore = await readContracts(modelSourceFingerprint, `${recorderRef}#contracts-before`);
        const { DBOS } = await import('@dbos-inc/dbos-sdk');
        const originalRunStep = DBOS.runStep.bind(DBOS);
        const durable = observeGroundedDurableHost({ scope: measurementScope, sourceRef: recorderRef,
          attemptId: `${caseId}-pre${iteration}`, host: {
            runStep: <R>(name: string, fn: () => Promise<R>) => originalRunStep(fn, { name }),
          } });
        const stepSpy = vi.spyOn(DBOS, 'runStep').mockImplementation((fn, options) =>
          durable.host.runStep(options?.name ?? 'unnamed', fn));
        const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
        // Canonical fresh context is read after admission; retain the actual
        // projection even when it loses a deep lesson. Never paste the oracle
        // into that projection to make a model choose the expected action.
        let freshContext: unknown = null, question = '';
        let result: TurnResult | undefined, sendFailure: string | null = null;
        const definition = materialized.manifest.cases.find(candidate => candidate.id === caseId)!;
        const stageIds = caseId === 'J1' ? [...definition.input.questions!, ...definition.input.resumeCases!] : [caseId];
        const stages: Array<{ caseId: string; freshContext: unknown; question: string; result: TurnResult | null;
          dispatches: typeof resumeDispatches; sendFailure: string | null; durationMs: number }> = [];
        const controlRequests: Array<{ caseId: string; body: unknown }> = [];
        try {
          for (const stageId of stageIds) {
            const stageStart = performance.now(), dispatchStart = resumeDispatches.length;
            ({ freshContext, question } = await modelStoreTap.run(() => readCurrentContext(stageId)));
            let controlRound = 0;
            // Exercise the production transport/dispatch seams without a
            // provider. Scripted output is never admitted as model usage or
            // positive proof. Each resumed stage opens a fresh context.
            const controlFetch: typeof fetch = async (_request, options) => {
              controlRequests.push({ caseId: stageId, body: JSON.parse(String(options?.body)) });
              const call = stageId === 'Q1'
                ? { name: 'graph__query', args: { op: 'evidence', plan: p, item: 'P-001', harnesses: [h] } }
                : stageId === 'C1'
                  ? iteration === 2 ? { name: 'release__deploy', args: { op: 'status' } }
                    : { name: 'plans__get', args: { slug: p, harness: h, heading: 'History' } }
                  : { name: 'work_items__get', args: { id: iteration === 3 ? item : unrelated, harness: h } };
              const output = controlRound++ === 0
                ? [{ type: 'function_call', id: `fc-${stageId}`, call_id: `call-${stageId}`,
                  name: call.name, arguments: JSON.stringify(call.args) }]
                : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: canonicalJson({
                  decision: seed.proof.recordedDecision, implementation: seed.proof.implementationAnchor,
                  proof: `test-run:${proofRun.id}`, evidenceRefs: [],
                }) }] }];
              return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\ndata: [DONE]\n\n`,
                { headers: { 'content-type': 'text/event-stream' } });
            };
            const session = await new SuTarget({ catalog, codexFetch: journeyControl ? controlFetch : observed.fetch,
              loadSystemPrompt: () => 'Answer engineering questions using current scoped evidence. Current canonical context outranks an older carry note. Read before making evidence claims. Keep missing proof explicit.',
            }).open({ runId: `${measurementScope.runId}:${stageId}`, sutModel: model,
              workspaceMode: 'isolated', transport: 'in-process',
              dispatchOverride: { override: async (tool, args) => ({ content: [{ type: 'text',
                text: JSON.stringify(await dispatch.dispatch(tool, args)) }] }) },
            });
            result = undefined;
            let stageFailure: string | null = null;
            try { result = await session.send({ trigger: 'user_message', messages: [{ role: 'user', content: question }] }); }
            catch (error) { stageFailure = String(error); sendFailure ??= stageFailure; }
            finally { await session.close(); }
            stages.push({ caseId: stageId, freshContext, question, result: result ?? null,
              dispatches: resumeDispatches.slice(dispatchStart), sendFailure: stageFailure,
              durationMs: performance.now() - stageStart });
            await recordPhase(`${caseId}-${iteration}-${stageId}-transport-settled`);
          }
        }
        catch (error) { sendFailure = String(error); }
        finally {
          try { await observed.drain(); }
          finally { stepSpy.mockRestore(); }
        }
        const contractsAfter = await readContracts(modelSourceFingerprint, `${recorderRef}#contracts-after`);
        const contractCapture = captureGroundedContractChanges({ scope: measurementScope, sourceRef: recorderRef,
          before: contractsBefore, after: contractsAfter });
        const input = { scope: measurementScope,
          boundary: { scope: measurementScope, sourceRef: recorderRef, admittedAt, settledAt: new Date().toISOString(),
            monotonicStartMs, monotonicEndMs: performance.now(), drained: true },
          models: journeyControl ? undefined : observed.seal(), invocations: dispatch.seal(),
          storage: modelStoreTap.seal(),
          durable: durable.seal(), contracts: contractCapture.census };
        const measured = measureGroundedEvidence(input);
        const ids = journeyControl ? [] : await recordRubricCheckResults(measured.ledgerResults,
          { workspaceId: workspace, harnessSlug: h, runGroupId: measurementScope.runId }, admin);
        const ledgerRows = await admin`SELECT id,status,execution_details FROM harness_shared.test_runs
          WHERE workspace_id=${workspace} AND id=ANY(${ids}) ORDER BY id`;
        const expected = materialized.manifest.cases.find(candidate => candidate.id === caseId)?.expected;
        const nextDispatch = resumeDispatches[0] ?? null;
        // The question oracle reads the final machine record, independently of
        // the product's graph. Keep a wrong answer as a completed baseline;
        // recorder integrity and product correctness are separate verdicts.
        let questionAnswer: Record<string, unknown> | null = null;
        let questionParseError: string | null = null;
        if (['Q2', 'Q3'].includes(caseId)) {
          try {
            const text = result?.assistantText.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '') ?? '';
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('question answer must be an object');
            questionAnswer = parsed as Record<string, unknown>;
          } catch (error) { questionParseError = String(error); }
        }
        const shipmentExpected = (shipmentCase.expected as Record<string, unknown>)[shipmentMutation];
        const shipmentExpectedRecord = typeof shipmentExpected === 'string'
          ? { shipment: shipmentExpected.replace('shipment ', '') }
          : { shipment: 'supported', deployment: materialized.mapping[seed.proof.deploymentReceipt],
            supportedArtifact: targetArtifact };
        const questionOracle = caseId === 'Q2' ? { expected: shipmentExpected,
          expectedRecord: shipmentExpectedRecord, answer: questionAnswer, parseError: questionParseError,
          passed: questionParseError === null && Object.entries(shipmentExpectedRecord)
            .every(([key, value]) => questionAnswer?.[key] === value),
        } : caseId === 'Q3' ? { expected, answer: questionAnswer, parseError: questionParseError,
          passed: questionParseError === null
            && canonicalJson(questionAnswer?.events ?? null) === canonicalJson(expected?.events)
            && canonicalJson(questionAnswer?.olderBindingAuthority ?? null) === canonicalJson(expected?.olderBindingAuthority),
        } : null;
        const actionOracle = ['J1', 'Q2', 'Q3'].includes(caseId) ? null : {
          expected, nextDispatch,
          passed: caseId === 'C1'
            ? nextDispatch?.tool === 'plans:get' && (nextDispatch.args as Record<string, unknown>).slug === p
              && (nextDispatch.args as Record<string, unknown>).heading === 'History'
              && !resumeDispatches.some(call => call.tool === 'release:deploy')
            : caseId === 'C4' ? nextDispatch?.tool === 'testing:run'
              && canonicalJson((nextDispatch.args as Record<string, unknown>).files) === canonicalJson([verificationFile])
              && !resumeDispatches.some(call => call.tool === 'work_items:complete')
            : nextDispatch?.tool === 'work_items:get' && (nextDispatch.args as Record<string, unknown>).id === unrelated
              && !resumeDispatches.some(call => call.tool === 'work_items:get'
                && (call.args as Record<string, unknown>).id === item),
        };
        const journeyOracles = caseId === 'J1' ? stages.map(stage => {
          const first = stage.dispatches[0], args = first?.args as Record<string, unknown> | undefined;
          const completed = stage.sendFailure === null && stage.result?.finishReason === 'done';
          const withinDeadline = stage.durationMs <= Number(definition.expected!.eachReadOrResumeMaxMs);
          if (stage.caseId === 'Q1') {
            let answer: Record<string, unknown> | null = null, parseError: string | null = null;
            try { answer = JSON.parse(stage.result?.assistantText.trim()
              .replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '') ?? '') as Record<string, unknown>; }
            catch (error) { parseError = String(error); }
            const answerMatchesExpected = parseError === null && answer?.decision === seed.proof.recordedDecision
              && answer?.implementation === seed.proof.implementationAnchor && answer?.proof === `test-run:${proofRun.id}`;
            const proofQualified = fixtureProofQualification.cases.length > 0
              && fixtureProofQualification.execution?.gaps.length === 0;
            return { caseId: stage.caseId, answer, parseError, answerMatchesExpected, proofQualified,
              completed, withinDeadline, passed: completed && withinDeadline && answerMatchesExpected && proofQualified };
          }
          return { caseId: stage.caseId, nextDispatch: first ?? null, completed, withinDeadline,
            passed: completed && withinDeadline && (stage.caseId === 'C1'
              ? first?.tool === 'plans:get' && args?.slug === p && args?.harness === h && args?.heading === 'History'
                && !stage.dispatches.some(call => call.tool === 'release:deploy')
              : first?.tool === 'work_items:get' && args?.id === unrelated && args?.harness === h
                && !stage.dispatches.some(call => call.tool === 'work_items:get'
                  && (call.args as Record<string, unknown>).id === item)) };
        }) : null;
        const journey = journeyOracles && { stageIds, stages, oracles: journeyOracles,
          nextActionSelectedBy: journeyControl ? 'scripted-transport-control' : 'model',
          passed: stages.length === stageIds.length && journeyOracles.every(oracle => oracle.passed) };
        const tape = canonicalJson({ kind: 'current-source-model-question-capture', acceptance: 'unmeasured',
          limitation: 'Current-source subjourney only; resume storage closure, UI and serving-runtime qualification remain unmeasured.',
          freshContext, resumeDispatches, actionOracle, questionOracle, journey, journeyControl, controlRequests,
          runtimeClosure, modelStatements,
          shipmentMutation: caseId === 'Q2' ? shipmentMutation : null, fixtureState,
          fixtureRef: retained, modelSourceHashes, question, catalog: catalogSnapshot, model, routes, providerTapes,
          contractsBefore, contractsAfter, contractCapture, input, result: result ?? null, sendFailure, measured, ledgerRows });
        const saved = await saveImmutableTextArtifact(h, tape);
        expect(await loadImmutableTextArtifact(h, saved.sha256)).toBe(tape);
        if (artifactDirectory) {
          await writeFile(recorderRef, tape);
          expect(await readFile(recorderRef, 'utf8')).toBe(tape);
        }
        // Assert capture integrity after retaining failed/partial originals too.
        captureAssertions.push(() => {
          expect(sendFailure).toBeNull();
          expect(stages.map(stage => stage.caseId)).toEqual(stageIds);
          for (const stage of stages) {
            expect(stage.result?.finishReason, stage.result?.error).toBe('done');
            expect(stage.result?.toolCalls.length).toBeGreaterThan(0);
            expect(stage.dispatches.map(call => call.tool)).toEqual(stage.result?.toolCalls.map(call => call.name));
          }
          if (journeyControl) {
            expect(stageIds).toEqual(['Q1', 'C1', 'C2']);
            expect(controlRequests.map(request => request.caseId)).toEqual(['Q1', 'Q1', 'C1', 'C1', 'C2', 'C2']);
            // A fresh resumed session must not inherit an earlier assistant
            // answer or tool result. Its canonical context is read again.
            for (const index of [0, 2, 4]) {
              const body = controlRequests[index].body as { input: Array<{ role?: string; type?: string }> };
              expect(body.input.some(entry => entry.role === 'assistant' || entry.type === 'function_call_output')).toBe(false);
            }
            expect(journeyOracles?.map(oracle => oracle.passed)).toEqual([false, iteration !== 2, iteration !== 3]);
            expect(journeyOracles?.[0]).toMatchObject({ answerMatchesExpected: true, proofQualified: false });
            expect(journey?.passed).toBe(false);
            expect(providerTapes).toEqual([]);
            expect(routes).toEqual([]);
            expect(measured.values.modelCalls).toBeNull();
            expect(measured.complete).toBe(false);
            expect(input.storage.complete).toBe(true);
            expect(measured.values.storageBytes).not.toBeNull();
            expect(contractCapture.gaps).toEqual([]);
            expect(ledgerRows).toEqual([]);
            return;
          }
          expect(measured.values.modelCalls).toBeGreaterThan(0);
          expect(measured.values.modelInputTokens).toBeGreaterThan(0);
          expect(measured.values.modelOutputTokens).toBeGreaterThan(0);
          expect(contractCapture.gaps).toEqual([]);
          expect(measured.values).toMatchObject({ extractionCalls: 0, refreshCalls: 0, agentAuthoringCalls: 0,
            durableSteps: 0, newMandatoryFields: 0, newMandatoryNarrativeSurfaces: 0 });
          expect(input.storage.complete).toBe(true);
          expect(measured.values.storageBytes).not.toBeNull();
          expect(measured.complete).toBe(true);
        });
        } finally {
          modelStoreTap.restore();
        }
      }
      }
      for (const assertCapture of captureAssertions) assertCapture();
      } finally {
        __setCachedReadEnabledForTests(false);
        resetOperatorCacheForTests();
        resetCachedReadStatsForTests();
      }
    }
    await recordPhase('complete');
  };

  it('materializes frozen B history stores and retains the exact map before any consumer arm',
    () => runFrozenHistory(false), process.env.PAPERCUSP_TEST_GEC_MODEL === '1'
    ? 90_000 + 3 * 240_000 * (process.env.PAPERCUSP_TEST_GEC_MODEL_CASES ?? 'J1')
      .split(',').length
    : 90_000);

  it('GEC.Q2 reader branches preflight', () => runFrozenHistory(true), 90_000);

  it('GEC.J1 composed reader preflight', () => runFrozenHistory(false, true), 90_000);

  it('GEC.J1 composed SuTarget transport control', () => runFrozenHistory(false, false, 'J1'), 90_000);

  it.each(['J2', 'J3'] as const)('GEC.%s composed DBOS transport control',
    journey => runFrozenHistory(false, false, journey), 400_000);

  it.each(['J2', 'J3'] as const)('GEC.%s composed observed transport regression',
    journey => runFrozenHistory(false, false, false, journey), 400_000);

  it.each((['success', 'failure', 'unknown'] as const).flatMap(state =>
    [false, true].map(archived => [state, archived] as const)))(
    'persists immutable atomic baseline states and rejects substituted, missing, duplicate and foreign observations (%s, archived=%s)',
    async (state, archived) => {
    // Deliberate truth-table controls, never original model observations.
    const fixture = materializeGroundedFixture('atomic-pg-control').manifest;
    const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    const c = fixture.cases.find(candidate => candidate.id === 'C3')!;
    const pin: GroundedBaselinePin = {
      scope: { workspaceId: fx.workspaceId, potId: 'gec-b-atomic-control', harness: HARNESS,
        runId: `gec-atomic-control-${RUN}`, ownerId: 'su-gec-atomic-control', caseId: 'C3', arm: 'pre', iteration: 1,
        manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'isolated-control', sourceFingerprint: 'control-source',
        testFingerprint: 'control-test', runtimeFingerprint: 'private-pg-control', configFingerprint: 'control-config' },
      cohort: 'original', generation: 'pre-intervention', version: 'control-version', sourceClock: 'control-clock',
      observedAt: '2026-11-12T00:00:00Z', budgetHash: digest(fixture.budgets), oracleHash: digest(c.expected),
    };
    const ids: number[] = [];
    const read = async (keys: number[]) => (await admin`
      SELECT id, status, execution_details FROM harness_shared.test_runs
       WHERE workspace_id = ${fx.workspaceId} AND id = ANY(${keys}) ORDER BY id
    ` as unknown as Array<{ id: number; status: string; execution_details: unknown }>).map(row => ({
      id: Number(row.id), status: row.status, executionDetails: row.execution_details,
    }));
    try {
        const originalPin = archived ? { ...pin, scope: { ...pin.scope, workspaceId: 'historical-fixture-workspace',
          harness: 'historical-fixture-harness', runId: 'historical-original-run' } } : pin;
        const ledgerScope = { workspaceId: fx.workspaceId, harnessSlug: HARNESS, runGroupId: pin.scope.runId };
        const observations: GroundedBaselineObservation[] = groundedBaselineCensus()
          .filter(key => key.caseId === 'C3' && key.iteration === 1)
          .map(key => ({ kind: key.kind, name: key.name, value: key.kind === 'dimension' ? 0
            : state === 'unknown' ? null : state === 'success', qualified: true,
          evidenceRef: 'isolated-control:original', writerRef: 'integration:truth-table' }));
        const body = canonicalJson({ schemaVersion: 'grounded-baseline-observations-v1', pin: originalPin, observations });
        const input = { pin: originalPin, original: { body, sha256: createHash('sha256').update(body).digest('hex') } };
        const classified = classifyGroundedBaseline(input);
        expect(classified.state).toBe(state);
        const written = await recordRubricCheckResults(classified.ledgerResults,
          ledgerScope, admin);
        ids.push(...written);
        const rows = await read(written);
        expect(rows).toHaveLength(classified.rows.length);
        expect(readGroundedBaselineRows(input, rows, ledgerScope).integrity).toBe(true);
        expect(readGroundedBaselineRows(input, rows).integrity).toBe(!archived);
        const details = parseTestRunExecutionDetails(rows[0]!.executionDetails)!;
        expect(JSON.parse(details.check!.provenance!.procedure.snapshot!).row.pin.scope).toEqual(originalPin.scope);
        for (const key of ['workspaceId', 'harnessSlug', 'runGroupId'] as const) {
          const changed = structuredClone(rows);
          Object.assign(changed[0]!.executionDetails as object, { [key]: 'foreign' });
          expect(readGroundedBaselineRows(input, changed, ledgerScope).integrity).toBe(false);
        }
        for (const other of ['success', 'failure', 'unknown'] as const) if (other !== state) {
          const changed = parseTestRunExecutionDetails(rows[0]!.executionDetails)!;
          changed.check!.value = other === 'unknown' ? null : other === 'success';
          const status = other === 'success' ? 'pass' : other === 'failure' ? 'fail' : 'error';
          await admin`UPDATE harness_shared.test_runs SET status = ${status},
            execution_details = ${JSON.stringify(changed)}::jsonb WHERE id = ${rows[0]!.id}`;
          expect(readGroundedBaselineRows(input, await read(written), ledgerScope).integrity).toBe(false);
        }
        for (const population of [[], rows.slice(1), [...rows, rows[0]!]])
          expect(readGroundedBaselineRows(input, population, ledgerScope).integrity).toBe(false);
        for (const key of ['sourceFingerprint', 'runtimeFingerprint', 'configFingerprint', 'testFingerprint',
          'manifestHash', 'fixtureHash', 'runId'] as const) {
          const changed = structuredClone(input); changed.pin.scope[key] = 'substituted';
          expect(readGroundedBaselineRows(changed, rows, ledgerScope).integrity).toBe(false);
        }
        for (const key of ['version', 'budgetHash', 'oracleHash', 'sourceClock', 'observedAt', 'generation', 'cohort'] as const) {
          const changed = structuredClone(input); Object.assign(changed.pin, { [key]: 'substituted' });
          expect(readGroundedBaselineRows(changed, rows, ledgerScope).integrity).toBe(false);
        }
    } finally {
      await admin`DELETE FROM harness_shared.test_runs WHERE workspace_id = ${fx.workspaceId} AND id = ANY(${ids})`;
    }
  });

  it('persists recorder controls to the existing ledger and rejects every missing dimension and foreign run', async () => {
    // These are isolated recorder controls, NOT paired product baselines or a
    // live journey. The unknown control below deliberately measures a real
    // consumer without claiming capture at boundaries it did not instrument.
    const scope: GroundedMeasurementScope = {
      workspaceId: fx.workspaceId, potId: 'gec-b-recorder-control', harness: HARNESS,
      runId: `gec-recorder-control-${RUN}`, ownerId: 'su-gec-recorder-control', caseId: 'N7', arm: 'pre', iteration: 1,
      manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'gec-b-recorder-control', sourceFingerprint: 'recorder-control-source',
      testFingerprint: 'recorder-control-test', runtimeFingerprint: 'isolated-pg-control', configFingerprint: 'unit-control',
    };
    const census = { scope, sourceRef: 'isolated-recorder-control:armed-empty', complete: true, ids: [], rows: [] };
    const admittedAt = new Date().toISOString(), monotonicStartMs = performance.now();
    const consumer = await readPlanHistoryContext(PLAN, HARNESS);
    expect(consumer.recovery.args).toEqual({ slug: PLAN, harness: HARNESS, heading: 'History' });
    expect(consumer.brief?.target.ref).toBe(PLAN);
    const boundary = { scope, sourceRef: 'isolated-consumer:plan-history', admittedAt,
      settledAt: new Date().toISOString(), monotonicStartMs, monotonicEndMs: performance.now(), drained: true };
    const control = measureGroundedEvidence({ scope, boundary,
      models: census, invocations: census, durable: census, storage: census, contracts: census });
    // Pre-write guard for the measured BIGINT metadata failure class. The
    // actual latency scalar keeps its fractional monotonic milliseconds.
    expect(control.ledgerResults.every(row => Number.isSafeInteger(row.durationMs))).toBe(true);
    const ledgerScope = { workspaceId: fx.workspaceId, harnessSlug: HARNESS, runGroupId: scope.runId };
    const ids = await recordRubricCheckResults(control.ledgerResults, ledgerScope, admin);
    const read = async (keys: number[]) => (await admin`
      SELECT id, status, execution_details FROM harness_shared.test_runs
       WHERE workspace_id = ${fx.workspaceId} AND run_group_id = ${scope.runId} AND id = ANY(${keys})
       ORDER BY id
    ` as unknown as Array<{ id: number; status: string; execution_details: unknown }>).map(row => ({
      id: Number(row.id), status: row.status, executionDetails: row.execution_details,
    }));
    try {
      const rows = await read(ids);
      expect(rows).toHaveLength(21);
      expect(readGroundedMeasurementRows(scope, rows).complete).toBe(true);
      for (const row of rows) {
        const incomplete = readGroundedMeasurementRows(scope, rows.filter(candidate => candidate.id !== row.id));
        expect(incomplete.complete).toBe(false);
        expect(incomplete.gaps).toHaveLength(1);
      }
      expect(readGroundedMeasurementRows({ ...scope, runId: 'foreign-run' }, rows).complete).toBe(false);
      const uncaptured = measureGroundedEvidence({ scope, boundary });
      const unknownIds = await recordRubricCheckResults(uncaptured.ledgerResults, ledgerScope, admin);
      ids.push(...unknownIds);
      const unknownRows = await read(unknownIds);
      expect(unknownRows.filter(row => row.status === 'error')).toHaveLength(20);
      const actual = readGroundedMeasurementRows(scope, unknownRows);
      expect(actual.complete).toBe(false);
      expect(actual.values.storageOperations).toBeNull();
      expect(actual.values.modelInputTokens).toBeNull();
      expect(actual.values.endToEndMs).toBeGreaterThanOrEqual(0);
      // An older complete capture must not hide newer missing capture.
      expect(readGroundedMeasurementRows(scope, [...rows, ...unknownRows]).complete).toBe(false);
    } finally {
      await admin`DELETE FROM harness_shared.test_runs WHERE workspace_id = ${fx.workspaceId} AND id = ANY(${ids})`;
    }
  });
});
