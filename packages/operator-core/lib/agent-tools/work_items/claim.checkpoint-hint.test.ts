/**
 * work_items:claim — claim-time checkpoint hint (EI-529).
 *
 * A NAMED claim (a leader/dispatcher assigning a SPECIFIC item to a SPECIFIC
 * agent) previously surfaced nothing about a prior holder's in-flight progress —
 * exactly the "brief dispatch re-assigns already-completed work" pattern EI-529
 * reported (hit 4x in one session: a fresh claimant silently re-implemented work
 * a prior, now-quiet holder had already shipped). This mirrors the EI-7252 fix
 * that did the same for work_items:get, but AT CLAIM TIME so the warning is
 * unmissable on the very call that starts the new claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
// PARTIAL mock (importOriginal), deliberately — NOT a factory listing each export.
// A hand-listed factory silently returns `undefined` for any member claim.ts imports but the
// list forgot, and the tool then crashes on it. That is exactly how this suite went red: WI-5946
// added a pre-claim `getWorkItem(...).catch(...)` guard read; the old factory's bare `vi.fn()`
// returned `undefined`, so `.catch` blew up ("Cannot read properties of undefined") and EVERY
// test here failed with ok:false before the hint was ever looked up. Spreading the real module
// means a FUTURE import claim.ts adds resolves to the genuine implementation instead of
// undefined, so this mock cannot go stale the same way again — only the fns we deliberately
// stub (below) are replaced.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),
}));
// Keep assessClaimHoldGuard REAL (it composes the real payload readers above); stub only the
// side-effecting audit/notify so no test here can touch a real DB/coord backend.
vi.mock('./claim-hold-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordClaimHoldBypassAudit: vi.fn(async () => {}),
  notifyClaimHoldBypass: vi.fn(async () => {}),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
// EI-19418245218824265. The claim-time enrichment legs are PG-backed and fail-soft to
// null here, so a fixture row that is empty silences them for free. The `sourceCitation`
// leg does NOT: it reads the TREE, which no fixture controls, via a real `git grep` for
// the claimed id. `WI-2` is a SUBSTRING of every real `WI-2648`/`WI-2839` in the repo, so
// unmocked it attaches two fields to the fresh-claim result below and the exact-shape
// `toEqual` fails — on repo content, not on anything this suite is about.
//
// Mocked rather than loosening that `toEqual` to `toMatchObject`: the exact shape is the
// point of that test ("omits checkpoint fields ENTIRELY"), and it is what caught this in
// the first place. Weakening it would retire the guard to accommodate the very class of
// change it exists to detect.
vi.mock('../../source-citation-claim-port', () => ({
  getClaimTimeSourceCitation: vi.fn(async () => null),
  sourceCitationWarning: vi.fn(() => null),
}));

const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...a: unknown[]) => getClaimTimeCheckpointHint(...a),
}));

import { claimWorkItem, getWorkItem } from '../../work-items';
const claimM = vi.mocked(claimWorkItem);
const getWorkItemM = vi.mocked(getWorkItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  fleetAdmission.decision = { allowed: true, scoped: false };
  claimM.mockImplementation(async (id: string) => ({ id, harness: 'papercup', assignee: 'me' }) as never);
  // WI-5946: claimOne now unconditionally pre-reads the item via getWorkItem to check
  // payload._claimHold before claiming. These tests exercise the checkpoint-hint path only
  // (no claim-hold scenario), so default to "no pre-existing item row" (null) — matches
  // assessClaimHoldGuard's own no-op-on-null-item behavior and keeps the claim path unaffected.
  getWorkItemM.mockResolvedValue(null as never);
  getClaimTimeCheckpointHint.mockResolvedValue(null);
});

describe('work_items:claim — checkpoint hint at claim time (EI-529)', () => {
  it('attaches checkpoint + a loud warning when a prior holder left one', async () => {
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'did: X; left: Y', checkpointAgeMs: 12_000 });
    const b = await body({ id: 'WI-1' });
    expect(getClaimTimeCheckpointHint).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-1', workspaceId: 'ws-1' });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'WI-1',
      checkpoint: 'did: X; left: Y',
      checkpointAgeMs: 12_000,
    });
    expect(b.results[0].checkpointWarning).toMatch(/PRIOR holder/);
    expect(b.results[0].checkpointWarning).toMatch(/EI-529/);
  });

  it('omits checkpoint fields entirely on a normal fresh claim (no prior checkpoint)', async () => {
    getClaimTimeCheckpointHint.mockResolvedValue(null);
    const b = await body({ id: 'WI-2' });
    expect(b.results[0]).toEqual({ ok: true, id: 'WI-2', workItem: { id: 'WI-2', harness: 'papercup', assignee: 'me' } });
    expect(b.results[0].checkpoint).toBeUndefined();
    expect(b.results[0].checkpointWarning).toBeUndefined();
  });

  it('degrades to a normal claim (no crash) when the checkpoint lookup throws', async () => {
    getClaimTimeCheckpointHint.mockRejectedValue(new Error('pg down'));
    const b = await body({ id: 'WI-3' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-3' });
    expect(b.results[0].checkpoint).toBeUndefined();
  });

  // REGRESSION (this suite's own red): claim.ts runs WI-5946's pre-claim `getWorkItem(...)`
  // claim-hold guard read BEFORE it ever reaches the EI-529 hint. When that read is stubbed to
  // something that is not a promise (a bare `vi.fn()` → `undefined`), the `.catch(…)` chained on
  // it throws, runBulk converts the throw into `ok:false`, and all four tests above fail with a
  // confusing "expected ok:false to equal ok:true" that names neither getWorkItem nor the guard.
  // This pins the coupling explicitly so a future re-stub fails HERE, with a message that says
  // which call broke it, instead of reddening the whole file for an unrelated-looking reason.
  it('runs the WI-5946 pre-claim guard read without failing the claim or suppressing the hint', async () => {
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'prior work', checkpointAgeMs: 1_000 });
    const b = await body({ id: 'WI-GUARD' });
    // The guard read must actually happen (it is claim.ts's only claim-hold check on the by-id path)…
    expect(getWorkItemM).toHaveBeenCalled();
    // …and it must be awaitable — a non-promise stub is what broke this suite.
    expect(getWorkItemM.mock.results[0]?.value).toBeInstanceOf(Promise);
    // …while leaving the claim itself successful, un-errored, and still carrying the EI-529 hint.
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-GUARD', checkpoint: 'prior work' });
    expect(b.results[0].error).toBeUndefined();
  });

  it('surfaces the hint on EACH item of a multi-item batch independently', async () => {
    getClaimTimeCheckpointHint.mockImplementation(async ({ workItemId }: { workItemId: string }) =>
      workItemId === 'WI-HOT' ? { checkpoint: 'prior progress on WI-HOT', checkpointAgeMs: 500 } : null,
    );
    const b = await body({ ids: ['WI-COLD', 'WI-HOT'] });
    expect(b.results[0]).not.toHaveProperty('checkpoint');
    expect(b.results[1]).toMatchObject({ id: 'WI-HOT', checkpoint: 'prior progress on WI-HOT' });
  });
});
