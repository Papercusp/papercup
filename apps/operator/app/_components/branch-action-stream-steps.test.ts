/**
 * Unit tests for the pure branch-action projections
 * (structured-streams-not-terminals-2026-06-05 D-004, P1). These cover the
 * logic that replaced BranchActionRunner's opaque-xterm render: event stream
 * → typed run row, terminal classification, and the raw-drawer line renderer.
 */
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from './structured-stream-types';
import {
  BRANCH_ACTION_EVENT_KINDS,
  classifyBranchActionTerminal,
  deriveBranchActionSteps,
  renderBranchActionRawLine,
} from './branch-action-stream-steps';

let seq = 0;
function ev(kind: string, data: unknown, ts = '2026-06-10T12:00:00.000Z'): StreamEvent {
  return { kind, data, ts, seq: seq++ };
}

describe('deriveBranchActionSteps', () => {
  it('returns no steps for an empty stream', () => {
    expect(deriveBranchActionSteps([])).toEqual([]);
  });

  it('opens a running run row on action-started, labelled branch/name with a cwd note', () => {
    const steps = deriveBranchActionSteps([
      ev('action-started', { branch: 'staging', name: 'build', cwd: '/work/x' }, '2026-06-10T12:00:00.000Z'),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'run', label: 'staging/build', status: 'running' });
    expect(steps[0].startedAt).toBe(Date.parse('2026-06-10T12:00:00.000Z'));
    expect(steps[0].notes).toContain('cwd: /work/x');
  });

  it('surfaces the latest output line as the running detail', () => {
    const steps = deriveBranchActionSteps([
      ev('action-started', { branch: 'staging', name: 'build', cwd: '/w' }),
      ev('output', { line: 'compiling…' }),
      ev('output', { line: 'linking…' }),
    ]);
    expect(steps[0].detail).toBe('linking…');
  });

  it('surfaces stderr as detail and counts stderr lines in a note', () => {
    const steps = deriveBranchActionSteps([
      ev('action-started', { branch: 'staging', name: 'build', cwd: '/w' }),
      ev('stderr', { line: 'warning: foo' }),
      ev('stderr', { line: 'warning: bar' }),
    ]);
    expect(steps[0].detail).toBe('stderr: warning: bar');
    expect(steps[0].notes).toContain('2 stderr lines');
  });

  it('resolves to ok with exit detail + duration window on action-completed', () => {
    const steps = deriveBranchActionSteps([
      ev('action-started', { branch: 'staging', name: 'smoke', cwd: '/w' }, '2026-06-10T12:00:00.000Z'),
      ev('output', { line: 'all good' }),
      ev('action-completed', { exitCode: 0, durationMs: 5000 }, '2026-06-10T12:00:05.000Z'),
    ]);
    expect(steps[0].status).toBe('ok');
    expect(steps[0].detail).toBe('exit 0');
    expect(steps[0].endedAt! - steps[0].startedAt!).toBe(5000);
  });

  it('resolves to failed with exit detail on action-failed', () => {
    const steps = deriveBranchActionSteps([
      ev('action-started', { branch: 'testing', name: 'deploy', cwd: '/w' }),
      ev('action-failed', { exitCode: 2, durationMs: 1200 }),
    ]);
    expect(steps[0].status).toBe('failed');
    expect(steps[0].detail).toBe('exit 2');
  });

  it('output after the terminal event does not clobber the exit detail', () => {
    const steps = deriveBranchActionSteps([
      ev('action-started', { branch: 'staging', name: 'build', cwd: '/w' }),
      ev('action-completed', { exitCode: 0, durationMs: 10 }),
      ev('output', { line: 'late flush' }),
    ]);
    expect(steps[0].detail).toBe('exit 0');
  });

  it('is robust to output arriving before action-started', () => {
    const steps = deriveBranchActionSteps([ev('output', { line: 'early' })]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'run', label: 'Run', status: 'running', detail: 'early' });
  });
});

describe('classifyBranchActionTerminal', () => {
  it('classifies completed as success and failed as failed', () => {
    expect(classifyBranchActionTerminal(ev('action-completed', {}))).toBe('success');
    expect(classifyBranchActionTerminal(ev('action-failed', {}))).toBe('failed');
  });

  it('returns null for non-terminal kinds', () => {
    for (const k of ['action-started', 'output', 'stderr']) {
      expect(classifyBranchActionTerminal(ev(k, {}))).toBeNull();
    }
  });
});

describe('renderBranchActionRawLine', () => {
  it('renders output lines verbatim (no ts prefix, matching the old xterm view)', () => {
    expect(renderBranchActionRawLine(ev('output', { line: 'hello' }))).toBe('hello\r\n');
  });

  it('renders stderr in red', () => {
    const line = renderBranchActionRawLine(ev('stderr', { line: 'boom' }));
    expect(line).toContain('boom');
    expect(line).toContain('\x1b[31m');
  });

  it('renders the start banner with branch/name + cwd', () => {
    const line = renderBranchActionRawLine(
      ev('action-started', { branch: 'staging', name: 'build', cwd: '/work' }),
    );
    expect(line).toContain('── starting staging/build ──');
    expect(line).toContain('cwd: /work');
  });

  it('renders terminal events with exit code and duration', () => {
    expect(renderBranchActionRawLine(ev('action-completed', { exitCode: 0, durationMs: 42 }))).toContain(
      '✓ completed',
    );
    expect(renderBranchActionRawLine(ev('action-failed', { exitCode: 3, durationMs: 9 }))).toContain('✗ failed');
  });

  it('skips unknown kinds', () => {
    expect(renderBranchActionRawLine(ev('state-set', {}))).toBeNull();
  });
});

describe('BRANCH_ACTION_EVENT_KINDS', () => {
  it('covers the full branch-action vocabulary', () => {
    expect([...BRANCH_ACTION_EVENT_KINDS]).toEqual([
      'action-started',
      'output',
      'stderr',
      'action-completed',
      'action-failed',
    ]);
  });
});
