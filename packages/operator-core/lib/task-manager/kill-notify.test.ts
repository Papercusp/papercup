/**
 * EI-21905196224862433 — unit coverage for the kill-intent pub/sub bridge
 * itself (see kill-notify.ts's header for the full root-cause writeup).
 * bash-jobs.test.ts covers the actual capability:bash consumer wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetKillNotifyListenersForTest, notifyTaskKillRequested, onTaskKillRequested } from './kill-notify';

afterEach(() => _resetKillNotifyListenersForTest());

describe('kill-notify', () => {
  it('delivers taskId + signal to a subscribed listener', () => {
    const calls: Array<[string, NodeJS.Signals]> = [];
    onTaskKillRequested((taskId, signal) => calls.push([taskId, signal]));

    notifyTaskKillRequested('task-1', 'SIGTERM');

    expect(calls).toEqual([['task-1', 'SIGTERM']]);
  });

  it('delivers to every subscribed listener, in registration order', () => {
    const order: string[] = [];
    onTaskKillRequested(() => order.push('a'));
    onTaskKillRequested(() => order.push('b'));

    notifyTaskKillRequested('task-1', 'SIGKILL');

    expect(order).toEqual(['a', 'b']);
  });

  it('unsubscribe stops further delivery to that listener only', () => {
    const calls: string[] = [];
    const unsubscribe = onTaskKillRequested(() => calls.push('first'));
    onTaskKillRequested(() => calls.push('second'));

    unsubscribe();
    notifyTaskKillRequested('task-1', 'SIGTERM');

    expect(calls).toEqual(['second']);
  });

  it('a throwing listener does not prevent delivery to other listeners, and does not throw out of notify', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const calls: string[] = [];
      onTaskKillRequested(() => {
        throw new Error('boom');
      });
      onTaskKillRequested(() => calls.push('second'));

      expect(() => notifyTaskKillRequested('task-1', 'SIGTERM')).not.toThrow();
      expect(calls).toEqual(['second']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    } finally {
      warn.mockRestore();
    }
  });

  it('notifying with no subscribers is a no-op', () => {
    expect(() => notifyTaskKillRequested('task-1', 'SIGTERM')).not.toThrow();
  });
});
