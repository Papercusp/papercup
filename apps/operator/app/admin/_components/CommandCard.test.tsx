// @vitest-environment jsdom
//
// CommandCard — a streaming command runner card. The genuine pure logic is
// formatMs (elapsed-span formatting, extracted + exported); the render-smoke
// drives the idle → running → done state machine by intercepting the mocked
// createResilientEventSource and firing its meta/log/exit handlers, asserting
// the status pill + log surface. @papercusp/sse is mocked so no real SSE opens.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';

type Handlers = Record<string, (data: string) => void>;
const { sse } = vi.hoisted(() => ({ sse: { handlers: null as Handlers | null, closed: false } }));

vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: ({ handlers }: { handlers: Handlers }) => {
    sse.handlers = handlers;
    sse.closed = false;
    return { close: () => { sse.closed = true; } };
  },
}));

// Tooltip + Checkbox are app primitives, not under test — render passthroughs.
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/app/harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));

import CommandCard, { formatMs, type CommandSpec } from './CommandCard';

beforeEach(() => {
  sse.handlers = null;
  sse.closed = false;
});
afterEach(cleanup);

describe('formatMs (pure)', () => {
  it('renders whole seconds under a minute', () => {
    expect(formatMs(5_000)).toBe('5s');
    expect(formatMs(59_400)).toBe('59s');
  });
  it('renders "NmSSs" past a minute, zero-padding seconds', () => {
    expect(formatMs(2 * 60_000 + 4_000)).toBe('2m04s');
    expect(formatMs(10 * 60_000 + 30_000)).toBe('10m30s');
  });
  it('renders "NhMMm" past an hour, zero-padding minutes', () => {
    expect(formatMs(1 * 3_600_000 + 5 * 60_000)).toBe('1h05m');
  });
});

const SPEC: CommandSpec = {
  id: 'build-x',
  label: 'Build X',
  section: 'building',
  description: 'builds the thing',
  command: 'npm run build',
  cwd: 'apps/x',
};

describe('<CommandCard />', () => {
  it('starts idle with a Run button and the description', () => {
    render(<CommandCard spec={SPEC} />);
    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
    expect(screen.getByText('builds the thing')).toBeTruthy();
  });

  it('toggles to running on Run and shows a Stop button', () => {
    render(<CommandCard spec={SPEC} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(sse.handlers).not.toBeNull();
  });

  it('appends log lines and reaches "exit 0" when the exit handler reports code 0', () => {
    render(<CommandCard spec={SPEC} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    act(() => {
      sse.handlers!.log(JSON.stringify({ stream: 'stdout', line: 'compiling…' }));
      sse.handlers!.exit(JSON.stringify({ code: 0, signal: null }));
    });
    expect(screen.getByText('compiling…')).toBeTruthy();
    expect(screen.getByText('exit 0')).toBeTruthy();
  });

  it('shows an error pill when the command exits non-zero', () => {
    render(<CommandCard spec={SPEC} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    act(() => {
      sse.handlers!.exit(JSON.stringify({ code: 2, signal: null }));
    });
    expect(screen.getByText('exit 2')).toBeTruthy();
  });

  it('reveals the resolved shell command (with cwd prefix) on "Show cmd"', () => {
    render(<CommandCard spec={SPEC} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show cmd' }));
    expect(screen.getByText('cd apps/x && npm run build')).toBeTruthy();
  });

  it('closes the stream and marks cancelled when Stop is clicked', () => {
    render(<CommandCard spec={SPEC} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sse.closed).toBe(true);
    expect(screen.getByText('stopped')).toBeTruthy();
  });
});
