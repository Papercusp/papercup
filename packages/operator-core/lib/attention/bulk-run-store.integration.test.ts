/**
 * bulk-run-store.integration.test.ts — the Inbox bulk-resolve run substrate
 * against real Postgres (inbox-bulk-resolve-2026-08-23, P-001).
 *
 * Validates migration 912's `attention_bulk_runs` + `attention_bulk_run_items`
 * and the store's SQL against the full migrated schema. Follows the org-fixture
 * mock pattern used by triage-store.integration.test.ts: the store routes
 * through `getOrgPg().sql` as the table owner, so we mock it to the fixture's
 * admin (RLS-bypass) client and mock the workspace resolver.
 *
 * The tests are deliberately weighted toward the two properties that would fail
 * SILENTLY in production rather than loudly in review:
 *   - counters are DERIVED from item rows, so a re-reported item (the real
 *     consult-reply path) cannot double-count;
 *   - `settleRunPhase` reads the item rows rather than trusting the caller, so
 *     a miscounting resolver cannot park the pane in `review` with nothing to
 *     review, nor mark a run `complete` while items still need the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-bulk-run-test' }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const {
  BulkRunAlreadyActiveError,
  createRun,
  getRun,
  getRunItems,
  getLatestRun,
  getActiveRun,
  getRunningRun,
  setRunPhase,
  executeBulkRunAction,
  reportOutcomes,
  getPendingReviewItems,
  markItemAccepted,
  settleRunPhase,
} = await import('./bulk-run-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

/** A three-item snapshot shaped like what InboxPane posts. */
function seed(prefix: string) {
  return [
    {
      itemId: `coord-escalation:${prefix}-1`,
      kind: 'coord-escalation',
      title: 'Quarantine the flaky gate test?',
      ref: { kind: 'coord-escalation', msgId: `${prefix}-m1` },
      ownerAgentId: 'su-aaa',
    },
    {
      itemId: `work-item-needs-human:${prefix}-2`,
      kind: 'work-item-needs-human',
      title: 'Need the PostHog key',
      ref: { kind: 'work-item-needs-human', workItemId: 'WI-1' },
      ownerAgentId: 'su-bbb',
    },
    {
      itemId: `smoke-fail:${prefix}-3`,
      kind: 'smoke-fail',
      title: 'Desktop smoke red',
      ref: { kind: 'smoke-fail' },
      ownerAgentId: null,
    },
  ];
}

describe('attention bulk-run store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // WI-41012 — single-flight makes a workspace hold at most one pending/running
  // run, so tests can no longer share one. Each gets its own workspace, which
  // is closer to production anyway: a run left mid-flight by one test is not a
  // fixture the next test should inherit.
  let wsSeq = 0;
  beforeEach(() => {
    wsSeq += 1;
    h.ws = `ws-bulk-run-test-${wsSeq}`;
  });

  it('creates a run from the snapshot, preserving order and ref shape', async () => {
    const run = await createRun({
      items: seed('a'),
      filterSnapshot: { tier: 'needs', kinds: ['coord-escalation'], query: 'gate', shownCount: 3 },
      requestedBy: 'owner:aviynw',
      harnessSlug: 'papercusp',
    });

    expect(run.phase).toBe('pending');
    expect(run.totalItems).toBe(3);
    // The filter snapshot is provenance and must survive the jsonb round-trip.
    expect(run.filterSnapshot.tier).toBe('needs');
    expect(run.filterSnapshot.query).toBe('gate');

    const items = await getRunItems(run.runId);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(items[0]!.itemId).toBe('coord-escalation:a-1');
    // The ref snapshot is what makes a later re-dispatch possible at all.
    expect(items[0]!.ref).toMatchObject({ kind: 'coord-escalation', msgId: 'a-m1' });
    expect(items.every((i) => i.outcome === 'pending')).toBe(true);
  });

  it('refuses a run over zero items', async () => {
    await expect(createRun({ items: [] })).rejects.toThrow(/zero items/i);
  });

  it('de-dupes repeated ids in the snapshot rather than aborting the seed', async () => {
    const dupe = seed('b');
    const run = await createRun({ items: [...dupe, dupe[0]!] });
    expect(run.totalItems).toBe(3);
    expect(await getRunItems(run.runId)).toHaveLength(3);
  });

  it('derives counters from item rows, so a re-reported item cannot double-count', async () => {
    const run = await createRun({ items: seed('c') });

    // First pass: the resolver recommends an item it cannot settle alone.
    await reportOutcomes({
      runId: run.runId,
      outcomes: [
        {
          itemId: 'coord-escalation:c-1',
          outcome: 'recommended',
          actionId: 'quarantine',
          rationale: 'Red 6 days; failure predates the change.',
          confidence: 'high',
          consulted: true,
        },
      ],
    });
    let after = await getRun(run.runId);
    expect(after!.recommended).toBe(1);
    expect(after!.autoResolved).toBe(0);

    // The consulted asker answers in time, so the SAME item is re-reported as
    // resolved. An incrementing counter would now read recommended:1 too.
    await reportOutcomes({
      runId: run.runId,
      outcomes: [
        {
          itemId: 'coord-escalation:c-1',
          outcome: 'auto_resolved',
          actionId: 'quarantine',
          rationale: 'Asker confirmed the flake and withdrew the gate question.',
          confidence: 'high',
          consulted: true,
          consultReply: 'withdrawn — quarantined on my side',
        },
      ],
    });
    after = await getRun(run.runId);
    expect(after!.autoResolved).toBe(1);
    expect(after!.recommended).toBe(0);
    expect(after!.totalItems).toBe(3);
  });

  it('reports unknown item ids instead of widening the run', async () => {
    const run = await createRun({ items: seed('d') });
    const res = await reportOutcomes({
      runId: run.runId,
      outcomes: [
        { itemId: 'coord-escalation:d-1', outcome: 'skipped', error: 'actions never loaded' },
        { itemId: 'improvement:not-in-this-run', outcome: 'auto_resolved', actionId: 'dismiss' },
      ],
    });
    expect(res.updated).toEqual(['coord-escalation:d-1']);
    expect(res.unknown).toEqual(['improvement:not-in-this-run']);
    // The run must still hold exactly the snapshot it was created with.
    expect(await getRunItems(run.runId)).toHaveLength(3);
  });

  it('settles to review while items still need the owner, and to complete once none do', async () => {
    const run = await createRun({ items: seed('e') });
    await setRunPhase({ runId: run.runId, phase: 'running', resolverOwner: 'su-resolver' });

    await reportOutcomes({
      runId: run.runId,
      outcomes: [
        { itemId: 'coord-escalation:e-1', outcome: 'auto_resolved', actionId: 'resolve', rationale: 'moot' },
        { itemId: 'work-item-needs-human:e-2', outcome: 'recommended', actionId: 'answer', rationale: 'owner holds the key' },
        { itemId: 'smoke-fail:e-3', outcome: 'skipped', error: 'no terminal action for this kind' },
      ],
    });

    const settled = await settleRunPhase({ runId: run.runId, resolverOwner: 'su-resolver' });
    expect(settled!.phase).toBe('review');
    expect(settled!.resolverOwner).toBe('su-resolver');
    expect(settled!.startedAt).toBeTruthy();

    // Only the recommended item is the owner's to act on — a skipped one is a
    // recorded non-outcome, not a decision waiting.
    const pending = await getPendingReviewItems(run.runId);
    expect(pending.map((i) => i.itemId)).toEqual(['work-item-needs-human:e-2']);

    // The owner accepts it; nothing is left, so the run completes.
    const accepted = await markItemAccepted({
      runId: run.runId,
      itemId: 'work-item-needs-human:e-2',
      actionId: 'answer',
      note: 'Owner accepted the drafted reply',
    });
    expect(accepted!.outcome).toBe('auto_resolved');

    const done = await settleRunPhase({ runId: run.runId });
    expect(done!.phase).toBe('complete');
    expect(done!.finishedAt).toBeTruthy();
    expect((await getRun(run.runId))!.autoResolved).toBe(2);
  });

  it('never settles to complete while an item was never reached', async () => {
    const run = await createRun({ items: seed('f') });
    // Resolver crashed after one item — the other two are still `pending`.
    await reportOutcomes({
      runId: run.runId,
      outcomes: [{ itemId: 'coord-escalation:f-1', outcome: 'auto_resolved', actionId: 'resolve' }],
    });
    const settled = await settleRunPhase({ runId: run.runId });
    // Requirement 2: an unreached item is visible, never silently absent.
    expect(settled!.phase).toBe('review');
  });

  it('a failed run keeps its partial outcomes and carries the error', async () => {
    const run = await createRun({ items: seed('g') });
    await reportOutcomes({
      runId: run.runId,
      outcomes: [{ itemId: 'coord-escalation:g-1', outcome: 'auto_resolved', actionId: 'resolve' }],
    });
    const failed = await setRunPhase({
      runId: run.runId,
      phase: 'failed',
      error: 'resolver session ended without reporting',
    });
    expect(failed!.phase).toBe('failed');
    expect(failed!.error).toMatch(/without reporting/);
    expect(failed!.finishedAt).toBeTruthy();
    // Requirement 8: partial work survives; the rest stay hand-resolvable.
    const items = await getRunItems(run.runId);
    expect(items.filter((i) => i.outcome === 'auto_resolved')).toHaveLength(1);
    expect(items.filter((i) => i.outcome === 'pending')).toHaveLength(2);
  });

  it('getActiveRun ignores terminal runs; getLatestRun does not', async () => {
    // Its own workspace: the tests above deliberately leave runs in
    // non-terminal phases, and those ARE active — asking "is anything active?"
    // against the shared workspace would be answering about them, not about
    // this test's runs.
    const ws = 'ws-bulk-run-active-test';

    const older = await createRun({ items: seed('h'), workspaceId: ws });
    await setRunPhase({ runId: older.runId, phase: 'complete', workspaceId: ws });

    const newer = await createRun({ items: seed('i'), workspaceId: ws });
    await setRunPhase({ runId: newer.runId, phase: 'running', workspaceId: ws });

    expect((await getActiveRun(ws))!.runId).toBe(newer.runId);
    expect((await getLatestRun(ws))!.runId).toBe(newer.runId);

    // With every run terminal, the pane falls back to idle rather than showing
    // a stale running strip.
    await setRunPhase({ runId: newer.runId, phase: 'complete', workspaceId: ws });
    expect(await getActiveRun(ws)).toBeNull();
    expect((await getLatestRun(ws))!.runId).toBe(newer.runId);
  });

  it('scopes reads to the workspace', async () => {
    const run = await createRun({ items: seed('j') });
    expect(await getRun(run.runId, 'ws-someone-else')).toBeNull();
    expect(await getRunItems(run.runId, 'ws-someone-else')).toHaveLength(0);
  });

  // ── WI-41012 / WI-41013 — the two properties the acceptance rubric added
  // after the fact, and which the shipped code did NOT have. Both are about an
  // agent acting on the owner's inbox when it should not be acting at all.

  it('refuses a SECOND run while one is pending or running (single-flight)', async () => {
    const ws = `ws-single-flight-${Date.now()}`;
    const first = await createRun({ items: seed('sf1'), workspaceId: ws });
    expect(first.phase).toBe('pending');

    // A second start — a double-click, or two clients — must not create a
    // second run: each run LAUNCHES A RESOLVER, so two runs is two agents
    // racing over the same items with terminal authority.
    await expect(createRun({ items: seed('sf2'), workspaceId: ws })).rejects.toBeInstanceOf(
      BulkRunAlreadyActiveError,
    );

    await setRunPhase({ runId: first.runId, phase: 'running', workspaceId: ws });
    await expect(createRun({ items: seed('sf3'), workspaceId: ws })).rejects.toThrow(
      /already active/i,
    );

    // The refusal NAMES the run in flight, so the caller can point at it rather
    // than telling the owner "something went wrong".
    const err = await createRun({ items: seed('sf4'), workspaceId: ws }).catch((e) => e);
    expect(err.code).toBe('run_already_active');
    expect(err.activeRunId).toBe(first.runId);
    expect(err.activePhase).toBe('running');

    // Only the first run exists — the refusals created nothing.
    expect((await getRunningRun(ws))!.runId).toBe(first.runId);
  });

  it('a run awaiting the OWNER in review does not block a new run', async () => {
    // `review` means the agent is done and the human has not looked yet.
    // Blocking on it would strand the whole feature behind a list the owner may
    // never come back to, so single-flight deliberately excludes it.
    const ws = `ws-review-unblocks-${Date.now()}`;
    const first = await createRun({ items: seed('rv1'), workspaceId: ws });
    await setRunPhase({ runId: first.runId, phase: 'review', workspaceId: ws });

    const second = await createRun({ items: seed('rv2'), workspaceId: ws });
    expect(second.runId).not.toBe(first.runId);
    expect(second.phase).toBe('pending');
  });

  it('refuses the resolver’s report once the run has been stopped, and writes nothing', async () => {
    const ws = `ws-stop-rail-${Date.now()}`;
    const run = await createRun({ items: seed('stop'), workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', workspaceId: ws });
    const [one, two] = await getRunItems(run.runId, ws);

    // Normal in-run report lands.
    const ok = await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [{ itemId: one!.itemId, outcome: 'auto_resolved', actionId: 'ack', rationale: 'moot' }],
    });
    expect(ok.refused).toBeNull();
    expect(ok.updated).toEqual([one!.itemId]);

    // The owner presses Stop: the route settles the run where it stands.
    const settled = await settleRunPhase({ runId: run.runId, workspaceId: ws });
    expect(settled!.phase).toBe('review');

    // The resolver is a separate process and has not noticed. Its next report
    // must be REFUSED, not silently dropped — it has usually already taken the
    // action it is reporting, and a silent drop would leave it believing the
    // record exists.
    const after = await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [{ itemId: two!.itemId, outcome: 'auto_resolved', actionId: 'ack', rationale: 'late' }],
    });
    expect(after.refused).toEqual({ reason: 'run_not_accepting_reports', phase: 'review' });
    expect(after.updated).toEqual([]);
    expect(after.unknown).toEqual([two!.itemId]);

    // And nothing moved: the late item is untouched, the early one intact.
    const rows = await getRunItems(run.runId, ws);
    expect(rows.find((r) => r.itemId === two!.itemId)!.outcome).toBe('pending');
    expect(rows.find((r) => r.itemId === one!.itemId)!.outcome).toBe('auto_resolved');
  });

  it('keeps refusing reports once a run is complete or failed', async () => {
    const ws = `ws-stop-terminal-${Date.now()}`;
    const run = await createRun({ items: seed('term'), workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'failed', error: 'gave up', workspaceId: ws });
    const items = await getRunItems(run.runId, ws);

    const res = await reportOutcomes({
      runId: run.runId,
      workspaceId: ws,
      outcomes: [{ itemId: items[0]!.itemId, outcome: 'skipped', error: 'too late' }],
    });
    expect(res.refused?.reason).toBe('run_not_accepting_reports');
    expect((await getRunItems(run.runId, ws))[0]!.outcome).toBe('pending');
  });

  it('serializes Stop with terminal actions: the winner completes before the loser may proceed', async () => {
    const ws = `ws-authoritative-stop-${Date.now()}`;
    const [item] = seed('authority');
    const run = await createRun({ items: [item!], workspaceId: ws });
    await setRunPhase({ runId: run.runId, phase: 'running', workspaceId: ws });

    let releaseAction!: () => void;
    const actionMayFinish = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let markActionStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      markActionStarted = resolve;
    });

    const action = executeBulkRunAction({
      runId: run.runId,
      itemId: item!.itemId,
      actionId: 'resolve',
      rationale: 'The owner gate is moot.',
      workspaceId: ws,
      execute: async () => {
        markActionStarted();
        await actionMayFinish;
        return { resolved: true };
      },
    });
    await actionStarted;

    // Stop must queue behind the SAME run-row authority lock. Acknowledging it
    // while this callback is still in flight would recreate WI-41022: the owner
    // sees "stopped" and then the already-authorized action completes unseen.
    let stopAcknowledged = false;
    const stop = settleRunPhase({ runId: run.runId, workspaceId: ws }).then((result) => {
      stopAcknowledged = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopAcknowledged).toBe(false);

    releaseAction();
    const [acted, stopped] = await Promise.all([action, stop]);
    expect(acted.refused).toBeNull();
    expect(acted.actionResult).toEqual({ resolved: true });
    expect(stopped!.phase).toBe('complete');
    expect((await getRunItems(run.runId, ws))[0]).toMatchObject({
      outcome: 'auto_resolved',
      actionId: 'resolve',
      rationale: 'The owner gate is moot.',
    });

    // The opposite ordering is the revocation guarantee: once Stop commits,
    // a later actor must be refused before its irreversible callback begins.
    const [lateItem] = seed('revoked');
    const lateRun = await createRun({ items: [lateItem!], workspaceId: ws });
    await setRunPhase({ runId: lateRun.runId, phase: 'running', workspaceId: ws });
    expect((await settleRunPhase({ runId: lateRun.runId, workspaceId: ws }))!.phase).toBe('review');

    let dispatchedAfterStop = false;
    const late = await executeBulkRunAction({
      runId: lateRun.runId,
      itemId: lateItem!.itemId,
      actionId: 'resolve',
      rationale: 'Must never execute.',
      workspaceId: ws,
      execute: async () => {
        dispatchedAfterStop = true;
        return { resolved: true };
      },
    });
    expect(late.refused).toEqual({ reason: 'run_authority_revoked', phase: 'review' });
    expect(dispatchedAfterStop).toBe(false);
    expect((await getRunItems(lateRun.runId, ws))[0]!.outcome).toBe('pending');
  });
});
