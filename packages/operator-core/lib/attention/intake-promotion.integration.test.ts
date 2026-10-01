/**
 * observation-candidate-acceptance-promotion-2026-09-30 P-006 (D-013/D-014) —
 * executing a recorded intake decision against a fully migrated Postgres.
 *
 * The acceptance bar (WI-10004569): concurrent accepts, retries, stale source
 * edits and partial failures never produce duplicate work or a false ready
 * receipt. Every case drives the REAL default dependencies (createIssue,
 * mergeIssuePayload, linkIssue, setIssueState, the advisory-lock transaction);
 * partial failures are injected by overriding exactly one dependency.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { createIssue, getIssue, issuesOutLinksMany } = await import('../issues-engineer');
const {
  assertIntakeLockPool,
  currentIntakeSourceRevision,
  defaultIntakePromotionDeps,
  executeIntakeDecision,
  intakePromotionKey,
  isPromotionKeyConflict,
  readIntakeDispositionState,
  readIntakePromotionReceipt,
} = await import('./intake-promotion');
const { parseIntakeDecision } = await import('./bulk-dispositions');
const { createImplementationReadiness, evaluateImplementationAcceptance, readImplementationReadiness } = await import(
  '../harness/improvements/agent-review-policy'
);
const { recordIssueOccurrence } = await import('../issue-occurrence-ledger');

type Decision = import('./bulk-dispositions').BulkIntakeDecision;
type DecisionInput = import('./bulk-dispositions').BulkIntakeDecisionInput;
type Deps = import('./intake-promotion').IntakePromotionDeps;

let db: OrgTestDb;

beforeAll(async () => {
  // Sized like the pool getOrgPg() itself gets in a vitest worker (VITEST_ORG_POOL_MAX),
  // per the rig's D-024 note: the double-accept cases run a lock holder, its writer and
  // a waiter at once, so the default 2-connection admin pool, not the executor, would
  // decide whether they can make progress.
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const FILER = 'su-filer';
const REVIEWER = 'su-reviewer';
const FULL_ACCEPTANCE = {
  problem: 'the gate reports green while a leg never ran',
  evidence: ['run 4512 output shows zero files collected'],
  outcome: 'a zero-collection leg is reported as unmeasured',
  scope: 'green-checkpoint leg aggregation only',
  completionCheck: 'a leg with zero collected files yields status=unmeasured in the gate verdict',
};

function tag(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function file(opts: {
  kind?: 'bug' | 'change' | 'task';
  observation?: boolean;
  createdBy?: string;
  outcome?: string;
}) {
  const t = tag();
  const payload: Record<string, unknown> = {};
  if (opts.observation) payload.lane = 'observation';
  if (opts.outcome) {
    payload.implementationReadiness = createImplementationReadiness({
      status: 'unknown',
      source: 'creation-enrollment',
      reason: 'test-proposal',
      updatedAt: new Date().toISOString(),
      evidence: { acceptance: { outcome: opts.outcome } },
    });
  }
  return createIssue({
    kind: opts.kind ?? 'bug',
    title: `intake source ${t}`,
    body: `observed behaviour ${t}`,
    scope: 'harness:papercusp',
    createdBy: opts.createdBy ?? FILER,
    payload,
  });
}

/** Record a decision exactly as the report path does: bound to the revision judged now. */
async function decide(sourceId: string, input: DecisionInput, decidedBy = REVIEWER): Promise<Decision> {
  const sourceRevision = await currentIntakeSourceRevision(sourceId);
  const parsed = parseIntakeDecision(input, { decidedBy, sourceRevision });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.decision;
}

function exec(sourceId: string, decision: Decision, deps?: Deps, runId = 'run-p006') {
  return executeIntakeDecision({ sourceId, decision, runId, itemId: `att-${sourceId}` }, deps);
}

async function promotedFrom(sourceId: string): Promise<string[]> {
  const rows = await db.adminSql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE payload -> 'intakeSource' ->> 'id' = ${sourceId}
       AND feature_id <> ${sourceId}`;
  return rows.map((r) => r.feature_id);
}

async function outLinks(id: string): Promise<string[]> {
  const links = (await issuesOutLinksMany([id])).get(id) ?? [];
  return links.map((l) => `${l.rel}:${l.dst.ref}`);
}

async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const issue = await getIssue(id);
  return (issue?.payload ?? {}) as Record<string, unknown>;
}

async function isReadyAndQualifying(id: string): Promise<boolean> {
  const issue = await getIssue(id);
  if (!issue) return false;
  const readiness = readImplementationReadiness(issue.payload);
  const verdict = evaluateImplementationAcceptance(issue.payload, {
    kind: issue.kind,
    title: issue.title,
    summary: issue.body ?? '',
  });
  return readiness?.status === 'ready' && verdict.state === 'qualifying';
}

describe('promote / investigate', () => {
  it('a double accept of an observation yields exactly one distinct ready item, and a retry converges on it', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, {
      disposition: 'promote',
      reason: 'reproduced twice',
      workKind: 'fix',
      acceptance: FULL_ACCEPTANCE,
    });

    const [a, b] = await Promise.all([exec(obs.id, decision), exec(obs.id, decision)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.workItemId).toBe(b.workItemId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect([a.converged, b.converged].sort()).toEqual([false, true]);
    expect(a.mode).toBe('distinct');

    const promotedId = a.workItemId!;
    expect(await promotedFrom(obs.id)).toEqual([promotedId]);
    const promoted = await getIssue(promotedId);
    expect(promoted?.kind).toBe('bug');
    expect(await isReadyAndQualifying(promotedId)).toBe(true);
    expect(readIntakePromotionReceipt(promoted?.payload)).toMatchObject({
      key: intakePromotionKey(obs.id, decision.sourceRevision!),
      mode: 'distinct',
      decidedBy: REVIEWER,
    });

    // The observation is evidence: retained, still an observation, pointing at its work.
    const source = await getIssue(obs.id);
    expect(source?.state).toBe(obs.state);
    expect((source?.payload as Record<string, unknown>).lane).toBe('observation');
    expect((source?.payload as Record<string, unknown>).intakeExecution).toMatchObject({ workItemId: promotedId });
    expect(await outLinks(promotedId)).toContain(`promoted-from:${obs.id}`);
    expect(await outLinks(obs.id)).toContain(`promoted-to:${promotedId}`);

    const retry = await exec(obs.id, decision);
    expect(retry).toMatchObject({ ok: true, workItemId: promotedId, created: false, converged: true });
    expect(await promotedFrom(obs.id)).toEqual([promotedId]);
  });

  it('promotes a same-kind candidate in place: it keeps its id, becomes sealed and ready, and re-execution converges', async () => {
    const cand = await file({ kind: 'bug' });
    expect(readImplementationReadiness(cand.payload)?.status).toBe('unknown');
    const decision = await decide(cand.id, { disposition: 'promote', reason: 'real', acceptance: FULL_ACCEPTANCE });

    const first = await exec(cand.id, decision);
    expect(first).toMatchObject({ ok: true, workItemId: cand.id, created: false, converged: false, mode: 'in-place' });
    expect(await isReadyAndQualifying(cand.id)).toBe(true);
    expect(await promotedFrom(cand.id)).toEqual([]);

    const again = await exec(cand.id, decision);
    expect(again).toMatchObject({ ok: true, workItemId: cand.id, converged: true, mode: 'in-place' });
  });

  it('investigate turns a bug candidate into a distinct ready task and leaves the candidate in place', async () => {
    const cand = await file({ kind: 'bug' });
    const decision = await decide(cand.id, {
      disposition: 'investigate',
      reason: 'cause unknown',
      acceptance: FULL_ACCEPTANCE,
    });
    const result = await exec(cand.id, decision);
    expect(result).toMatchObject({ ok: true, outcome: 'promoted', created: true, mode: 'distinct' });
    if (!result.ok) return;
    expect((await getIssue(result.workItemId!))?.kind).toBe('task');
    expect(await isReadyAndQualifying(result.workItemId!)).toBe(true);
    expect((await getIssue(cand.id))?.state).toBe(cand.state);
  });
});

describe('the promotion key is fenced by the database, not only by the lock', () => {
  // Migration 1298's partial unique index is what makes "exactly one promoted item"
  // hold even for a writer that never reaches the advisory lock (a different client,
  // an overlapping run, a retry racing a slow first attempt).
  it('two executors that bypass the advisory lock still yield exactly one promoted item', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, {
      disposition: 'promote',
      reason: 'fence probe',
      workKind: 'fix',
      acceptance: FULL_ACCEPTANCE,
    });
    const unlocked: Deps = { ...defaultIntakePromotionDeps(), withLocks: (_ids, fn) => fn() };

    const [a, b] = await Promise.all([exec(obs.id, decision, unlocked), exec(obs.id, decision, unlocked)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.workItemId).toBe(b.workItemId);
    expect(await promotedFrom(obs.id)).toEqual([a.workItemId]);
    expect(await isReadyAndQualifying(a.workItemId!)).toBe(true);
  });

  it('control: with every application-level lookup blinded, only the unique index stops a second promoted row', async () => {
    // Deterministic, unlike the race above: the second execution cannot see the first
    // one's row through any dependency, so it reaches createItem and only the database
    // can refuse it. Without migration 1298 this test creates a duplicate and fails.
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, { disposition: 'promote', reason: 'fence control', acceptance: FULL_ACCEPTANCE });
    const blind: Deps = {
      ...defaultIntakePromotionDeps(),
      withLocks: (_ids, fn) => fn(),
      findByPromotionKey: async () => null,
      findPromotedFromSource: async () => [],
    };
    const first = await exec(obs.id, decision, blind);
    expect(first).toMatchObject({ ok: true, created: true });
    const second = await exec(obs.id, decision, blind).then(
      () => null,
      (err: unknown) => err,
    );
    expect(isPromotionKeyConflict(second)).toBe(true);
    expect(await promotedFrom(obs.id)).toHaveLength(1);
  });

  it('a second row carrying the same promotion key is refused as a promotion-key conflict', async () => {
    const t = tag();
    const payload = { intakePromotion: { key: `intake-exec:fence-${t}:rev` } };
    const base = { kind: 'task' as const, body: 'fence', scope: 'harness:papercusp', createdBy: FILER, payload };
    await createIssue({ ...base, title: `fence first ${t}` });
    const err = await createIssue({ ...base, title: `fence second ${t}` }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(isPromotionKeyConflict(err)).toBe(true);
    expect(isPromotionKeyConflict(new Error('unrelated failure'))).toBe(false);
  });

  it('refuses a one-connection pool instead of letting the lock holder wait forever for its own writers', () => {
    expect(() => assertIntakeLockPool({ options: { max: 1 } })).toThrow(/at least 2 connections/);
    expect(() => assertIntakeLockPool({ options: { max: 2 } })).not.toThrow();
    expect(() => assertIntakeLockPool(db.adminSql)).not.toThrow();
  });
});

describe('refusals write nothing', () => {
  it('a source edited after the decision is refused, and no ready receipt appears anywhere', async () => {
    for (const observation of [false, true]) {
      const src = await file({ observation });
      const decision = await decide(src.id, { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE });
      await db.adminSql`
        UPDATE harness_shared.work_items SET summary = summary || ' (edited after review)'
         WHERE feature_id = ${src.id}`;
      const result = await exec(src.id, decision);
      expect(result).toMatchObject({ ok: false, refusal: 'source-revision-changed' });
      const payload = await payloadOf(src.id);
      expect(payload.intakePromotion).toBeUndefined();
      expect(readImplementationReadiness(payload)?.status ?? null).not.toBe('ready');
      expect(await promotedFrom(src.id)).toEqual([]);
    }
  });

  it('refuses an unjudged revision, self-review and an incomplete contract without writing', async () => {
    const cand = await file({ kind: 'bug' });
    const unjudged = parseIntakeDecision(
      { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE },
      { decidedBy: REVIEWER },
    );
    if (!unjudged.ok) throw new Error(unjudged.error);
    expect(await exec(cand.id, unjudged.decision)).toMatchObject({ ok: false, refusal: 'source-revision-unjudged' });

    const selfReview = await decide(cand.id, { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE }, FILER);
    expect(await exec(cand.id, selfReview)).toMatchObject({ ok: false, refusal: 'acceptance-invalid-authority' });

    const incomplete = await decide(cand.id, { disposition: 'promote', reason: 'r', acceptance: { problem: 'p' } });
    const refused = await exec(cand.id, incomplete);
    expect(refused).toMatchObject({ ok: false, refusal: 'acceptance-incomplete' });
    expect(refused.ok ? [] : refused.missing).toEqual(
      expect.arrayContaining(['evidence', 'outcome', 'scope', 'completionCheck']),
    );

    const retry = await decide(cand.id, { disposition: 'retry', reason: 'unclear', missingInformation: 'a repro' });
    expect(await exec(cand.id, retry)).toMatchObject({ ok: false, refusal: 'retry-not-executable' });

    const payload = await payloadOf(cand.id);
    expect(payload.intakePromotion).toBeUndefined();
    expect(readImplementationReadiness(payload)?.status).toBe('unknown');
  });
});

describe('partial failures', () => {
  it('a failed insert leaves nothing; a failed link after the insert converges on retry without a duplicate', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, { disposition: 'promote', reason: 'r', acceptance: FULL_ACCEPTANCE });
    const real = defaultIntakePromotionDeps();

    await expect(
      exec(obs.id, decision, {
        ...real,
        createItem: async () => {
          throw new Error('injected insert failure');
        },
      }),
    ).rejects.toThrow('injected insert failure');
    expect(await promotedFrom(obs.id)).toEqual([]);
    expect((await payloadOf(obs.id)).intakeExecution).toBeUndefined();

    await expect(
      exec(obs.id, decision, {
        ...real,
        link: async () => {
          throw new Error('injected link failure');
        },
      }),
    ).rejects.toThrow('injected link failure');
    // The insert committed WITH its own receipt and contract (one write), so the
    // ready verdict it carries is true; only the graph edges and pointer are owed.
    const [orphan] = await promotedFrom(obs.id);
    expect(orphan).toBeDefined();
    expect(await isReadyAndQualifying(orphan)).toBe(true);
    expect((await payloadOf(obs.id)).intakeExecution).toBeUndefined();

    const recovered = await exec(obs.id, decision);
    expect(recovered).toMatchObject({ ok: true, workItemId: orphan, created: false, converged: true });
    expect(await promotedFrom(obs.id)).toEqual([orphan]);
    expect((await payloadOf(obs.id)).intakeExecution).toMatchObject({ workItemId: orphan });
    expect(await outLinks(orphan)).toContain(`promoted-from:${obs.id}`);
    expect(await outLinks(obs.id)).toContain(`promoted-to:${orphan}`);
  });
});

describe('merge', () => {
  it('appends evidence with bidirectional links; a duplicate candidate closes, a distinct remedy and an observation stay', async () => {
    const target = await file({ kind: 'bug', outcome: 'retry the flaky leg' });
    const duplicate = await file({ kind: 'bug', outcome: 'Retry  the flaky leg' });
    const distinct = await file({ kind: 'bug', outcome: 'quarantine the leg instead' });
    const obs = await file({ observation: true });

    const results = [];
    for (const src of [duplicate, distinct, obs]) {
      const decision = await decide(src.id, { disposition: 'merge', reason: 'same cause', targetRef: target.id });
      results.push(await exec(src.id, decision));
      // Re-execution converges and appends nothing twice.
      expect(await exec(src.id, decision)).toMatchObject({ ok: true, converged: true, workItemId: target.id });
      expect(await outLinks(src.id)).toContain(`merged-into:${target.id}`);
      expect(await outLinks(target.id)).toContain(`merged-from:${src.id}`);
    }
    expect(results.map((r) => r.ok && r.distinctRemedy)).toEqual([false, true, false]);

    expect((await getIssue(duplicate.id))?.state).toBe('dropped');
    expect((await getIssue(distinct.id))?.state).toBe(distinct.state);
    expect((await getIssue(obs.id))?.state).toBe(obs.state);

    const merged = (await payloadOf(target.id)).intakeMergedSources as { sourceId: string }[];
    expect(merged.map((m) => m.sourceId)).toEqual([duplicate.id, distinct.id, obs.id]);

    const elsewhere = await file({ kind: 'bug' });
    const again = await decide(distinct.id, { disposition: 'merge', reason: 'moved', targetRef: elsewhere.id });
    expect(await exec(distinct.id, again)).toMatchObject({ ok: false, refusal: 'already-merged-elsewhere' });
  });
});

describe('retain / reject', () => {
  it('records an occurrence watermark, deletes and terminalizes nothing, and a later occurrence reopens the same decision', async () => {
    const cand = await file({ kind: 'bug' });
    const occurrence = (title: string) =>
      recordIssueOccurrence(
        { canonicalId: cand.id, sourceTool: 'system', reportKind: 'duplicate', reportedTitle: title },
        db.adminSql as never,
      );
    const first = await occurrence('first report');
    expect(first).not.toBeNull();

    const decision = await decide(cand.id, { disposition: 'reject', reason: 'not reproducible on current build' });
    const result = await exec(cand.id, decision);
    expect(result).toMatchObject({ ok: true, outcome: 'rejected', workItemId: null, converged: false });

    const after = await getIssue(cand.id);
    expect(after?.state).toBe(cand.state);
    expect(readImplementationReadiness(after?.payload)?.status).toBe('not-ready');
    expect(readIntakeDispositionState(after?.payload, first!.occurrenceId)).toMatchObject({
      disposition: 'reject',
      occurrenceWatermark: first!.occurrenceId,
      reopened: false,
    });
    expect(await exec(cand.id, decision)).toMatchObject({ ok: true, converged: true });

    const later = await occurrence('it happened again');
    expect(readIntakeDispositionState(after?.payload, later!.occurrenceId)).toMatchObject({
      disposition: 'reject',
      reopened: true,
    });
    const deps = defaultIntakePromotionDeps();
    expect(await deps.latestOccurrenceId(cand.id)).toBe(later!.occurrenceId);
  });

  it('retains an observation without touching its readiness', async () => {
    const obs = await file({ observation: true });
    const decision = await decide(obs.id, { disposition: 'retain', reason: 'useful context for the gate audit' });
    expect(await exec(obs.id, decision)).toMatchObject({ ok: true, outcome: 'retained' });
    const payload = await payloadOf(obs.id);
    expect(payload.lane).toBe('observation');
    expect(payload.implementationReadiness).toBeUndefined();
    expect(readIntakeDispositionState(payload, null)).toMatchObject({ disposition: 'retain', reopened: false });
  });
});
