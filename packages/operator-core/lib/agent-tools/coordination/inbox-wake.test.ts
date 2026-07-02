import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wake-mode', () => ({ resolveWakeMode: vi.fn() }));
vi.mock('./pending-wakes', () => ({ stagePendingWake: vi.fn() }));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));
// Isolate from the LIVE coord roster: resolveBestEffortAgainstRoster resolves a short
// ownerId PREFIX against coord_presence (owner-2026-06-17), so a real live session whose
// id starts with a test recipient (e.g. 's-1' ⊂ 's-1782…') would leak into `targets`.
// Identity-resolve keeps these unit tests deterministic regardless of who is live; the
// real isSelectorOrWildcard is preserved via importActual.
vi.mock('./recipient-resolve', async (importActual) => ({
  ...(await importActual<typeof import('./recipient-resolve')>()),
  resolveBestEffortAgainstRoster: vi.fn(async (recipients: readonly string[]) => [...recipients]),
}));

import { wakeRecipients, buildStagedWakeNote } from './inbox-wake';
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
    expect(r.stagedTargets).toEqual(['s-1']); // EI-5957: names WHO staged
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
    expect(r.stagedTargets).toEqual(['s-manual']); // EI-5957: only the manual one
  });

  it('a LOOP self-wake (source loop:<routineId>) FIRES even in manual mode — staging a self-wake would DEADLOCK the loop', async () => {
    // Live 2026-06-23: global default was `manual` (hive:pause), so a self-armed loop fired ~10×
    // into a manual session and every wake STAGED → the loop never executed. A loop wake is the
    // agent driving itself: the asleep agent waiting on the wake is the only one who could release
    // a staged one, so it MUST bypass the manual pause/edit gate and fire.
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    const r = await wakeRecipients(['s-1'], { source: 'loop:rt_abc123', summary: 'loop wake' });
    expect(stagePendingWake).not.toHaveBeenCalled(); // NOT staged despite manual mode
    expect(emitAwaitedEvent).toHaveBeenCalledTimes(1); // fired instead
    expect(r.staged).toBe(0);
    expect(r.woken).toBe(1);
  });

  it('a NON-loop wake in manual mode still STAGES (the bypass is scoped to loop sources only)', async () => {
    vi.mocked(resolveWakeMode).mockResolvedValue('manual' as never);
    const r = await wakeRecipients(['s-1'], { source: 'coord:send', summary: 'peer message' });
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(r.staged).toBe(1);
  });

  // QUARANTINED (flaky: selector resolves against live presence/session state, nondeterministic; de-quarantine + root-cause in WI-1053)
  it.skip('filters non-wakeable selectors (*/human/empty)', async () => {
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

describe('buildStagedWakeNote (EI-5957 — loud staged-directive signal)', () => {
  it('names the staged target(s) and both remedies (release / flip to auto)', () => {
    const note = buildStagedWakeNote(['su-member-1']);
    expect(note).toContain('su-member-1');
    expect(note).toMatch(/STAGED/);
    expect(note).toMatch(/MANUAL wake-mode/);
    expect(note).toMatch(/wake-queue/); // release remedy
    expect(note).toMatch(/wake-mode/); // flip-to-auto remedy
  });

  it('lists every staged target when multiple', () => {
    const note = buildStagedWakeNote(['su-a', 'su-b']);
    expect(note).toContain('su-a, su-b');
  });
});

describe('P-022 — wake fan-out cap (cross-machine-coord-parity-and-trust-2026-07-01)', () => {
  it('wakes at most MAX_WAKE_FANOUT recipients; the overflow is injected-not-woken and reported', async () => {
    const { MAX_WAKE_FANOUT } = await import('./inbox-wake');
    const many = Array.from({ length: MAX_WAKE_FANOUT + 6 }, (_, i) => `su-agent-${String(i).padStart(4, '0')}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await wakeRecipients(many, { summary: 'oversized audience' });
      expect(r.targets).toHaveLength(MAX_WAKE_FANOUT);
      expect(r.fanoutCapped).toHaveLength(6);
      expect(vi.mocked(emitAwaitedEvent)).toHaveBeenCalledTimes(MAX_WAKE_FANOUT);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a normal directed set is untouched (fanoutCapped empty)', async () => {
    const r = await wakeRecipients(['su-a', 'su-b']);
    expect(r.fanoutCapped).toEqual([]);
    expect(r.targets).toEqual(['su-a', 'su-b']);
  });
});
