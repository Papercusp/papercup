import { describe, test, expect } from 'vitest';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import {
  extractAgentOutput,
  formatInvokeStderr,
  debuggerGateDecision,
  pickReactiveBeforeWorkerRole,
} from './orchestrator-runner';

describe('extractAgentOutput — strip orchestrator timestamp log lines', () => {
  test('drops [2026-…] timestamp lines, keeps the agent body', () => {
    const stdout = [
      '[2026-06-01T04:00:00.000Z] booting invoke-once',
      'NEXT_WORKER',
      'some body text',
      '[2026-06-01T04:00:01.000Z] done',
    ].join('\n');
    expect(extractAgentOutput(stdout)).toBe('NEXT_WORKER\nsome body text');
  });

  test('trims leading/trailing whitespace', () => {
    expect(extractAgentOutput('\n\n  PASS  \n\n')).toBe('PASS');
  });

  test('empty stdout → empty string', () => {
    expect(extractAgentOutput('')).toBe('');
  });
});

describe('formatInvokeStderr — surface child stderr on a failed invoke (P-005)', () => {
  test('null on a clean (exit 0) run even with stderr present', () => {
    expect(formatInvokeStderr('worker', 0, 'some noise on stderr')).toBeNull();
  });

  test('null when exit is non-zero but stderr is empty/whitespace', () => {
    expect(formatInvokeStderr('worker', 1, '')).toBeNull();
    expect(formatInvokeStderr('worker', 1, '   \n  ')).toBeNull();
  });

  test('surfaces the role, exit code, and stderr body on a non-zero exit', () => {
    const out = formatInvokeStderr('director', 1, 'TypeError: paths.map is not a function');
    expect(out).toContain('role=director');
    expect(out).toContain('exited 1');
    expect(out).toContain('TypeError: paths.map is not a function');
  });

  test('this is exactly the throw-before-run case that was previously invisible', () => {
    // The two D-014 runtime bugs threw during subprocess boot → non-zero exit with
    // the message ONLY on stderr (stdout empty). Before P-005 the parent dropped it.
    const colErr = 'error: column "source_plan_slug" does not exist';
    const out = formatInvokeStderr('worker', 1, colErr);
    expect(out).not.toBeNull();
    expect(out).toContain(colErr);
  });

  test('truncates a pathologically long stderr with a marker', () => {
    const huge = 'x'.repeat(10_000);
    const out = formatInvokeStderr('worker', 1, huge)!;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('[stderr truncated: 10000 chars]');
  });
});

describe('debuggerGateDecision — fire the debugger before the worker (P-012)', () => {
  test('fires when enabled, attempts ≥ threshold, and no note exists', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 3, threshold: 3, noteExists: false })).toBe(true);
    expect(debuggerGateDecision({ enabled: true, attempts: 5, threshold: 3, noteExists: false })).toBe(true);
  });

  test('does NOT fire below the threshold', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 2, threshold: 3, noteExists: false })).toBe(false);
    expect(debuggerGateDecision({ enabled: true, attempts: 0, threshold: 3, noteExists: false })).toBe(false);
  });

  test('does NOT fire when a debug note already exists (fires at most once)', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 9, threshold: 3, noteExists: true })).toBe(false);
  });

  test('does NOT fire when the debugger is disabled', () => {
    expect(debuggerGateDecision({ enabled: false, attempts: 9, threshold: 3, noteExists: false })).toBe(false);
  });

  test('honors a custom threshold', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 4, threshold: 5, noteExists: false })).toBe(false);
    expect(debuggerGateDecision({ enabled: true, attempts: 5, threshold: 5, noteExists: false })).toBe(true);
  });
});

describe('pickReactiveBeforeWorkerRole — debugger launch is declarative (unify-launches D-001/D-003)', () => {
  test("the coding blueprint's reactive-before-worker role IS the debugger", () => {
    const coding = loadBuiltinBlueprint('coding').blueprint;
    expect(pickReactiveBeforeWorkerRole(coding.reactive)).toBe('debugger');
  });

  test('a fork that swaps the before-worker reactive role is honored', () => {
    const reactive = [
      { role: 'my-debugger', when: { beforeRole: 'worker', minAttempts: 2 }, preempt: false },
      { role: 'security-reviewer', when: { afterRole: 'worker' }, preempt: false },
    ] as ReturnType<typeof loadBuiltinBlueprint>['blueprint']['reactive'];
    expect(pickReactiveBeforeWorkerRole(reactive)).toBe('my-debugger');
  });

  test("falls back to 'debugger' when no before-worker reactive rule is declared", () => {
    expect(pickReactiveBeforeWorkerRole([])).toBe('debugger');
  });
});
