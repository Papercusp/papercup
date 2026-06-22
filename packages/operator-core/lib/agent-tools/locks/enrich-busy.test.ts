/**
 * enrich-busy — unit coverage for the file-lock contention enrichment.
 *
 * When a peer is blocked acquiring a file lock, enrichBusy augments the busy rows
 * with the HOLDER's declared coord intent + focus (from presence) — that's what a
 * blocked peer reads to decide whether to wait or pivot. getPresence is mocked
 * (deterministic; no live coord/PG).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ getPresence: vi.fn() }));
vi.mock('../coordination/presence', () => ({ getPresence: h.getPresence }));

import { busyToJson, enrichBusy } from './enrich-busy';
import type { AcquireBusy } from './su-lock-store';

const busy = (over: Partial<AcquireBusy> = {}): AcquireBusy =>
  ({
    path: 'apps/a.ts',
    owner: 'peer-1',
    owner_label: 'res:peer-1',
    intent: 'PreToolUse:Edit',
    expires_ts: new Date('2026-06-22T00:00:00.000Z'),
    ...over,
  }) as AcquireBusy;

beforeEach(() => h.getPresence.mockReset());

describe('busyToJson', () => {
  it('maps an AcquireBusy row to JSON with an ISO expiry (no enrichment)', () => {
    expect(busyToJson(busy())).toEqual({
      path: 'apps/a.ts',
      owner: 'peer-1',
      owner_label: 'res:peer-1',
      intent: 'PreToolUse:Edit',
      expires_ts: '2026-06-22T00:00:00.000Z',
    });
  });
});

describe('enrichBusy', () => {
  it("adds the holder's declared coord intent + focus from presence", async () => {
    h.getPresence.mockResolvedValue({ intent: 'refactoring the sync resolver', currentFiles: ['apps/a.ts'] });
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBe('refactoring the sync resolver');
    expect(row.holder_focused).toBe(true);
  });

  it('treats the OMP placeholder intent as "nothing declared" (not surfaced)', async () => {
    h.getPresence.mockResolvedValue({ intent: '(active — see coord:presence for current work)', currentFiles: [] });
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBeUndefined();
    expect(row.holder_focused).toBeUndefined();
  });

  it('ignores an empty / whitespace-only intent (focus is independent)', async () => {
    h.getPresence.mockResolvedValue({ intent: '   ', currentFiles: ['apps/a.ts'] });
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBeUndefined();
    expect(row.holder_focused).toBe(true);
  });

  it('leaves a row unenriched on a presence MISS (holder has no presence → getPresence null)', async () => {
    h.getPresence.mockResolvedValue(null); // no presence row for this owner
    const [row] = await enrichBusy([busy()]);
    expect(row.holder_intent).toBeUndefined();
    expect(row.holder_focused).toBeUndefined();
    expect(row.owner).toBe('peer-1'); // the base mapping is still present
  });

  it('does NOT set holder_focused when the holder is not focused on THIS path', async () => {
    h.getPresence.mockResolvedValue({ intent: 'editing elsewhere', currentFiles: ['apps/other.ts'] });
    const [row] = await enrichBusy([busy({ path: 'apps/a.ts' })]);
    expect(row.holder_focused).toBeUndefined();
    expect(row.holder_intent).toBe('editing elsewhere');
  });

  it('calls getPresence ONCE per distinct holder (dedup), enriching all that holder\'s rows', async () => {
    h.getPresence.mockResolvedValue({ intent: 'big refactor', currentFiles: ['apps/a.ts', 'apps/b.ts'] });
    const rows = await enrichBusy([
      busy({ path: 'apps/a.ts', owner: 'peer-1' }),
      busy({ path: 'apps/b.ts', owner: 'peer-1' }),
    ]);
    expect(h.getPresence).toHaveBeenCalledTimes(1); // one lookup for the shared owner
    expect(rows.every((r) => r.holder_intent === 'big refactor')).toBe(true);
    expect(rows.every((r) => r.holder_focused === true)).toBe(true);
  });
});
