/**
 * premise-probes.test.ts — the production probe set for `resolvePremiseStamps`
 * (P-011, WI-6731).
 *
 * These assert the properties that make a premise stamp SAFE to show a reader,
 * not the plumbing. The field is authored — a sender says what its reasoning
 * rested on — so the expensive failure here is not a missing stamp, it is a
 * stamp that accuses a sender who did nothing wrong. Three of the four suites
 * below exist for that one reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { premiseProbes, isFullFormMsgId } from './premise-probes';
import { resolvePremiseStamps, type PremiseProbes } from './premise-resolve';

const getMessageById = vi.fn();
const getWorkItem = vi.fn();

vi.mock('./messages', () => ({ getMessageById: (...a: unknown[]) => getMessageById(...a) }));
vi.mock('../../work-items', () => ({ getWorkItem: (...a: unknown[]) => getWorkItem(...a) }));
vi.mock('../../work-item-dispatch-states', () => ({
  ISSUE_TERMINAL_STATES: ['resolved', 'closed', 'deprecated', 'done'],
}));
// The SQL-backed probes' deps, mocked so the anti-escape pin below can prove BOTH
// concurrent legs resolved the MOCKED module rather than the real one.
const sql = vi.fn(async () => [{ plan_exists: true, decision_exists: true }]);
const getOrgPg = vi.fn(() => ({ sql }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => getOrgPg() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

beforeEach(() => {
  getMessageById.mockReset();
  getWorkItem.mockReset();
});

const FULL_ID = 'msas1j6h-0000-34bbe4b498e54dc68c9857c580f624e9';

describe('the false-accusation guard — a short-form msg id must never read as dangling', () => {
  // WI-6725 (open, filed by a peer): `getMessageById` matches msg_id EXACTLY,
  // so a truncated id returns null even when the message is real — reproduced
  // live on 2026-08-01 (full id → found, short form → not found). A naive probe
  // would turn that into `unresolvable`: "no message X", a false accusation on
  // a field whose entire purpose is honest reasoning about each other.
  it('returns unknown — not unresolvable — for a short-form id, and does ZERO IO', async () => {
    const probes = premiseProbes();
    await expect(probes.message!('msas1j6h')).resolves.toBeNull();
    expect(getMessageById).not.toHaveBeenCalled();
  });

  it('still resolves a FULL-form id normally, so the guard costs no real coverage', async () => {
    getMessageById.mockResolvedValue({ msg_id: FULL_ID });
    const probes = premiseProbes();
    await expect(probes.message!(FULL_ID)).resolves.toEqual({ exists: true });
    expect(getMessageById).toHaveBeenCalledWith(FULL_ID);
  });

  it('reports a genuinely missing FULL-form id as absent — the guard is not a blanket excuse', async () => {
    getMessageById.mockResolvedValue(null);
    const probes = premiseProbes();
    await expect(probes.message!(FULL_ID)).resolves.toEqual({ exists: false });
  });

  it('classifies the two id shapes', () => {
    expect(isFullFormMsgId(FULL_ID)).toBe(true);
    expect(isFullFormMsgId('msas1j6h')).toBe(false);
    expect(isFullFormMsgId('')).toBe(false);
  });
});

describe('the WI-6502 case — a #completion premise on an item that never completed', () => {
  it('is broken (sender was wrong AT SEND), not stale (ground moved)', async () => {
    // The distinction is the whole recipient affordance: `broken` means correct
    // the sender, `stale` means re-read the premise. Collapsing them would make
    // the stamp useless even while looking like it worked.
    getWorkItem.mockResolvedValue({ state: 'open' });
    const [stamp] = await resolvePremiseStamps(['WI-6502#completion'], premiseProbes());
    expect(stamp!.status).toBe('broken');
    expect(stamp!.note).toContain('open');
  });

  it('holds once the item is genuinely terminal', async () => {
    getWorkItem.mockResolvedValue({ state: 'done' });
    const [stamp] = await resolvePremiseStamps(['WI-6502#completion'], premiseProbes());
    expect(stamp!.status).toBe('holds');
  });

  it('reports a work-item that does not exist as unresolvable', async () => {
    getWorkItem.mockResolvedValue(null);
    const [stamp] = await resolvePremiseStamps(['WI-9999#completion'], premiseProbes());
    expect(stamp!.status).toBe('unresolvable');
  });
});

describe('the OTHER false-accusation guard — a cross-harness item must not read as dangling', () => {
  // `getWorkItem`'s issue-family leg is global, but its FEATURE-family leg
  // filters on harness_slug. So a feature cited from a peer's harness misses
  // the scoped lookup, and without the retry it would be stamped "WI-N does not
  // exist" about an item that plainly does. Widening classification to BARE ids
  // (WI-6735) is what made this likely rather than merely possible — a bare id
  // is the normal way a feature gets cited.
  it('retries WITHOUT the harness before declaring a work-item non-existent', async () => {
    getWorkItem.mockImplementation(async (_id: string, harness?: string) =>
      harness ? null : { state: 'open' },
    );
    const probes = premiseProbes({ harnessSlug: 'some-other-harness' });
    await expect(probes.workItem!('WI-4242')).resolves.toEqual({
      exists: true,
      state: 'open',
      terminal: false,
    });
    expect(getWorkItem).toHaveBeenNthCalledWith(1, 'WI-4242', 'some-other-harness');
    expect(getWorkItem).toHaveBeenNthCalledWith(2, 'WI-4242');
  });

  it('still reports a genuinely absent item as absent — the retry is not a blanket excuse', async () => {
    getWorkItem.mockResolvedValue(null);
    const probes = premiseProbes({ harnessSlug: 'papercusp' });
    await expect(probes.workItem!('WI-9999')).resolves.toEqual({ exists: false });
    expect(getWorkItem).toHaveBeenCalledTimes(2);
  });

  it('does not double-probe when no harness is scoped in the first place', async () => {
    getWorkItem.mockResolvedValue(null);
    const probes = premiseProbes();
    await expect(probes.workItem!('WI-9999')).resolves.toEqual({ exists: false });
    expect(getWorkItem).toHaveBeenCalledTimes(1);
  });
});

describe('a BARE work-item premise asserts existence — never completion (D-026 correction 2)', () => {
  // This asserts the RESOLVER's semantics, so it injects a probe double through
  // the seam the module exists to provide, rather than driving the production
  // probe and mocking the store underneath it. That is not a style preference:
  // the earlier version did the latter and, because two distinct refs resolve
  // CONCURRENTLY, one leg escaped `vi.mock` and read the live database — so the
  // verdict below silently depended on the real WI-6560's state and went red
  // for the whole fleet the moment that row was closed. A double cannot be
  // escaped. (The production probe's own store behaviour is covered by the
  // suites above, which call it directly, and by the anti-escape pin below.)
  const openItem: PremiseProbes = {
    workItem: async () => ({ exists: true, state: 'open', terminal: false }),
  };

  it('holds on an OPEN item, where the same item cited #completion is broken', async () => {
    const [bare, completion] = await resolvePremiseStamps(
      ['WI-6560', 'WI-6560#completion'],
      openItem,
    );
    expect(bare!.status).toBe('holds');
    expect(completion!.status).toBe('broken');
    expect(completion!.note).toContain('open');
  });

  // THE ANTI-ESCAPE PIN (the regression that reddened the gate).
  // Two DISTINCT refs are probed concurrently, so the production probe resolves
  // its store imports twice over. If those imports are ever un-shared again,
  // one leg resolves a different (unmocked) module instance and this call count
  // drops to 1 — which is the ONLY loud symptom, since the escaping leg returns
  // a real row that usually looks plausible. Assert the count, not just the
  // verdict: a verdict-only assertion is exactly what stayed green for as long
  // as production data happened to agree with the fixture.
  it('never lets a concurrently-probed ref escape to the real store', async () => {
    getWorkItem.mockResolvedValue({ state: 'open' });
    const [bare, completion] = await resolvePremiseStamps(
      ['WI-6560', 'WI-6560#completion'],
      premiseProbes(),
    );
    expect(getWorkItem).toHaveBeenCalledTimes(2);
    expect(bare!.status).toBe('holds');
    expect(completion!.status).toBe('broken');
  });

  it('catches a mistyped id, which is the entire point of classifying it', async () => {
    getWorkItem.mockResolvedValue(null);
    const probes = premiseProbes();
    const [stamp] = await resolvePremiseStamps(['WI-6650'], probes);
    expect(stamp!.status).toBe('unresolvable');
    expect(stamp!.ref).toBe('WI-6650');
  });
});

// THE SIBLING ANTI-ESCAPE PIN — the half the original fix missed.
//
// The work-item probe was hardened by sharing ONE memoized import promise, because
// two concurrently-resolved refs that each opened their own `import()` could land on
// different module instances and one would escape `vi.mock` into the real database.
// `workspaceScopedSql` — used by planDecision, planItem AND fact — kept the unshared
// shape for another day, one function below the comment explaining why it must not.
//
// The failure mode is the reason this pin asserts a CALL COUNT rather than a verdict:
// an escaping leg reads a real row that usually looks plausible, so the verdict stays
// green until production data happens to disagree, and the red then lands on whoever
// is unlucky rather than on whoever caused it.
describe('the SQL-backed probes share one import — a concurrent leg cannot escape to the real DB', () => {
  it('resolves two plan-decision refs concurrently with BOTH legs on the mocked store', async () => {
    const [a, b] = await resolvePremiseStamps(
      ['some-plan#D-001', 'some-plan#D-002'],
      premiseProbes({ workspaceId: 'ws-test' }),
    );
    // One getOrgPg call per probe. A leg that resolved an unmocked module instance
    // would drop this to 1 while still returning a plausible-looking stamp.
    expect(getOrgPg).toHaveBeenCalledTimes(2);
    expect(sql).toHaveBeenCalledTimes(2);
    expect(a!.status).toBe('holds');
    expect(b!.status).toBe('holds');
  });
});

describe('fail-soft — a decorative stamp must never be able to fail the send it decorates', () => {
  it('degrades a throwing store to unknown rather than propagating', async () => {
    getWorkItem.mockRejectedValue(new Error('pg is down'));
    const [stamp] = await resolvePremiseStamps(['WI-1#completion'], premiseProbes());
    expect(stamp!.status).toBe('unknown');
  });

  it('keeps the ref VERBATIM on every path — verification decorates, never rewrites', async () => {
    getWorkItem.mockRejectedValue(new Error('pg is down'));
    const [stamp] = await resolvePremiseStamps(['WI-1#completion'], premiseProbes());
    expect(stamp!.ref).toBe('WI-1#completion');
  });
});

describe('the cost property — the gate is the invalidatable flag, and it is already inside the resolver', () => {
  // The measured 30h load is ~13 probes fleet-wide (WI-6731), which is why no
  // second cost gate was added. This pins the reason that is TRUE: a
  // non-invalidatable ref never reaches a probe at all.
  it('does ZERO IO for a non-invalidatable ref', async () => {
    const stamps = await resolvePremiseStamps(['some-opaque-thing'], premiseProbes());
    expect(stamps[0]!.status).toBe('not-checkable');
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(getMessageById).not.toHaveBeenCalled();
  });

  it('de-dupes a ref cited twice down to a single probe', async () => {
    getWorkItem.mockResolvedValue({ state: 'done' });
    const stamps = await resolvePremiseStamps(
      ['WI-7#completion', 'WI-7#completion'],
      premiseProbes(),
    );
    expect(stamps).toHaveLength(1);
    expect(getWorkItem).toHaveBeenCalledTimes(1);
  });
});
