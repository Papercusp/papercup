/**
 * Unit tests for the pure provision-stream projections (Brief 54 /
 * structured-streams-not-terminals-2026-06-05 D-003). These cover the logic
 * that replaced the old opaque-xterm render: event stream → typed step list,
 * terminal classification, and the raw-drawer line renderer.
 */
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from './structured-stream-types';
import {
  classifyProvisionTerminal,
  deriveProvisionSteps,
  renderProvisionRawLine,
} from './provision-stream-steps';

let seq = 0;
function ev(kind: string, data: unknown, ts = '2026-06-05T12:00:00.000Z'): StreamEvent {
  return { kind, data, ts, seq: seq++ };
}

describe('deriveProvisionSteps', () => {
  it('opens a running step on setup-started', () => {
    const steps = deriveProvisionSteps([ev('setup-started', { phase: 'setup' }, '2026-06-05T12:00:00.000Z')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'setup', label: 'Setup', status: 'running' });
    expect(steps[0].startedAt).toBe(Date.parse('2026-06-05T12:00:00.000Z'));
  });

  it('resolves a phase to ok on completed, with a duration window', () => {
    const steps = deriveProvisionSteps([
      ev('setup-started', {}, '2026-06-05T12:00:00.000Z'),
      ev('setup-completed', {}, '2026-06-05T12:00:05.000Z'),
    ]);
    expect(steps[0].status).toBe('ok');
    expect(steps[0].endedAt! - steps[0].startedAt!).toBe(5000);
  });

  it('resolves a phase to failed with the failure detail', () => {
    const steps = deriveProvisionSteps([
      ev('verify-started', {}),
      ev('verify-failed', 'exit code 1'),
    ]);
    const verify = steps.find((s) => s.id === 'verify')!;
    expect(verify.status).toBe('failed');
    expect(verify.detail).toBe('exit code 1');
  });

  it('routes output before any phase to a synthetic running Provisioning step', () => {
    const steps = deriveProvisionSteps([ev('script-output', { line: 'hello' })]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'provision', label: 'Provisioning', status: 'running' });
  });

  it('surfaces ::papercusp::progress markers as the running step detail', () => {
    const steps = deriveProvisionSteps([
      ev('setup-started', {}),
      ev('script-output', { line: '::papercusp::progress\tcloning repo\textra' }),
    ]);
    expect(steps.find((s) => s.id === 'setup')!.detail).toBe('cloning repo');
  });

  it('attaches resource-recorded events as notes on the current step', () => {
    const steps = deriveProvisionSteps([
      ev('setup-started', {}),
      ev('resource-recorded', { kind: 'kv-namespace', externalId: 'abc123' }),
    ]);
    expect(steps.find((s) => s.id === 'setup')!.notes).toContain('+ kv-namespace abc123');
  });

  it('produces multiple ordered steps across phases', () => {
    const steps = deriveProvisionSteps([
      ev('setup-started', {}),
      ev('setup-completed', {}),
      ev('verify-started', {}),
      ev('verify-completed', {}),
    ]);
    expect(steps.map((s) => s.id)).toEqual(['setup', 'verify']);
    expect(steps.every((s) => s.status === 'ok')).toBe(true);
  });

  it('records consent-granted as a resolved info step', () => {
    const steps = deriveProvisionSteps([ev('consent-granted', {})]);
    expect(steps.find((s) => s.id === 'consent')).toMatchObject({ status: 'ok' });
  });

  it('is robust to an unmatched completed (no preceding started)', () => {
    const steps = deriveProvisionSteps([ev('setup-completed', {})]);
    expect(steps.find((s) => s.id === 'setup')!.status).toBe('ok');
  });
});

describe('classifyProvisionTerminal', () => {
  it('classifies the *-completed kinds as success', () => {
    for (const k of ['setup-completed', 'teardown-completed', 'verify-completed']) {
      expect(classifyProvisionTerminal(ev(k, {}))).toBe('success');
    }
  });
  it('classifies the *-failed kinds as failed', () => {
    for (const k of ['setup-failed', 'teardown-failed', 'verify-failed']) {
      expect(classifyProvisionTerminal(ev(k, {}))).toBe('failed');
    }
  });
  it('returns null for non-terminal kinds', () => {
    expect(classifyProvisionTerminal(ev('script-output', { line: 'x' }))).toBeNull();
    expect(classifyProvisionTerminal(ev('resource-recorded', {}))).toBeNull();
  });
});

describe('renderProvisionRawLine', () => {
  it('renders a plain script-output line with a timestamp prefix', () => {
    const out = renderProvisionRawLine(ev('script-output', { line: 'build ok' }, '2026-06-05T12:34:56.000Z'));
    expect(out).toContain('12:34:56');
    expect(out).toContain('build ok');
    expect(out!.endsWith('\r\n')).toBe(true);
  });
  it('renders a ✓ for a completed phase', () => {
    expect(renderProvisionRawLine(ev('setup-completed', {}))).toContain('✓ setup-completed');
  });
  it('renders progress markers with a ▸ glyph', () => {
    const out = renderProvisionRawLine(ev('script-output', { line: '::papercusp::progress\tstep one\tdetail' }));
    expect(out).toContain('▸');
    expect(out).toContain('step one');
  });
});
