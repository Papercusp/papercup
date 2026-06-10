import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wake-mode', () => ({ resolveWakeMode: vi.fn() }));
vi.mock('./pending-wakes', () => ({ stagePendingWake: vi.fn() }));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));

import { wakeRecipients } from './inbox-wake';
import { resolveWakeMode } from './wake-mode';
import { stagePendingWake } from './pending-wakes';
import { emitAwaitedEvent } from '../../events/await/engine';

beforeEach(() => {
  vi.mocked(resolveWakeMode).mockResolvedValue('auto' as never);
  vi.mocked(stagePendingWake).mockResolvedValue(undefined as never);
  vi.mocked(emitAwaitedEvent).mockResolvedValue({ woken: 1 } as never);
});
afterEach(() => vi.clearAllMocks());

// The gate is GRADUATED off the HIVE_AGENT_TABS flag (start-hive-wake P-007 /
// OQ-2): it is the hive's PAUSE primitive, so it holds unconditionally — the
// resolved wake-mode alone decides fire-vs-stage. Default (everything `auto`)
// remains the shipped fire-immediately behavior.
describe('wakeRecipients wake-mode gate (hive-agent-tabs D-005, graduated by start-hive P-007)', () => {
  it('default (auto) → fires every wake, nothing staged', async () => {
    const r = await wakeRecipients(['s-1', 's-2']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(2);
    expect(stagePendingWake).not.toHaveBeenCalled();
    expect(r.woken).toBe(2);
    expect(r.staged).toBe(0);
  });

  it('manual → STAGES, does NOT fire (the Pause path — no flag involved)', async () => {
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    const r = await wakeRecipients(['s-1'], { summary: 'hi', workspaceId: 'ws-1' });
    expect(stagePendingWake).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 's-1', summary: 'hi', workspaceId: 'ws-1' }),
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(r.woken).toBe(0);
    expect(r.staged).toBe(1);
  });

  it('mixed modes → fires auto, stages manual', async () => {
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

  it('fail-open: an unreadable mode store falls back to fire-immediately', async () => {
    vi.mocked(resolveWakeMode).mockRejectedValue(new Error('mode store down') as never);
    const r = await wakeRecipients(['s-1']);
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    expect(r.staged).toBe(0);
  });
});
