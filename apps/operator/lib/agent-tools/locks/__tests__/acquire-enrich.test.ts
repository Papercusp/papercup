/**
 * acquire-enrich.test.ts — plan harness-test-coverage-for-launch P-017.
 *
 * Covers enrichBusy — the logic that decorates a busy/contention result with the
 * holder's DECLARED coord intent (holder_intent) and a holder_focused flag. This
 * is exactly what a blocked peer reads when locks:acquire returns busy, and it
 * runs on every contention; it had no coverage. getPresence is mocked so this is
 * a pure-logic unit test (no PG).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../coordination/presence', () => ({ getPresence: vi.fn() }));

import { enrichBusy } from '../acquire';
import { getPresence } from '../../coordination/presence';
import type { AcquireBusy } from '../su-lock-store';

// The heartbeat placeholder the OMP turn-start hook writes every turn — must be
// treated as "nothing meaningful declared".
const PLACEHOLDER = '(active — see coord:presence for current work)';

const busy = (over: Partial<AcquireBusy> = {}): AcquireBusy =>
  ({
    path: 'lib/a.ts',
    owner: 'A',
    owner_label: 'Agent A',
    intent: 'PreToolUse:Edit',
    expires_ts: new Date('2026-06-02T00:00:00.000Z'),
    ...over,
  }) as AcquireBusy;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const presence = (intent: string, currentFiles: string[] = []): any => ({ intent, currentFiles });

beforeEach(() => vi.mocked(getPresence).mockReset());

describe('enrichBusy', () => {
  it('always returns the base busy fields', async () => {
    vi.mocked(getPresence).mockResolvedValue(null);
    const [r] = await enrichBusy([busy()]);
    expect(r).toMatchObject({
      path: 'lib/a.ts',
      owner: 'A',
      owner_label: 'Agent A',
      expires_ts: '2026-06-02T00:00:00.000Z', // Date → ISO
    });
  });

  it('sets holder_intent from a meaningful declared intent', async () => {
    vi.mocked(getPresence).mockResolvedValue(presence('refactoring the lock store'));
    const [r] = await enrichBusy([busy()]);
    expect(r.holder_intent).toBe('refactoring the lock store');
  });

  it('omits holder_intent for the heartbeat placeholder or an empty intent', async () => {
    vi.mocked(getPresence).mockResolvedValue(presence(PLACEHOLDER));
    expect((await enrichBusy([busy()]))[0].holder_intent).toBeUndefined();
    vi.mocked(getPresence).mockResolvedValue(presence('   '));
    expect((await enrichBusy([busy()]))[0].holder_intent).toBeUndefined();
  });

  it('sets holder_focused when the contended path is in the holder’s currentFiles', async () => {
    vi.mocked(getPresence).mockResolvedValue(presence('x', ['lib/a.ts', 'lib/z.ts']));
    expect((await enrichBusy([busy({ path: 'lib/a.ts' })]))[0].holder_focused).toBe(true);
  });

  it('omits holder_focused when the path is not in currentFiles', async () => {
    vi.mocked(getPresence).mockResolvedValue(presence('x', ['lib/other.ts']));
    expect((await enrichBusy([busy({ path: 'lib/a.ts' })]))[0].holder_focused).toBeUndefined();
  });

  it('is best-effort: a presence miss leaves the row unenriched (no throw, base fields survive)', async () => {
    // enrichBusy maps both a miss (null) AND a lookup error (its `.catch(() =>
    // null)`) to the same unenriched path — so the observable behavior here is
    // identical to a thrown lookup. (A rejecting mock trips vitest-4's
    // unhandled-rejection detector even when caught, so we assert via the miss.)
    vi.mocked(getPresence).mockResolvedValue(null);
    const [r] = await enrichBusy([busy()]);
    expect(r.holder_intent).toBeUndefined();
    expect(r.holder_focused).toBeUndefined();
    expect(r.owner_label).toBe('Agent A'); // base fields survive
  });

  it('looks up presence once per DISTINCT owner, not per row', async () => {
    vi.mocked(getPresence).mockResolvedValue(presence('x'));
    await enrichBusy([
      busy({ owner: 'A', path: 'lib/a.ts' }),
      busy({ owner: 'A', path: 'lib/b.ts' }),
      busy({ owner: 'B', path: 'lib/c.ts' }),
    ]);
    expect(getPresence).toHaveBeenCalledTimes(2); // A and B — not 3
  });
});
