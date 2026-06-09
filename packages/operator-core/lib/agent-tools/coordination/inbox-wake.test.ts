import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { HIVE_AGENT_TABS: 'papercusp-hive-agent-tabs' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('./wake-mode', () => ({ resolveWakeMode: vi.fn() }));
vi.mock('./pending-wakes', () => ({ stagePendingWake: vi.fn() }));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));

import { wakeRecipients } from './inbox-wake';
import { getFlag } from '@papercusp/flags/server';
import { resolveWakeMode } from './wake-mode';
import { stagePendingWake } from './pending-wakes';
import { emitAwaitedEvent } from '../../events/await/engine';

beforeEach(() => {
  vi.mocked(getFlag).mockResolvedValue(false as never); // flag OFF by default
  vi.mocked(resolveWakeMode).mockResolvedValue('auto' as never);
  vi.mocked(stagePendingWake).mockResolvedValue(undefined as never);
  vi.mocked(emitAwaitedEvent).mockResolvedValue({ woken: 1 } as never);
});
afterEach(() => vi.clearAllMocks());

describe('wakeRecipients wake-mode gate (P-007 / D-005)', () => {
  it('flag OFF → fires every wake (shipped behavior), nothing staged, no mode reads', async () => {
    const r = await wakeRecipients(['s-1', 's-2']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(2);
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(resolveWakeMode).not.toHaveBeenCalled(); // gate off → zero mode reads
    expect(r.woken).toBe(2);
    expect(r.staged).toBe(0);
  });

  it('flag ON + auto → fires (no staging)', async () => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(resolveWakeMode).mockResolvedValue('auto' as never);
    const r = await wakeRecipients(['s-1']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(r.staged).toBe(0);
  });

  it('flag ON + manual → STAGES, does NOT fire', async () => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    const r = await wakeRecipients(['s-1'], { summary: 'hi', workspaceId: 'ws-1' });
    expect(stagePendingWake).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 's-1', summary: 'hi', workspaceId: 'ws-1' }),
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(r.woken).toBe(0);
    expect(r.staged).toBe(1);
  });

  it('flag ON + mixed modes → fires auto, stages manual', async () => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(resolveWakeMode).mockImplementation(
      (async (o: string) => (o === 's-manual' ? 'manual' : 'auto')) as never,
    );
    const r = await wakeRecipients(['s-auto', 's-manual']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    expect(r.woken).toBe(1);
    expect(r.staged).toBe(1);
  });

  it('filters non-wakeable selectors (*/human/empty)', async () => {
    const r = await wakeRecipients(['*', 'human', '', 's-1']);
    expect(r.targets).toEqual(['s-1']);
  });

  it('fail-open: a flag-bus error falls back to fire-immediately', async () => {
    vi.mocked(getFlag).mockRejectedValue(new Error('flag bus down') as never);
    const r = await wakeRecipients(['s-1']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(r.staged).toBe(0);
  });
});
