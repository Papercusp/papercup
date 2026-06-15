// @vitest-environment jsdom
//
// ProcessesTab — the local-process inspector with a guarded kill flow. Two
// genuine logic surfaces are pinned: (1) the pure killability / kind-parse /
// ordering helpers (protectedReasonFor, parseKinds, sortProcesses, fmtAge),
// and (2) a render-smoke of the KillModal confirm-gate state machine — the
// "type the PID to confirm" guard that arms the destructive button. RichGrid,
// nuqs, Checkbox and Select are mocked so the kill button is reachable without
// the real grid/primitives; fetch is stubbed so no signal escapes.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
vi.mock('nuqs', () => ({
  parseAsString: { withDefault: () => ({}) },
  useQueryState: () => [null, () => {}],
}));
vi.mock('@/app/harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel?: string }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="SIGTERM">SIGTERM</option>
      <option value="SIGKILL">SIGKILL</option>
    </select>
  ),
}));

import {
  protectedReasonFor,
  parseKinds,
  sortProcesses,
  fmtAge,
  KillModal,
  type Process,
  type KillModalState,
} from './ProcessesTab';

afterEach(cleanup);

describe('protectedReasonFor', () => {
  it('returns null (killable) for the three allowlisted kinds', () => {
    expect(protectedReasonFor('run.sh')).toBeNull();
    expect(protectedReasonFor('omp')).toBeNull();
    expect(protectedReasonFor('claude')).toBeNull();
  });
  it('returns the specific protected reason for known protected kinds', () => {
    expect(protectedReasonFor('paperclip')).toMatch(/auto-run loop/);
    expect(protectedReasonFor('next')).toMatch(/this very page/);
    expect(protectedReasonFor('pty')).toMatch(/interactive sessions/);
  });
  it('falls back to the generic allowlist reason for unknown kinds', () => {
    expect(protectedReasonFor('mystery')).toBe('kind not in killable allowlist');
  });
});

describe('parseKinds', () => {
  it('returns an empty set for an empty string', () => {
    expect(parseKinds('').size).toBe(0);
  });
  it('keeps only allowlisted kinds, dropping junk', () => {
    const s = parseKinds('omp,bogus,claude');
    expect([...s].sort()).toEqual(['claude', 'omp']);
  });
});

describe('sortProcesses', () => {
  it('orders by kind rank, then youngest (smallest age) first within a kind', () => {
    const rows = [
      { kind: 'claude', started_seconds_ago: 10 },
      { kind: 'run.sh', started_seconds_ago: 99 },
      { kind: 'omp', started_seconds_ago: 5 },
      { kind: 'claude', started_seconds_ago: 3 },
    ];
    expect(sortProcesses(rows).map((r) => `${r.kind}:${r.started_seconds_ago}`)).toEqual([
      'run.sh:99',
      'omp:5',
      'claude:3',
      'claude:10',
    ]);
  });
  it('sorts unknown kinds to the end (rank 99)', () => {
    const rows = [
      { kind: 'weird', started_seconds_ago: 1 },
      { kind: 'omp', started_seconds_ago: 1 },
    ];
    expect(sortProcesses(rows).map((r) => r.kind)).toEqual(['omp', 'weird']);
  });
});

describe('fmtAge', () => {
  it('renders s / m / h / d boundaries', () => {
    expect(fmtAge(30)).toBe('30s');
    expect(fmtAge(120)).toBe('2m');
    expect(fmtAge(3 * 3600)).toBe('3h');
    expect(fmtAge(2 * 86400)).toBe('2d');
  });
});

const PROC: Process = {
  pid: 4242,
  kind: 'claude',
  cmdline: 'claude --foo',
  cwd: '/tmp/x',
  started_seconds_ago: 12,
  harness_slug: 'my-harness',
  workspace_id: 'default',
};

function renderModal(initial?: Partial<KillModalState>) {
  let state: KillModalState = { process: PROC, confirmText: '', signal: 'SIGTERM', busy: false, result: null, ...initial };
  const setState = vi.fn((s: KillModalState | null) => {
    if (s) state = s;
  });
  const utils = render(<KillModal state={state} setState={setState} />);
  return { setState, getState: () => state, utils };
}

describe('<KillModal /> confirm gate', () => {
  it('disables the destructive send button until the typed text matches the PID', () => {
    renderModal();
    const send = screen.getByRole('button', { name: /send SIGTERM/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('arms the send button once confirmText equals the PID', () => {
    renderModal({ confirmText: '4242' });
    const send = screen.getByRole('button', { name: /send SIGTERM/i });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the button disabled while busy even with a matching PID', () => {
    renderModal({ confirmText: '4242', busy: true });
    const send = screen.getByRole('button', { name: /sending…/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('typing into the confirm input pushes the new confirmText up via setState', () => {
    const { setState } = renderModal();
    fireEvent.change(screen.getByPlaceholderText('4242'), { target: { value: '4242' } });
    expect(setState).toHaveBeenCalledWith(expect.objectContaining({ confirmText: '4242' }));
  });

  it('surfaces the process kind and pid in the modal header', () => {
    renderModal();
    expect(screen.getByText('Kill process 4242?')).toBeTruthy();
    expect(screen.getByText('claude')).toBeTruthy();
  });

  it('clicking cancel clears the modal (setState null)', () => {
    const { setState } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(setState).toHaveBeenCalledWith(null);
  });
});
