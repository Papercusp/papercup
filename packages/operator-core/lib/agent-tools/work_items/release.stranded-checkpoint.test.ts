/**
 * work_items:release — the STRANDING warning (WI-38297).
 *
 * The bg-job checkpoint classifier (EI-18654296679612119) already fires on every
 * PICKUP path — work_items:get, work_items:claim, scheduler:get_next — so whoever
 * INHERITS an item is told its checkpoint leans on a background job. Nothing fired
 * on the way OUT, which is the moment the strand is actually created: a holder
 * writes "verification running in bg job <id>, will report+complete once it
 * finishes", releases, and their session dies taking that job's bookkeeping with it
 * (EI-16611). The result is an item that is FINISHED but reads `open`.
 *
 * Measured 2026-08-12 (WI-38297): WI-5895 sat open 17 days with its fix already
 * committed, stranded exactly this way, and 47 of the ~449 open+unheld items holding
 * a checkpoint cite a background job.
 *
 * FALSIFIABILITY: `detectBgJobCheckpointClaim` is deliberately left REAL here (never
 * mocked), so these tests exercise the actual regex rather than a stub that would
 * pass no matter what the classifier does. The "cites no background job" case is the
 * permanent CONTROL — without it, a warning wired to fire on ANY checkpoint would
 * pass the positive test just as happily.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
// PARTIAL mock (importOriginal), deliberately — a hand-listed factory silently returns
// `undefined` for any member release.ts imports but the list forgot, and the tool then
// crashes on it (the documented failure mode in claim.checkpoint-hint.test.ts).
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseWorkItem: vi.fn(),
  setWorkItemClaimHold: vi.fn(),
  getWorkItem: vi.fn(),
  commentWorkItem: vi.fn(async () => null),
}));
vi.mock('./release-force-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordForceReleaseAudit: vi.fn(async () => {}),
  notifyForceRelease: vi.fn(async () => {}),
}));
// No pending release-request in any of these scenarios — keep that bookkeeping inert
// so it cannot reach a real coord/DB backend.
vi.mock('../../work-items-release-request', () => ({
  readWorkItemReleaseRequest: vi.fn(() => null),
  resolveWorkItemReleaseRequest: vi.fn(async () => null),
}));

const getWorkItemCheckpoint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpoint: (...a: unknown[]) => getWorkItemCheckpoint(...a),
}));

import { releaseWorkItem, setWorkItemClaimHold, type WorkItem } from '../../work-items';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';
const releaseM = vi.mocked(releaseWorkItem);
const holdM = vi.mocked(setWorkItemClaimHold);
const tool = (await import('./release')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

/**
 * A COMPLETE WorkItem with a Partial override seam — never `as never`. The cast form is
 * what makes a fixture go stale invisibly: it stays assignable to any signature, so the
 * day `WorkItem` gains a required field this file still compiles and fails at RUNTIME in
 * a run some unrelated peer's change selected. Typed, that day is a compile error HERE.
 */
const wi = (over: Partial<WorkItem> & Pick<WorkItem, 'id'>): WorkItem => ({
  kind: 'bug',
  family: 'issue',
  harness: 'papercusp',
  title: 't',
  summary: 's',
  state: 'open',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  parent: null,
  payload: null,
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  goalId: null,
  ...over,
});

/** A checkpoint in the exact shape that strands an item — the WI-5895 sentence. */
const BG_CHECKPOINT =
  'Fix implemented + committed. test:affected running in background (bash id bx76day3h) to confirm ' +
  'no other suite depended on the old behavior — will report+complete once it finishes.';
/** The CONTROL: a real, substantial checkpoint that cites NO background job. */
const PLAIN_CHECKPOINT =
  'Fix implemented + committed at 7a8371a1caf9. Ran npm run test:file -- swarm.test.ts: 61/61 green. ' +
  'Left: nothing — closing next wake.';

/** Release mock reporting the item WAS held (a real release), or was already free (a no-op). */
const releaseReporting = (prior: { assignee: string | null; wasClaimed: boolean }) =>
  mockImplementationTyped(releaseM, async (id, opts) => {
    opts?.onPriorState?.(prior);
    return wi({ id, assignee: null });
  });

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  releaseReporting({ assignee: 'me', wasClaimed: true });
  mockResolvedTyped(holdM, { id: 'WI-PARK', harness: 'papercusp', hold: true, applicable: true });
  getWorkItemCheckpoint.mockResolvedValue(null);
});

describe('work_items:release — stranding warning (WI-38297)', () => {
  it('warns when the released item\'s checkpoint cites a background job', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    const b = await body({ id: 'WI-5895' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-5895', released: true });
    const w = b.results[0].strandedCheckpointWarning as string;
    expect(w).toBeTypeOf('string');
    expect(w).toMatch(/BACKGROUND JOB/);
    expect(w).toMatch(/EI-16611/);
    // It must tell the releaser what to actually DO, not merely that something is wrong.
    expect(w).toMatch(/work_items:complete/);
    expect(w).toMatch(/blocked/);
  });

  it('reads the checkpoint under the item\'s own harness + the caller workspace', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    await body({ id: 'WI-5895' });
    expect(getWorkItemCheckpoint).toHaveBeenCalledWith({
      harness: 'papercusp',
      workItemId: 'WI-5895',
      workspaceId: 'ws-1',
    });
  });

  // THE CONTROL. A warning wired to fire on any checkpoint at all would pass the
  // positive test above; only this case can tell the two implementations apart.
  it('stays SILENT for a substantial checkpoint that cites no background job', async () => {
    getWorkItemCheckpoint.mockResolvedValue(PLAIN_CHECKPOINT);
    const b = await body({ id: 'WI-CLEAN' });
    expect(b.results[0]).toMatchObject({ ok: true, released: true });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  it('stays silent when the item has no checkpoint at all', async () => {
    getWorkItemCheckpoint.mockResolvedValue(null);
    const b = await body({ id: 'WI-NONE' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  // A release that changed nothing stranded nothing — warning here would be noise on a
  // call that did not create the condition.
  it('stays silent on a NO-OP release (item was already unassigned)', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    releaseReporting({ assignee: null, wasClaimed: false });
    const b = await body({ id: 'WI-NOOP' });
    expect(b.results[0]).toMatchObject({ ok: true, released: false });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
    // and it must not have paid for a checkpoint read it cannot use
    expect(getWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('still warns on the claim-hold (durable park) path — a park strands it too', async () => {
    getWorkItemCheckpoint.mockResolvedValue(BG_CHECKPOINT);
    const b = await body({ id: 'WI-PARK', claimHold: true, reason: 'parking' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-PARK' });
    expect(b.results[0].strandedCheckpointWarning).toMatch(/BACKGROUND JOB/);
    expect(b.results[0].claimHold).toBeDefined();
  });

  it('degrades to a normal release (no crash, no warning) when the checkpoint read throws', async () => {
    getWorkItemCheckpoint.mockRejectedValue(new Error('pg down'));
    const b = await body({ id: 'WI-PGDOWN' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-PGDOWN', released: true });
    expect(b.results[0].error).toBeUndefined();
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
  });

  it('evaluates each item of a batch independently', async () => {
    getWorkItemCheckpoint.mockImplementation(async ({ workItemId }: { workItemId: string }) =>
      workItemId === 'WI-HOT' ? BG_CHECKPOINT : PLAIN_CHECKPOINT,
    );
    const b = await body({ ids: ['WI-COLD', 'WI-HOT'] });
    expect(b.results[0]).toMatchObject({ id: 'WI-COLD' });
    expect(b.results[0].strandedCheckpointWarning).toBeUndefined();
    expect(b.results[1]).toMatchObject({ id: 'WI-HOT' });
    expect(b.results[1].strandedCheckpointWarning).toMatch(/BACKGROUND JOB/);
  });
});
