import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * presence-roster-read — the read deadline on the @-assign picker fan-out
 * (WI-39825, the last unbounded store-read fan-out in `sync-resolver/index.ts`).
 *
 * Every deadline case here HANGS a leg rather than rejecting it, because a hang
 * is the failure the pre-WI-39825 code could not survive and a rejection is the
 * one it already could. Two legs fan out under one `Promise.all`, which waits
 * for the slowest: a wedged membership store took the whole picker past the
 * sync layer's `RESOLVER_READ_TIMEOUT_MS`, so AssignDialog rendered nothing and
 * the user could not assign to ANYONE — including the live sessions whose read
 * had already come back.
 *
 * The subject is `readAssignableMembers` and not the `dev.assignableMembers`
 * resolver, deliberately: proving a deadline fires requires MOVING it, and a
 * resolver's only input is its wire `argsSchema`, so a resolver-level guard
 * would have to either ship a `budgetMs` test knob to every client or genuinely
 * wait the 6s budget out (blowing vitest's 5s default). `budgetMs` is a FUNCTION
 * parameter on the extracted read, so the budget here is milliseconds and the
 * shipped contract is untouched. See the module header for the full reasoning.
 *
 * The CONTROL and CALIBRATION cases are PERMANENT, per CLAUDE.md's falsifiability
 * tiers: this subject is imported, so the deliberately-wrong version lives in the
 * test file as a control rather than being produced by mutating the shared tree.
 */

const listPresence = vi.fn();
const listWorkspaceMembers = vi.fn();
const activeWorkspaceId = vi.fn();

vi.mock('../agent-tools/coordination/presence', () => ({
  listPresence: (...a: unknown[]) => listPresence(...a),
}));
vi.mock('../hive-membership-store', () => ({
  listWorkspaceMembers: (...a: unknown[]) => listWorkspaceMembers(...a),
}));
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: (...a: unknown[]) => activeWorkspaceId(...a),
}));

import { readAssignableMembers, PRESENCE_ROSTER_READ_BUDGET_MS } from './presence-roster-read';

const AGENT = {
  ownerId: 'su-1',
  ownerLabel: 'Agent One',
  intent: 'bounding reads',
  userId: null,
  stale: false,
};
const MEMBER = { githubUserId: 4242, githubUsername: 'octo', displayName: 'Octo Cat' };

beforeEach(() => {
  listPresence.mockReset().mockResolvedValue([AGENT]);
  listWorkspaceMembers.mockReset().mockResolvedValue([MEMBER]);
  activeWorkspaceId.mockReset().mockReturnValue('ws-active');
});

/** A store read that never settles — the wedge, not a rejection. */
const hang = () => new Promise<never>(() => {});

type Snapshot = {
  rows: Array<Record<string, unknown>>;
  degradedFields?: Array<{ field: string; kind: string; reason: string }>;
};
type Settled =
  | { kind: 'resolved'; snapshot: Snapshot }
  | { kind: 'rejected'; message: string }
  | { kind: 'pending' };

/**
 * Observe WITHOUT waiting forever. "Never settles" is the failure mode under
 * test, so it has to be an assertable OUTCOME (`pending`) rather than a vitest
 * timeout — a timeout would report the CONTROL as a broken test instead of as
 * the guard discriminating correctly.
 */
const settleWithin = (p: Promise<unknown>, ms: number): Promise<Settled> =>
  Promise.race([
    p.then(
      (snapshot): Settled => ({ kind: 'resolved', snapshot: snapshot as Snapshot }),
      (error): Settled => ({
        kind: 'rejected',
        message: String((error as Error)?.message ?? error),
      }),
    ),
    new Promise<Settled>((resolve) => {
      const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);

const read = (budgetMs: number) => readAssignableMembers({ budgetMs });

describe('readAssignableMembers — the read deadline (WI-39825)', () => {
  it('the shipped budget sits under the resolver timeout it exists to beat', async () => {
    // Not a tautology: a budget at or above RESOLVER_READ_TIMEOUT_MS cannot
    // prevent the timeout, so the bound would be decorative. The relationship is
    // the invariant, and it is the one a later "just bump the budget" breaks.
    const { RESOLVER_READ_TIMEOUT_MS } = await import('./read-deadline');
    expect(PRESENCE_ROSTER_READ_BUDGET_MS).toBeLessThan(RESOLVER_READ_TIMEOUT_MS);
  });

  // PRIMARY leg. `presence` IS the picker: every online row comes from it, and
  // an empty online list reads as "nobody is running" — the most misleading
  // thing this dialog can say. So a lapse PROPAGATES, exactly as a throw from
  // that reader already does. The gain is a fast, LABELLED failure at the budget
  // instead of a hang the resolver timeout converts into nothing at all.
  it('a hung PRIMARY leg (presence) is REJECTED at the budget instead of hanging the read', async () => {
    listPresence.mockReturnValue(hang());

    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('rejected');
    // The label is the point: a bare timeout hides WHICH store wedged, which is
    // the first thing anyone triaging an empty assign dialog needs.
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      'assignable presence exceeded the read budget',
    );
  });

  it('CONTROL: the same hung leg NEVER settles when the bound is widened — so it is the deadline doing the work', async () => {
    listPresence.mockReturnValue(hang());

    // The deliberately-wrong version: a budget so large it cannot fire, which IS
    // the pre-WI-39825 behaviour. If this ever reports anything but `pending`,
    // the case above has stopped measuring the deadline and passes for some
    // other reason.
    const outcome = await settleWithin(read(10_000_000), 120);

    expect(outcome.kind).toBe('pending');
  });

  it('CALIBRATION: a healthy read still returns the full picker under the same tight budget', async () => {
    // Guards the opposite failure: a bound that "passes" every case above by
    // breaking every read, healthy or not. Same 25ms budget, working stores.
    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('resolved');
    const snap = outcome.kind === 'resolved' ? outcome.snapshot : null;
    expect(snap?.rows).toEqual([
      {
        assignAddress: 'su-1',
        key: 'su-1',
        label: 'Agent One',
        present: true,
        intent: 'bounding reads',
        userId: null,
        githubUsername: null,
      },
      {
        assignAddress: '@user:gh:4242',
        key: 'gh:4242',
        label: 'Octo Cat',
        present: false,
        intent: null,
        userId: null,
        githubUsername: 'octo',
      },
    ]);
    // A healthy read stays byte-identical to what it was before the bound: the
    // field's PRESENCE is the signal, so it must be absent, not empty.
    expect(snap?.degradedFields).toBeUndefined();
  });

  // SUPPLEMENTARY leg. The dialog is fully usable without the offline half —
  // you can still assign to anyone live — so its lapse costs its own section and
  // nothing else. This is the partial the whole class-fix exists to preserve.
  it('a hung SUPPLEMENTARY leg (members) lands as a NAMED degradedFields entry and the picker still ships', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listWorkspaceMembers.mockReturnValue(hang());

    const outcome = await settleWithin(read(25), 500);
    warn.mockRestore();

    expect(outcome.kind).toBe('resolved');
    const snap = outcome.kind === 'resolved' ? outcome.snapshot : null;
    // The intact leg is TRUE, not sacrificed to the wedged one.
    expect(snap?.rows).toHaveLength(1);
    expect(snap?.rows[0]?.present).toBe(true);
    // ...and the casualty is NAMED. Without this the empty offline section is
    // indistinguishable from "this workspace has no offline members", which is
    // exactly the calm-and-empty answer the old swallowing `.catch(() => [])`
    // gave and the degradedFields channel exists to prevent.
    const degraded = snap?.degradedFields ?? [];
    expect(degraded.map((d) => d.field)).toEqual(['members']);
    expect(degraded[0]?.reason).toContain('assignable members exceeded the read budget');
    // Classified as a read failure, NOT a new `timed-out` kind: UnavailableKind
    // is a shared union the client degraded-provenance guards consume, and
    // widening it to say what the verbatim reason already says would strand them.
    expect(degraded[0]?.kind).toBe('read-failed');
  });

  it('a REJECTING members leg is named too, not swallowed into an empty offline section', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listWorkspaceMembers.mockRejectedValue(
      new Error('relation "hive_workspace_members" does not exist'),
    );

    const outcome = await settleWithin(read(25), 500);
    warn.mockRestore();

    expect(outcome.kind).toBe('resolved');
    const snap = outcome.kind === 'resolved' ? outcome.snapshot : null;
    expect(snap?.rows).toHaveLength(1);
    const degraded = snap?.degradedFields ?? [];
    expect(degraded.map((d) => d.field)).toEqual(['members']);
    expect(degraded[0]?.reason).toContain('does not exist');
    // Pre-migration is its own classification — the honest render is "not
    // available yet", not "nobody is here".
    expect(degraded[0]?.kind).toBe('read-failed');
  });

  it('preserves the two legs’ DIFFERENT workspace scopes across the extraction', async () => {
    // Not incidental: presence is read CROSS-workspace (`null`) while membership
    // is read for the ACTIVE workspace. Collapsing them to one argument during
    // the move would silently scope the picker down — a change nothing else here
    // would catch, because both legs would still succeed.
    await readAssignableMembers({ budgetMs: 25 });

    expect(listPresence).toHaveBeenCalledWith({ workspaceId: null });
    expect(listWorkspaceMembers).toHaveBeenCalledWith('ws-active');

    // ...and an explicit workspace overrides BOTH.
    listPresence.mockClear();
    listWorkspaceMembers.mockClear();
    await readAssignableMembers({ workspace: 'ws-explicit', budgetMs: 25 });
    expect(listPresence).toHaveBeenCalledWith({ workspaceId: 'ws-explicit' });
    expect(listWorkspaceMembers).toHaveBeenCalledWith('ws-explicit');
  });

  it('drops STALE presence rows and dedupes a member already represented by a live session', async () => {
    listPresence.mockResolvedValue([
      AGENT,
      { ...AGENT, ownerId: 'su-stale', ownerLabel: 'Ghost', stale: true },
      { ...AGENT, ownerId: 'su-2', ownerLabel: 'Two', userId: 'gh:4242' },
    ]);

    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('resolved');
    const snap = outcome.kind === 'resolved' ? outcome.snapshot : null;
    // Two live rows; the stale one is gone, and the member is NOT re-listed as
    // offline because a live session already carries its `gh:` id.
    expect(snap?.rows.map((r) => r.key)).toEqual(['su-1', 'su-2']);
  });
});
