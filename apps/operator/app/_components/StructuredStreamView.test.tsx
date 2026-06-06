// @vitest-environment jsdom
/**
 * StructuredStreamView render tests (Brief 54 /
 * structured-streams-not-terminals-2026-06-05 D-002).
 *
 * Covers the typed-step rendering, the "show only failures" filter, and the
 * raw-output drawer toggle. The SSE client (@papercusp/sse) and xterm are
 * mocked — these tests exercise the view, not the live transport. The step
 * projection itself is covered separately (provision-stream-steps.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StreamStep } from './structured-stream-types';

// SSE: a no-op source so the subscription effect doesn't touch the network.
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: () => ({ status: 'open', close: vi.fn(), setUrl: vi.fn() }),
}));

// xterm: stubbed so the raw drawer can mount under jsdom without a real term.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    write() {}
    dispose() {}
    open() {}
    loadAddon() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { StructuredStreamView } from './StructuredStreamView';

const STEPS: StreamStep[] = [
  { id: 'setup', label: 'Setup', status: 'ok', startedAt: 0, endedAt: 1000, notes: ['+ kv ns-1'] },
  { id: 'verify', label: 'Verify', status: 'failed', startedAt: 0, endedAt: 2000, detail: 'boom', notes: [] },
];

function renderView(steps: StreamStep[] = STEPS) {
  return render(
    <StructuredStreamView url="/api/test/stream" eventKinds={['x']} deriveSteps={() => steps} />,
  );
}

afterEach(() => cleanup());

describe('StructuredStreamView', () => {
  it('renders a typed step row per derived step', () => {
    renderView();
    expect(screen.getByText('Setup')).toBeTruthy();
    expect(screen.getByText('Verify')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy(); // failure detail
    expect(screen.getByText('+ kv ns-1')).toBeTruthy(); // note
  });

  it('"show only failures" hides non-failed steps', () => {
    renderView();
    expect(screen.getByText('Setup')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByText('Setup')).toBeNull();
    expect(screen.getByText('Verify')).toBeTruthy(); // the failed one stays
  });

  it('exposes a raw-output drawer toggle (the escape hatch)', () => {
    renderView();
    const toggle = screen.getByText(/raw output/);
    expect(toggle.textContent).toContain('▸'); // closed
    fireEvent.click(toggle);
    expect(screen.getByText(/raw output/).textContent).toContain('▾'); // open
  });

  it('shows an empty state when there are no steps', () => {
    renderView([]);
    // The ellipsis (…) distinguishes the empty-state text from the footer's
    // bare "status: connecting".
    expect(screen.getByText(/waiting for output…|connecting…/)).toBeTruthy();
  });
});
