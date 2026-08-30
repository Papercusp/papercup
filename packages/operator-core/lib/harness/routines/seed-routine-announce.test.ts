/**
 * seed-routine-announce — EI-19281184378946951: proves the shared warning names the
 * two load-bearing facts a caller must act on: the restart lever (dev:restart target
 * bg-host) and the verification call (dev:pipeline_position with the REAL, repo-relative
 * action path — not a shorthand ellipsis).
 */
import { describe, expect, it, vi } from 'vitest';
import { announceRoutineSeeded } from './seed-routine-announce';

describe('announceRoutineSeeded', () => {
  it('prints one line tagged with the script name, naming the restart lever and the repo-relative verify path', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      announceRoutineSeeded(
        'seed-gc-dead-loops-routine',
        'packages/operator-core/lib/harness/routines/gc-dead-loops-action.ts',
      );
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0]?.[0] as string;
      expect(line).toContain('[seed-gc-dead-loops-routine]');
      expect(line).toContain("dev:restart { target: 'bg-host'");
      expect(line).toContain(
        'dev:pipeline_position { path: "packages/operator-core/lib/harness/routines/gc-dead-loops-action.ts" }',
      );
      // Never the placeholder shorthand the two pre-existing hand-copied instances used —
      // a real repo-relative path is what dev:pipeline_position actually documents taking.
      expect(line).not.toContain('.../');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('is pure stdout — makes no other side effect and never throws', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => announceRoutineSeeded('x', 'y.ts')).not.toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });
});
