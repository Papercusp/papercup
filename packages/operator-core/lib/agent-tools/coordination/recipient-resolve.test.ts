import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('./presence', () => ({ listPresence: vi.fn() }));
vi.mock('../../adv-sessions', () => ({ listRecordedLiveSessions: vi.fn() }));
vi.mock('../../sync/hyperbee/session-presence-store', () => ({ listLiveSessionPresence: vi.fn() }));
import {
  isSelectorOrWildcard,
  resolveBestEffort,
  resolveRecipientsAgainst,
  resolveRecipients,
  resolveBestEffortAgainstRoster,
  resetKnownOwnerIdsCache,
} from './recipient-resolve';
import { listPresence } from './presence';
import { listRecordedLiveSessions } from '../../adv-sessions';
import { listLiveSessionPresence } from '../../sync/hyperbee/session-presence-store';

const mockedList = vi.mocked(listPresence);
const mockedRecorded = vi.mocked(listRecordedLiveSessions);
const mockedRemote = vi.mocked(listLiveSessionPresence);
const remoteSess = (ids: string[]) =>
  ids.map((owner_id) => ({ owner_id, last_seen_ms: 1 })) as unknown as Awaited<
    ReturnType<typeof listLiveSessionPresence>
  >;
const roster = (ids: string[]) => ids.map((ownerId) => ({ ownerId })) as Awaited<ReturnType<typeof listPresence>>;
const recorded = (ids: string[]) =>
  ids.map((coordOwnerId) => ({ coordOwnerId })) as Awaited<ReturnType<typeof listRecordedLiveSessions>>;

// Two `su-` agents (distinct uuids) + a `pus-` agent — the prefix `su-df00939e`
// uniquely picks the first; the prefix `su-` is ambiguous across both.
const KNOWN = [
  'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
  'su-fc2fd592-e760-42bd-8057-beb4d06eef52',
  'pus-abcdef01-2345',
];

describe('resolveRecipientsAgainst', () => {
  it('resolves a unique short prefix to the full ownerId (the wake-key bug)', () => {
    const r = resolveRecipientsAgainst(['su-df00939e'], KNOWN);
    expect(r.resolved).toEqual(['su-df00939e-1f16-410d-ac0d-ef1aebd41d96']);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('resolves a SHORT HANDLE (mid-uuid segment shown in [coord+N]) via substring — not a prefix', () => {
    // The injection shows '93a38' for 'su-93a3872a-…' (the post-'su-' segment, NOT a
    // prefix). Owner ask 2026-06-19: reply without a separate coord:presence lookup.
    // Here 'df009' is the mid-segment of the first agent; 'beb4d' a tail segment.
    expect(resolveRecipientsAgainst(['df009'], KNOWN).resolved).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
    expect(resolveRecipientsAgainst(['beb4d'], KNOWN).resolved).toEqual([
      'su-fc2fd592-e760-42bd-8057-beb4d06eef52',
    ]);
  });

  it('prefers a PREFIX match over substring (prefix tried first)', () => {
    // exact-prefix still wins; substring is only the fallback when prefix yields none.
    expect(resolveRecipientsAgainst(['su-df00939e'], KNOWN).resolved).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
  });

  it('keeps an exact ownerId match unchanged', () => {
    const id = 'su-fc2fd592-e760-42bd-8057-beb4d06eef52';
    expect(resolveRecipientsAgainst([id], KNOWN).resolved).toEqual([id]);
  });

  it('flags a concrete id that matches no known agent as unknown — nothing resolved', () => {
    const r = resolveRecipientsAgainst(['su-zzz99999'], KNOWN);
    expect(r.unknown).toEqual(['su-zzz99999']);
    expect(r.resolved).toEqual([]);
  });

  it('flags an ambiguous prefix that matches >1 known agent', () => {
    const r = resolveRecipientsAgainst(['su-'], KNOWN);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].id).toBe('su-');
    expect(r.ambiguous[0].matches).toHaveLength(2);
    expect(r.resolved).toEqual([]);
  });

  it('passes wildcards + audience selectors straight through (no roster check)', () => {
    const to = ['*', 'human', '@plan:my-plan', '@role:bee', ''];
    const r = resolveRecipientsAgainst(to, KNOWN);
    expect(r.resolved).toEqual(to);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('mixes resolved + unknown across a multi-recipient send', () => {
    const r = resolveRecipientsAgainst(['su-df00939e', 'su-zzz99999', '*'], KNOWN);
    expect(r.resolved).toContain('su-df00939e-1f16-410d-ac0d-ef1aebd41d96');
    expect(r.resolved).toContain('*');
    expect(r.unknown).toEqual(['su-zzz99999']);
  });
});

describe('isSelectorOrWildcard', () => {
  it('recognizes wildcards + audience selectors', () => {
    for (const s of ['*', 'human', '', '@plan:x', '@role:bee', '@wave:2', '@user:gh:1']) {
      expect(isSelectorOrWildcard(s)).toBe(true);
    }
  });
  it('treats a concrete ownerId as not-a-selector', () => {
    expect(isSelectorOrWildcard('su-df00939e')).toBe(false);
    expect(isSelectorOrWildcard('pus-abcdef01-2345')).toBe(false);
  });
});

describe('resolveBestEffort (the silent shared-layer twin)', () => {
  it('rewrites a unique prefix to the full ownerId', () => {
    expect(resolveBestEffort(['su-df00939e'], KNOWN)).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
  });
  it('resolves a short handle (mid-uuid substring) to the full ownerId', () => {
    expect(resolveBestEffort(['fc2fd'], KNOWN)).toEqual([
      'su-fc2fd592-e760-42bd-8057-beb4d06eef52',
    ]);
  });
  it('leaves an UNKNOWN id unchanged (best-effort never rejects)', () => {
    expect(resolveBestEffort(['su-zzz99999'], KNOWN)).toEqual(['su-zzz99999']);
  });
  it('leaves an AMBIGUOUS prefix unchanged', () => {
    expect(resolveBestEffort(['su-'], KNOWN)).toEqual(['su-']);
  });
  it('passes selectors/wildcards + exact ids through untouched', () => {
    const to = ['*', 'human', '@plan:x', 'su-fc2fd592-e760-42bd-8057-beb4d06eef52'];
    expect(resolveBestEffort(to, KNOWN)).toEqual(to);
  });
});

// ── Host wrappers (depth pass, su-7f3e0376) — the fail-open / fail-soft semantics ──
describe('resolveRecipients (host wrapper — fail-open against the live roster)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRecorded.mockResolvedValue([]);
  });

  it('resolves against the live roster when present', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    const r = await resolveRecipients(['su-df00939e']);
    expect(r.resolved).toEqual(['su-df00939e-1f16-410d-ac0d-ef1aebd41d96']);
  });

  it('FAILS OPEN (passes everything through) when the roster is EMPTY — never a false unknown', async () => {
    // Both an empty roster AND an unavailable roster (listPresence throws → [] in the catch) converge
    // on this same passthrough; the throw-path is the catch's twin, left to integration coverage.
    mockedList.mockResolvedValue(roster([]));
    const r = await resolveRecipients(['su-zzz99999', 'whoever']);
    expect(r).toEqual({ resolved: ['su-zzz99999', 'whoever'], unknown: [], ambiguous: [] });
  });

  it('accepts recorded-live session owners that have not self-registered presence yet', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRecorded.mockResolvedValue(recorded(['s-1782352639138-43ed80c0']));
    const r = await resolveRecipients(['s-1782352639138']);
    expect(r).toEqual({
      resolved: ['s-1782352639138-43ed80c0'],
      unknown: [],
      ambiguous: [],
    });
  });
});

describe('H1 (audit D-013) — remote session presence never shadows a LOCAL identity', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRemote.mockReset();
    mockedRecorded.mockResolvedValue([]);
    mockedRemote.mockResolvedValue(remoteSess([]));
  });

  it('a genuine remote session id resolves like a local one (the P-007 parity path)', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRemote.mockResolvedValue(remoteSess(['su-remote-abc123']));
    const r = await resolveRecipients(['su-remote-abc123'], 'ws-1');
    expect(r.resolved).toEqual(['su-remote-abc123']);
    expect(r.unknown).toEqual([]);
  });

  it('a remote session CLAIMING a local ownerId stays resolvable to the LOCAL agent — never doubled/ambiguous', async () => {
    // Local presence owns 'mug'; a hostile admitted member ALSO gossips a session
    // claiming 'mug'. The local agent is authoritative: 'mug' resolves cleanly,
    // the colliding remote claim never introduces a phantom/ambiguity.
    mockedList.mockResolvedValue(roster(['mug', 'su-local-xyz']));
    mockedRemote.mockResolvedValue(remoteSess(['mug']));
    const r = await resolveRecipients(['mug'], 'ws-1');
    expect(r.resolved).toEqual(['mug']);
    expect(r.ambiguous).toEqual([]);
    expect(r.unknown).toEqual([]);
  });
});

describe('resolveBestEffortAgainstRoster (host wrapper — broadcast short-circuit + fail-soft)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRecorded.mockResolvedValue([]);
  });

  it('SKIPS the roster read entirely when every entry is a selector/wildcard (broadcasts pay nothing)', async () => {
    const out = await resolveBestEffortAgainstRoster(['*', 'human', '@plan:x']);
    expect(out).toEqual(['*', 'human', '@plan:x']);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('resolves a unique prefix against the roster when a concrete id is present', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    expect(await resolveBestEffortAgainstRoster(['su-df00939e'])).toEqual([
      'su-df00939e-1f16-410d-ac0d-ef1aebd41d96',
    ]);
  });

  it('resolves against live recorded sessions when raw presence has not registered the owner yet', async () => {
    mockedList.mockResolvedValue(roster([]));
    mockedRecorded.mockResolvedValue(recorded(['s-1782352639138-43ed80c0']));
    expect(await resolveBestEffortAgainstRoster(['s-1782352639138'])).toEqual([
      's-1782352639138-43ed80c0',
    ]);
  });
});

// EI-9299: a short in-process TTL memo on the roster read collapses a burst of
// near-simultaneous coord writes (each resolving recipients) into ONE shared
// fetch instead of one per call — the fix for the measured "coord write path
// slow, DB baseline fine" probe-canary breach (3 parallel roster reads fired
// on every send/ack with a concrete recipient).
describe('readKnownOwnerIds roster memoization (EI-9299)', () => {
  beforeEach(() => {
    resetKnownOwnerIdsCache();
    mockedList.mockReset();
    mockedRecorded.mockReset();
    mockedRecorded.mockResolvedValue([]);
  });

  it('shares ONE underlying roster fetch across concurrent/rapid calls within the TTL window', async () => {
    mockedList.mockResolvedValue(roster(KNOWN));
    await Promise.all([
      resolveBestEffortAgainstRoster(['su-df00939e']),
      resolveBestEffortAgainstRoster(['su-fc2fd592']),
      resolveBestEffortAgainstRoster(['su-df00939e']),
    ]);
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('does NOT cross-contaminate different workspaces (separate cache key per workspaceId)', async () => {
    mockedList.mockResolvedValueOnce(roster(['su-ws1-only']));
    mockedList.mockResolvedValueOnce(roster(['su-ws2-only']));
    const [a, b] = await Promise.all([
      resolveBestEffortAgainstRoster(['su-ws1-o'], 'ws-1'),
      resolveBestEffortAgainstRoster(['su-ws2-o'], 'ws-2'),
    ]);
    expect(a).toEqual(['su-ws1-only']);
    expect(b).toEqual(['su-ws2-only']);
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after resetKnownOwnerIdsCache (a fresh mock takes effect immediately, no stale carry-over)', async () => {
    mockedList.mockResolvedValueOnce(roster(['su-old-agent12']));
    await resolveBestEffortAgainstRoster(['su-old-age']);
    resetKnownOwnerIdsCache();
    mockedList.mockResolvedValueOnce(roster(['su-new-agent12']));
    const out = await resolveBestEffortAgainstRoster(['su-new-age']);
    expect(out).toEqual(['su-new-agent12']);
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('a degraded roster (one source failing) resolves fail-soft and is memoized like any other result within the TTL window', async () => {
    // readKnownOwnerIds aggregates via Promise.allSettled — one leg rejecting
    // never rejects the aggregate; it just contributes no ids from that leg.
    // So this is NOT a "poisoned cache" scenario to guard against; it's the
    // existing fail-soft behavior, now also memoized for the TTL window like
    // any successful fetch (a fresh call still gets it via resetKnownOwnerIdsCache
    // — see the preceding test).
    mockedList.mockRejectedValueOnce(new Error('transient PG error'));
    mockedRecorded.mockResolvedValue([]);
    const first = await resolveBestEffortAgainstRoster(['su-df00939e']);
    expect(first).toEqual(['su-df00939e']);
    const second = await resolveBestEffortAgainstRoster(['su-df00939e']);
    expect(second).toEqual(['su-df00939e']);
    // Both calls served from the ONE memoized fetch — no re-fetch within the TTL window.
    expect(mockedList).toHaveBeenCalledTimes(1);
  });
});
