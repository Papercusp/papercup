/**
 * idle-recipients.test.ts — coord:send no-wake idle-recipient REPORTING
 * (coord-dispatch-reliability-2026-06-21 P-001).
 *
 * Two layers, mirroring recipient-resolve.test.ts:
 *  1. PURE core — `classifyRecipientLiveness` (no I/O, exhaustive disposition).
 *  2. Host probe — `reportIdleRecipients`, with `listPresence` (the roster) and
 *     `listActiveAwaitsForKey` (the NON-FIRING watcher probe) mocked. The
 *     await-event ENGINE (emitAwaitedEvent) is mocked too, ASSERTED never called
 *     — the whole point of the default path is report-only, never a wake
 *     (invariant a).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./presence', () => ({ listPresence: vi.fn() }));
vi.mock('../../events/await/store', () => ({ listActiveAwaitsForKey: vi.fn() }));
// The probe must NEVER wake — mock the engine so a stray emit would be a loud,
// asserted failure rather than a live PG hit.
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));

import {
  classifyRecipientLiveness,
  reportIdleRecipients,
  inboxWakeKey,
} from './inbox-wake';
import { listPresence } from './presence';
import { listActiveAwaitsForKey } from '../../events/await/store';
import { emitAwaitedEvent } from '../../events/await/engine';

const presence = (...ownerIds: string[]) => ownerIds.map((ownerId) => ({ ownerId })) as never;
/** One fake active watcher row — only the array LENGTH matters to the probe. */
const watchers = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i })) as never;

describe('classifyRecipientLiveness (pure core)', () => {
  it('flags a local recipient with ZERO active watchers as idle', () => {
    expect(
      classifyRecipientLiveness({ ownerId: 'su-bee-1', inRoster: true, activeWatchers: 0 }),
    ).toBe('idle');
  });

  it('does NOT flag a local recipient that HAS an active watcher (live)', () => {
    expect(
      classifyRecipientLiveness({ ownerId: 'su-bee-1', inRoster: true, activeWatchers: 1 }),
    ).toBe('live');
    expect(
      classifyRecipientLiveness({ ownerId: 'su-bee-1', inRoster: true, activeWatchers: 3 }),
    ).toBe('live');
  });

  it('does NOT flag a recipient outside the local roster (federated/unknown) as idle', () => {
    // A federated recipient has zero LOCAL watchers but is NOT idle — its watchers
    // live on its home instance (invariant c).
    expect(
      classifyRecipientLiveness({ ownerId: 'su-remote', inRoster: false, activeWatchers: 0 }),
    ).toBe('unknown');
  });
});

describe('reportIdleRecipients (host probe — report-only, fail-soft)', () => {
  beforeEach(() => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-bee-1', 'su-bee-2'));
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(0));
  });
  afterEach(() => vi.clearAllMocks());

  it('NEVER fires a wake — report-only (invariant a)', async () => {
    await reportIdleRecipients(['su-bee-1'], {});
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });

  it('flags a local recipient with no active watcher as idle', async () => {
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(0));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.idle).toEqual(['su-bee-1']);
    expect(r.live).toEqual([]);
    expect(r.degraded).toBe(false);
    // probed the EXACT inbox-wake key (the rendezvous), not a wildcard.
    expect(vi.mocked(listActiveAwaitsForKey).mock.calls[0][0]).toBe(inboxWakeKey('su-bee-1'));
  });

  it('does NOT flag a local recipient with an active watcher', async () => {
    vi.mocked(listActiveAwaitsForKey).mockResolvedValue(watchers(2));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.idle).toEqual([]);
    expect(r.live).toEqual(['su-bee-1']);
  });

  it('does NOT flag a federated/unknown recipient (not in the local roster)', async () => {
    // su-remote is not in the roster → unknown, never idle. We must not even
    // probe its watchers (they aren't ours).
    const r = await reportIdleRecipients(['su-remote'], {});
    expect(r.idle).toEqual([]);
    expect(r.unknown).toEqual(['su-remote']);
    expect(listActiveAwaitsForKey).not.toHaveBeenCalled();
  });

  it('skips non-wakeable targets ("*"/"human"/empty) and audience selectors (invariant b)', async () => {
    const r = await reportIdleRecipients(['*', 'human', '', '@plan:x', '@role:bee'], {});
    expect(r).toMatchObject({ idle: [], live: [], unknown: [], degraded: false });
    expect(listActiveAwaitsForKey).not.toHaveBeenCalled();
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });

  it('classifies a MIXED send: idle + live + federated, skipping selectors', async () => {
    vi.mocked(listPresence).mockResolvedValue(presence('su-idle', 'su-live'));
    vi.mocked(listActiveAwaitsForKey).mockImplementation((async (key: string) =>
      key === inboxWakeKey('su-live') ? watchers(1) : watchers(0)) as never);
    const r = await reportIdleRecipients(['su-idle', 'su-live', 'su-remote', '*'], {});
    expect(r.idle).toEqual(['su-idle']);
    expect(r.live).toEqual(['su-live']);
    expect(r.unknown).toEqual(['su-remote']);
    expect(r.degraded).toBe(false);
  });

  it('DEGRADES to an empty report (send still ok) when the ROSTER read throws (invariant c)', async () => {
    // The degrade path logs a single advisory warn — expected, so spy it out (the
    // repo fails tests on un-asserted console.warn).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listPresence).mockRejectedValue(new Error('roster down'));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.degraded).toBe(true);
    expect(r.idle).toEqual([]); // never a FALSE idle on a read hiccup
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('DEGRADES to an empty report when an AWAIT-STORE read throws (invariant c)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listActiveAwaitsForKey).mockRejectedValue(new Error('await store down'));
    const r = await reportIdleRecipients(['su-bee-1'], {});
    expect(r.degraded).toBe(true);
    expect(r.idle).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('returns a clean empty (NOT degraded) report when there are no concrete recipients', async () => {
    const r = await reportIdleRecipients(['*', 'human'], {});
    expect(r).toEqual({ idle: [], live: [], unknown: [], degraded: false });
    expect(listPresence).not.toHaveBeenCalled();
  });
});
