/**
 * work_items:get — checkpoint surfacing (EI-7252) + checkpoint recency (EI-8885).
 *
 * A work-item's in-flight CHECKPOINT (work_items:checkpoint → carry-note scope
 * `workitem:<harness>:<id>`) was previously invisible to work_items:get — an
 * investigator (or a compacted successor) reading the item had no way to know a
 * checkpoint existed and could wrongly conclude state was lost. Pins: the field
 * is always present (null when none was ever written), it reflects the resolved
 * work-item's OWN harness (not the request arg), a lookup failure degrades to
 * null rather than failing the whole read, and a harness-NULL item still reads its
 * checkpoint (EI-8805 — the store canonicalizes the null harness to the wildcard
 * namespace it was written under, instead of skipping the lookup and losing it).
 *
 * EI-8885: a checkpoint with no age signal reads as CURRENT even when it's several
 * wakes stale — checkpointAgeMs/checkpointUpdatedAtMs surface the write recency
 * alongside the content so a reader can downgrade trust on an old checkpoint
 * instead of discovering staleness only after acting on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
const getWorkItemDetail = vi.fn();
const getWorkItemThreadWindow = vi.fn();
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  getWorkItemDetail: (...a: unknown[]) => getWorkItemDetail(...a),
  getWorkItemThreadWindow: (...a: unknown[]) => getWorkItemThreadWindow(...a),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

const getWorkItemCheckpointWithMeta = vi.fn();
// P-007: `getWorkItemCheckpointFreshness` returns undefined by default = the
// checkpoint declared no dependencies, so these suites keep exercising the TIME
// heuristics (the documented fallback). The override case gets its own suite below.
const getWorkItemCheckpointFreshness = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
  getWorkItemCheckpointFreshness: (...a: unknown[]) => getWorkItemCheckpointFreshness(...a),
}));

// EI-15184: stub only getPresence (spread the real module so its other exports —
// PRESENCE_STALE_MS, writePresence, … some transitive importer may need — stay live).
const getPresence = vi.fn();
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));

const getClaimTimePriorWorkHint = vi.fn();
vi.mock('../../work-item-prior-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-item-prior-work')>()),
  getClaimTimePriorWorkHint: (...a: unknown[]) => getClaimTimePriorWorkHint(...a),
}));

const completionFreshnessForEvidence = vi.fn();
vi.mock('./completion-freshness', () => ({
  completionFreshnessForEvidence: (...a: unknown[]) => completionFreshnessForEvidence(...a),
}));

import get from './get';
import { CARRY_NOTE_MAX_CHECKS, withCarryNoteChecks } from '../../carry-note';

const ctx = { uiClientId: 'su-tester', workspaceId: 'default' } as never;
const parse = (x: unknown) => (get.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const env = async (x: unknown) => {
  const res = (await get.handler(parse(x) as never, ctx)) as Out;
  return res.data;
};
const one = async (x: unknown) => (await env(x)).results[0];

it('opts out of the ambient workspace transaction because the handler never reads ctx.tx', () => {
  // Keeping this assertion beside the handler's existing wiring tests prevents
  // a future projection change from reintroducing a long-lived app-pool hold.
  expect((get as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

beforeEach(() => {
  getWorkItem.mockReset();
  getWorkItemDetail.mockReset();
  getWorkItemThreadWindow.mockReset();
  getWorkItemCheckpointWithMeta.mockReset().mockResolvedValue({ checkpoint: null, updatedAtMs: null });
  // P-007: default to "no dependencies declared" so every pre-existing suite keeps
  // exercising the time-heuristic fallback; the override suite opts in explicitly.
  getWorkItemCheckpointFreshness.mockReset();
  getWorkItemCheckpointFreshness.mockResolvedValue(undefined);
  getPresence.mockReset();
  getPresence.mockResolvedValue(null);
  getClaimTimePriorWorkHint.mockReset();
  getClaimTimePriorWorkHint.mockResolvedValue(null);
  completionFreshnessForEvidence.mockReset().mockReturnValue(undefined);
});

describe('work_items:get — checkpoint field', () => {
  it('surfaces the terminal completion freshness verdict from the read-side detector', async () => {
    const evidence = {
      treeStamp: { repositoryRoot: '/repo', headSha: 'a'.repeat(40) },
    };
    const completionFreshness = {
      verdict: 'stale',
      storedTreeStamp: evidence.treeStamp,
      currentTreeStamp: { repositoryRoot: '/repo', headSha: 'b'.repeat(40) },
      reason: 'peer advanced HEAD',
    };
    getWorkItem.mockResolvedValue({
      id: 'WI-completion-freshness',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'terminal item',
      state: 'done',
      terminalCompletionEvidence: evidence,
    });
    completionFreshnessForEvidence.mockReturnValue(completionFreshness);

    const r = await one({ id: 'WI-completion-freshness' });

    expect(completionFreshnessForEvidence).toHaveBeenCalledWith(evidence);
    expect(r.completionFreshness).toEqual(completionFreshness);
  });

  it('surfaces an existing checkpoint + its age, keyed by the resolved work-item harness/id', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-7', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    const updatedAtMs = Date.now() - 5000;
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'did step 1; next: step 2', updatedAtMs });
    const r = await one({ id: 'WI-7' });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-7' });
    expect(r).toMatchObject({ ok: true, id: 'WI-7', checkpoint: 'did step 1; next: step 2', checkpointUpdatedAtMs: updatedAtMs });
    expect(r.checkpointAgeMs).toBeGreaterThanOrEqual(5000);
  });

  it('is null (not omitted) when no checkpoint was ever written — age is also null', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-8',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 't',
      state: 'open',
    });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    const r = await one({ id: 'WI-8' });
    expect(r).toMatchObject({
      ok: true,
      id: 'WI-8',
      checkpoint: null,
      checkpointChecks: { count: 0, cap: CARRY_NOTE_MAX_CHECKS, remaining: CARRY_NOTE_MAX_CHECKS },
      checkpointAgeMs: null,
      checkpointUpdatedAtMs: null,
    });
  });

  it('surfaces checkpoint check-row capacity from the stored canonical rows', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-8b',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 't',
      state: 'open',
    });
    const checkpoint = withCarryNoteChecks(
      'work remains',
      Array.from({ length: 10 }, (_, i) => ({ claim: `check ${i + 1}`, recheck: `probe ${i + 1}` })),
    );
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint, updatedAtMs: Date.now() });

    const r = await one({ id: 'WI-8b' });

    expect(r.checkpointChecks).toEqual({ count: 10, cap: CARRY_NOTE_MAX_CHECKS, remaining: 2 });
  });

  it('degrades to null (does not fail the read) when the checkpoint lookup throws', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('pg down'));
    const r = await one({ id: 'WI-9' });
    expect(r).toMatchObject({ ok: true, id: 'WI-9', checkpoint: null, checkpointAgeMs: null, checkpointUpdatedAtMs: null });
    expect(r.checkpointChecks).toBeNull();
    // WI-6737: fail-soft is right, but SILENT fail-soft is not — the degraded null was previously
    // byte-identical to a successful "never checkpointed" read, so a reader (or a compacted
    // successor) concluded in-flight state was lost during a mere PG blip. That is the exact
    // conclusion EI-7252 added this field to prevent, re-created by its own error path.
    expect(r.checkpointReadFailed).toBe(true);
  });

  it('does NOT mark checkpointReadFailed when the read succeeded and found nothing (WI-6737)', async () => {
    // The other half of the distinction, and the one that keeps the flag meaningful: an ordinary
    // never-checkpointed item must stay unmarked, or the signal degenerates into noise every read.
    getWorkItem.mockResolvedValue({ id: 'WI-9b', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    const r = await one({ id: 'WI-9b' });
    expect(r).toMatchObject({ ok: true, checkpoint: null });
    expect(r.checkpointReadFailed).toBeUndefined();
  });

  it('suppresses the never-checkpointed warning after terminal evidence replaced the cleared checkpoint', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-terminal',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'finished item',
      // `done` is the unified terminal state used by the live issue-family writer.
      // Keep this exact shape covered: the original production repro was a DONE row,
      // while the legacy `resolved` alias is covered by the shared terminal-state set.
      state: 'done',
      terminalCompletionEvidence: { verifiedHow: 'unit', testResult: '3 passed' },
    });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    getClaimTimePriorWorkHint.mockResolvedValue({
      lastReleasedBy: 'su-prior',
      releasedAtMs: Date.now() - 1000,
      attempts: 1,
      priorWorkers: ['su-prior'],
    });

    const r = await one({ id: 'WI-terminal' });

    expect(r).toMatchObject({ ok: true, checkpoint: null });
    expect(r.priorWork).toBeUndefined();
    expect(r.priorWorkWarning).toBeUndefined();
  });

  it('retains the never-checkpointed warning for open prior work even when evidence is present', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-open',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'open item',
      state: 'open',
      terminalCompletionEvidence: { verifiedHow: 'unit', testResult: 'stale evidence' },
    });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    getClaimTimePriorWorkHint.mockResolvedValue({
      lastReleasedBy: 'su-prior',
      releasedAtMs: Date.now() - 1000,
      attempts: 1,
      priorWorkers: ['su-prior'],
    });

    const r = await one({ id: 'WI-open' });

    expect(r.priorWorkWarning).toMatch(/NO checkpoint was ever written/);
  });

  it('keeps prior-work checkpoint state UNKNOWN when the read fails on a terminal item', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-terminal-read-failed',
      harness: 'papercup',
      kind: 'bug',
      family: 'issue',
      title: 'finished item',
      state: 'resolved',
      terminalCompletionEvidence: { verifiedHow: 'unit', testResult: '3 passed' },
    });
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('pg down'));
    getClaimTimePriorWorkHint.mockResolvedValue({
      lastReleasedBy: 'su-prior',
      releasedAtMs: Date.now() - 1000,
      attempts: 1,
      priorWorkers: ['su-prior'],
    });

    const r = await one({ id: 'WI-terminal-read-failed' });

    expect(r.checkpointReadFailed).toBe(true);
    expect(r.priorWorkWarning).toMatch(/could NOT BE READ/);
    expect(r.priorWorkWarning).toMatch(/UNKNOWN/);
  });

  it('reads the checkpoint for a harness-null item (EI-8805 — no longer skipped)', async () => {
    // A harness-null item (an EI filed from an unscoped session) previously skipped the
    // checkpoint lookup entirely and always read null, silently losing a written
    // checkpoint. Now the lookup runs (the store canonicalizes the null harness to the
    // wildcard namespace it was written under) so the checkpoint round-trips.
    getWorkItem.mockResolvedValue({ id: 'EI-10', harness: null, kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'harness-null continuity state', updatedAtMs: Date.now() });
    const r = await one({ id: 'EI-10' });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledWith({ harness: null, workItemId: 'EI-10' });
    expect(r).toMatchObject({ ok: true, id: 'EI-10', checkpoint: 'harness-null continuity state' });
  });

  it('also surfaces on the detail path (args.detail:true)', async () => {
    getWorkItemDetail.mockResolvedValue({ id: 'WI-11', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', topics: [], posts: [], links: [] });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'detail-path checkpoint', updatedAtMs: Date.now() });
    const r = await one({ id: 'WI-11', detail: true });
    expect(getWorkItemDetail).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: 'WI-11', checkpoint: 'detail-path checkpoint' });
  });

  it('exposes a bounded recent-comment window without loading full detail', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-12', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemThreadWindow.mockResolvedValue({
      posts: [{ id: 7, thread_id: 'thread-12', author_id: 'su-peer', body: 'comment', created_ts: '2026-08-12T10:00:00.000Z' }],
      total: 9,
      topics: ['release-gate'],
      createdAt: '2026-08-12T09:00:00.000Z',
    });

    const r = await one({ id: 'WI-12', threadLimit: 3 });

    expect(getWorkItem).toHaveBeenCalledWith('WI-12', undefined);
    expect(getWorkItemThreadWindow).toHaveBeenCalledWith('WI-12', 3, undefined);
    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: true,
      id: 'WI-12',
      threadWindow: { total: 9, posts: [{ body: 'comment' }], topics: ['release-gate'] },
    });
  });

  it('threadLimit wins over detail:true and keeps a thread read failure explicit', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-13', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open' });
    getWorkItemDetail.mockResolvedValue({ id: 'WI-13', harness: 'papercup', kind: 'bug', family: 'issue', title: 'wrong full path', state: 'open', topics: [], posts: [], links: [] });
    getWorkItemThreadWindow.mockRejectedValue(new Error('thread store unavailable'));

    const r = await one({ id: 'WI-13', detail: true, threadLimit: 2 });

    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, id: 'WI-13', threadWindow: null, threadWindowReadFailed: true });
  });

  it('never calls the checkpoint store for a not-found item', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404' });
    expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, id: 'WI-404' });
  });
});

describe('work_items:get — checkpointStale (EI-15184 relative staleness)', () => {
  const cpMs = Date.now() - 60 * 60_000; // checkpoint written an hour ago

  it('flags checkpointStale when the assignee stayed active AFTER the checkpoint (the WI-5013 case)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-20', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'snapshot phase only', updatedAtMs: cpMs });
    // assignee kept working ~25m past the checkpoint (invisible later work)
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs + 25 * 60_000).toISOString() });
    const r = await one({ id: 'WI-20' });
    expect(getPresence).toHaveBeenCalledWith('su-peer');
    expect(r.checkpointStale).toBeDefined();
    expect(r.checkpointStale.stale).toBe(true);
    expect(r.checkpointStale.lagMs).toBe(25 * 60_000);
    expect(r.checkpointStale.reason).toMatch(/after this checkpoint/i);
  });

  it('omits checkpointStale when the assignee last acted before the checkpoint (checkpoint is the latest state)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-21', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'up to date', updatedAtMs: cpMs });
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs - 5 * 60_000).toISOString() });
    const r = await one({ id: 'WI-21' });
    expect(r.checkpointStale).toBeUndefined();
  });

  it('does not read presence (nor flag) when the item has no assignee', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-22', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: null });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'x', updatedAtMs: cpMs });
    const r = await one({ id: 'WI-22' });
    expect(getPresence).not.toHaveBeenCalled();
    expect(r.checkpointStale).toBeUndefined();
  });

  it('fail-soft: a presence read failure omits the signal (never fails the read)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-23', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'x', updatedAtMs: cpMs });
    getPresence.mockRejectedValue(new Error('presence pg down'));
    const r = await one({ id: 'WI-23' });
    expect(r).toMatchObject({ ok: true, id: 'WI-23', checkpoint: 'x' });
    expect(r.checkpointStale).toBeUndefined();
  });

  // P-007/D-013: when the checkpoint's author DECLARED what it derives from, that
  // mechanical verdict is authoritative and the activity heuristic is suppressed —
  // the heuristic is a proxy for the same question and gets it wrong in both
  // directions (it cannot see a peer's change at all).
  it('OVERRIDES the activity heuristic with the declared-dependency verdict', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-24', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'declared deps', updatedAtMs: cpMs });
    // The assignee kept working 25m past the checkpoint — the heuristic WOULD fire.
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs + 25 * 60_000).toISOString() });
    getWorkItemCheckpointFreshness.mockResolvedValue({
      verdict: 'fresh',
      declared: 2,
      changed: [],
      unresolvable: [],
      reason: 'all 2 declared dependencies are unchanged',
    });

    const r = await one({ id: 'WI-24' });
    expect(r.checkpointFreshness).toMatchObject({ verdict: 'fresh', declared: 2 });
    expect(r.checkpointStale).toBeUndefined();
    // and it skips the presence round-trip entirely rather than computing a
    // verdict it is going to discard.
    expect(getPresence).not.toHaveBeenCalled();
  });

  it('surfaces a stale declared verdict with the dependency that moved', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-25', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: null });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'rig is intact', updatedAtMs: Date.now() });
    getWorkItemCheckpointFreshness.mockResolvedValue({
      verdict: 'stale',
      declared: 1,
      changed: [{ dep: 'file:shared.ts', was: 'sha256:before', now: 'sha256:after' }],
      unresolvable: [],
      reason: '1 of 1 declared dependency changed since this note was written: file:shared.ts.',
    });
    const r = await one({ id: 'WI-25' });
    expect(r.checkpointFreshness.verdict).toBe('stale');
    expect(r.checkpointFreshness.changed[0].dep).toBe('file:shared.ts');
  });

  it('fail-soft: a freshness read failure falls back to the heuristic', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-26', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'x', updatedAtMs: cpMs });
    getWorkItemCheckpointFreshness.mockRejectedValue(new Error('freshness pg down'));
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date(cpMs + 25 * 60_000).toISOString() });
    const r = await one({ id: 'WI-26' });
    expect(r).toMatchObject({ ok: true, id: 'WI-26' });
    expect(r.checkpointFreshness).toBeUndefined();
    expect(r.checkpointStale?.stale).toBe(true);
  });

  it('does not flag when there is no checkpoint even if the assignee is active', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-24', harness: 'papercup', kind: 'bug', family: 'issue', title: 't', state: 'open', assignee: 'su-peer' });
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    getPresence.mockResolvedValue({ ownerId: 'su-peer', lastActiveAt: new Date().toISOString() });
    const r = await one({ id: 'WI-24' });
    expect(getPresence).not.toHaveBeenCalled();
    expect(r.checkpointStale).toBeUndefined();
  });
});
