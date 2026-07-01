// @vitest-environment jsdom
/**
 * AgentInspectorModal.test.tsx — the pinned full-inspector modal opened from the
 * Now-running popover's "Open full inspector" button (previously a dead stub).
 * The SSE transport is mocked so we can drive backfill/event/done and assert the
 * modal renders the shared timeline (reused useAgentThinkingStream + Entry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

type Handlers = Record<string, (data: string, ev?: unknown) => void>;
let captured: { handlers: Handlers; onError?: (e: Error) => void } | null = null;
const closeSpy = vi.fn();
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: { handlers: Handlers; onError?: (e: Error) => void }) => {
    captured = { handlers: opts.handlers, onError: opts.onError };
    return { close: closeSpy };
  },
}));

import AgentInspectorModal from './AgentInspectorModal';

function renderModal(over: Partial<React.ComponentProps<typeof AgentInspectorModal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <AgentInspectorModal
      slug="my-harness"
      phase="production"
      runId="run-abcdef0123456789-tail"
      role="worker"
      open
      onClose={onClose}
      {...over}
    />,
  );
  return { ...utils, onClose };
}

beforeEach(() => { captured = null; closeSpy.mockClear(); });
afterEach(cleanup);

describe('AgentInspectorModal (pinned full inspector)', () => {
  it('opens a stream and shows the run header + connecting empty state', () => {
    renderModal();
    expect(captured).not.toBeNull();
    expect(screen.getByText('worker')).toBeTruthy();
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(screen.getByText(/0 events/)).toBeTruthy();
  });

  it('renders the backfilled timeline and the live event count', () => {
    renderModal();
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'text', text: 'inspector line one' },
        { kind: 'tool_use', toolName: 'Read', toolInput: { file: 'x.ts' } },
      ]));
    });
    expect(screen.getByText('inspector line one')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText(/2 events/)).toBeTruthy();
  });

  it('is not mounted when open=false', () => {
    renderModal(false);
    expect(screen.queryByText('worker')).toBeNull();
  });
});
