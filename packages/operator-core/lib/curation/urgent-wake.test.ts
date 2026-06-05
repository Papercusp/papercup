import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The wake module imports the production deps + coord bus at module load; mock
// them so this is a clean unit test of the debounce coalescing (makeDebouncedRunner).
vi.mock('../coord-inbox-bus', () => ({ onCoordInbox: vi.fn(() => () => {}) }));
vi.mock('./deps', () => ({ buildCurationDeps: vi.fn() }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: vi.fn() }));
vi.mock('../dbos/orchestrator-loop', () => ({ orchestratorWorkspaceIds: vi.fn(() => []) }));
vi.mock('./curation-state', () => ({ writeCurationState: vi.fn() }));

import { makeDebouncedRunner } from './urgent-wake';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('makeDebouncedRunner — leading-edge coalescing', () => {
  it('fires immediately on the first trigger', () => {
    const runner = vi.fn();
    const { trigger } = makeDebouncedRunner(runner, 1000);
    trigger();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into one leading + one trailing fire', () => {
    const runner = vi.fn();
    const { trigger } = makeDebouncedRunner(runner, 1000);
    trigger(); // leading fire
    trigger();
    trigger(); // these collapse into one pending trailing fire
    expect(runner).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('does not fire a trailing tick when no extra triggers arrived', () => {
    const runner = vi.fn();
    const { trigger } = makeDebouncedRunner(runner, 1000);
    trigger();
    vi.advanceTimersByTime(1000);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('cancel() suppresses the pending trailing fire', () => {
    const runner = vi.fn();
    const { trigger, cancel } = makeDebouncedRunner(runner, 1000);
    trigger();
    trigger(); // schedules a trailing fire
    cancel();
    vi.advanceTimersByTime(5000);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('a runner that throws does not break the debounce', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = vi.fn(() => {
      throw new Error('boom');
    });
    const { trigger } = makeDebouncedRunner(runner, 1000);
    expect(() => trigger()).not.toThrow();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
