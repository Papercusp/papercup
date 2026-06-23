/**
 * append-heavy-invalidator (unit) — the debounced change-detector's sweep logic
 * (data-sync-push-completion P-005/D-012). Exercises sweepAppendHeavy with injected
 * maxId/emitChanged seams — no DB, no bus.
 */
import { describe, it, expect, vi } from 'vitest';
import { sweepAppendHeavy } from './append-heavy-invalidator';

const DEDUPE = 5_000;

function setup(maxIdByTable: Record<string, Array<bigint | number | null>>) {
  const calls: Record<string, number> = {};
  const maxId = vi.fn(async (table: string) => {
    const seq = maxIdByTable[table] ?? [];
    const i = (calls[table] ??= 0);
    calls[table] = i + 1;
    return seq[Math.min(i, seq.length - 1)] ?? null;
  });
  const emitted: Array<{ name: string; dedupe: number }> = [];
  const emitChanged = vi.fn(async (name: string, dedupe: number) => {
    emitted.push({ name, dedupe });
  });
  return { maxId, emitChanged, emitted };
}

describe('sweepAppendHeavy', () => {
  it('records a baseline on the FIRST observation and does NOT fire (no boot full-bust)', async () => {
    const { maxId, emitChanged, emitted } = setup({ user_actions: [10n] });
    const lastSeen = new Map<string, bigint>();
    await sweepAppendHeavy(['user_actions'], lastSeen, maxId, emitChanged, DEDUPE);
    expect(emitted).toEqual([]);
    expect(lastSeen.get('user_actions')).toBe(10n);
  });

  it('fires a synthesized <table>.changed (with the dedupe window) when max(id) ADVANCES', async () => {
    const { maxId, emitChanged, emitted } = setup({ user_actions: [10n, 12n] });
    const lastSeen = new Map<string, bigint>();
    await sweepAppendHeavy(['user_actions'], lastSeen, maxId, emitChanged, DEDUPE); // baseline 10
    await sweepAppendHeavy(['user_actions'], lastSeen, maxId, emitChanged, DEDUPE); // → 12, fire
    expect(emitted).toEqual([{ name: 'harness_shared.user_actions.changed', dedupe: DEDUPE }]);
    expect(lastSeen.get('user_actions')).toBe(12n);
  });

  it('does NOT fire when max(id) is unchanged', async () => {
    const { maxId, emitChanged, emitted } = setup({ audit_log: [7n, 7n, 7n] });
    const lastSeen = new Map<string, bigint>();
    await sweepAppendHeavy(['audit_log'], lastSeen, maxId, emitChanged, DEDUPE);
    await sweepAppendHeavy(['audit_log'], lastSeen, maxId, emitChanged, DEDUPE);
    await sweepAppendHeavy(['audit_log'], lastSeen, maxId, emitChanged, DEDUPE);
    expect(emitChanged).not.toHaveBeenCalled();
  });

  it('handles a bigint id that exceeds Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const big = 9007199254740993n; // 2^53 + 1
    const { maxId, emitChanged, emitted } = setup({ toast_log: [big, big + 1n] });
    const lastSeen = new Map<string, bigint>();
    await sweepAppendHeavy(['toast_log'], lastSeen, maxId, emitChanged, DEDUPE);
    await sweepAppendHeavy(['toast_log'], lastSeen, maxId, emitChanged, DEDUPE);
    expect(emitted).toHaveLength(1); // big+1 > big detected (Number() would have collapsed them)
  });

  it('skips an empty table (null max) — no baseline, no fire — then arms when rows appear', async () => {
    const { maxId, emitChanged, emitted } = setup({ harness_hook_logs: [null, 3n, 4n] });
    const lastSeen = new Map<string, bigint>();
    await sweepAppendHeavy(['harness_hook_logs'], lastSeen, maxId, emitChanged, DEDUPE); // null → skip
    expect(lastSeen.has('harness_hook_logs')).toBe(false);
    await sweepAppendHeavy(['harness_hook_logs'], lastSeen, maxId, emitChanged, DEDUPE); // 3 → baseline
    await sweepAppendHeavy(['harness_hook_logs'], lastSeen, maxId, emitChanged, DEDUPE); // 4 → fire
    expect(emitted).toEqual([{ name: 'harness_shared.harness_hook_logs.changed', dedupe: DEDUPE }]);
  });

  it('runtime isEnabled gates the sweep per-tick (off → skip; flip on → resume, no restart)', async () => {
    let enabled = false;
    const maxId = vi.fn(async () => 5n);
    const emitChanged = vi.fn(async () => {});
    let next: (() => void) | null = null;
    const { startAppendHeavyInvalidator } = await import('./append-heavy-invalidator');
    const stop = startAppendHeavyInvalidator({
      tables: ['user_actions'],
      maxId,
      emitChanged,
      isEnabled: () => enabled,
      setTimer: (fn: () => void) => {
        next = fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(maxId).not.toHaveBeenCalled(); // disabled at first tick → skipped (no DB read)
    expect(next).toBeTypeOf('function'); // still ticking → a runtime flip resumes it

    enabled = true;
    next!(); // fire the next tick
    await new Promise((r) => setTimeout(r, 0));
    expect(maxId).toHaveBeenCalledWith('user_actions'); // enabled → swept
    stop();
  });

  it('isolates a per-table query error — other tables still sweep + fire', async () => {
    const maxId = vi.fn(async (table: string) => {
      if (table === 'bad') throw new Error('boom');
      return table === 'good' ? 5n : null;
    });
    const emitted: string[] = [];
    const emitChanged = vi.fn(async (name: string) => void emitted.push(name));
    const onError = vi.fn();
    const lastSeen = new Map<string, bigint>([['good', 4n]]); // good already baselined → will fire
    await sweepAppendHeavy(['bad', 'good'], lastSeen, maxId, emitChanged, DEDUPE, onError);
    expect(onError).toHaveBeenCalledWith('append-heavy:bad', expect.any(Error));
    expect(emitted).toEqual(['harness_shared.good.changed']);
  });
});
