// @vitest-environment jsdom
//
// WorkbenchVoicePanel flag-gating (desktop-workbench-shell P-004 / D-005).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Stub the heavy VideoGrid (real one does getUserMedia / WebCodecs / WS).
vi.mock('../voice-video/VideoGrid', () => ({
  default: ({ harnessSlug }: { harnessSlug: string }) => (
    <div data-testid="video-grid-stub">{harnessSlug}</div>
  ),
}));

// Drive the flag from the test.
const flagState = { on: false };
vi.mock('@papercusp/flags/client', () => ({
  useFlag: () => flagState.on,
}));

import { WorkbenchVoicePanel } from './WorkbenchVoicePanel';
import type { PanelComponentProps } from '@/app/harness/dock/panel-registry';

afterEach(cleanup);

function props(params: Record<string, unknown>): PanelComponentProps {
  return {
    panelId: 'p-wb-voice',
    panelType: 'workbench:voice',
    params,
    api: { setParams: () => {}, setTitle: () => {}, close: () => {} },
  };
}

describe('WorkbenchVoicePanel', () => {
  it('hides video + prompts to enable the flag when papercusp-video-channels is off', () => {
    flagState.on = false;
    render(<WorkbenchVoicePanel {...props({ harnessSlug: 'demo' })} />);
    expect(screen.queryByTestId('video-grid-stub')).toBeNull();
    expect(screen.getByText(/Enable papercusp-video-channels/i)).toBeTruthy();
    // The voice seam is always present.
    expect(screen.getByTestId('workbench-voice-seam')).toBeTruthy();
  });

  it('mounts VideoGrid for the active harness when the flag is on', () => {
    flagState.on = true;
    render(<WorkbenchVoicePanel {...props({ harnessSlug: 'demo' })} />);
    expect(screen.getByTestId('video-grid-stub').textContent).toBe('demo');
  });

  it('shows "select a shared harness" when the flag is on but no harness is set', () => {
    flagState.on = true;
    render(<WorkbenchVoicePanel {...props({})} />);
    expect(screen.queryByTestId('video-grid-stub')).toBeNull();
    expect(screen.getByText(/Select a shared harness/i)).toBeTruthy();
  });
});
