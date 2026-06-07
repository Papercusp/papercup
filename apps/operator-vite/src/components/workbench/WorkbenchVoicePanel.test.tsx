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

// Stub the voice-channels panel too (real one boots the voice runtime and
// reads nuqs query state, neither of which exists in this jsdom unit).
vi.mock('../voice-video/VoiceChannelPanel', () => ({
  default: () => <div data-testid="voice-channels-stub" />,
}));

// Drive the flags from the test, per flag key — the pane reads BOTH
// papercusp-video-channels and papercusp-voice-channels, independently.
const flagState: Record<string, boolean> = {};
vi.mock('@papercusp/flags/client', () => ({
  useFlag: (flag: string) => flagState[flag] ?? false,
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
  afterEach(() => {
    for (const k of Object.keys(flagState)) delete flagState[k];
  });

  it('hides video + prompts to enable the flag when papercusp-video-channels is off', () => {
    render(<WorkbenchVoicePanel {...props({ harnessSlug: 'demo' })} />);
    expect(screen.queryByTestId('video-grid-stub')).toBeNull();
    expect(screen.getByText(/Enable papercusp-video-channels/i)).toBeTruthy();
    // The voice seam is always present.
    expect(screen.getByTestId('workbench-voice-seam')).toBeTruthy();
  });

  it('mounts VideoGrid for the active harness when the flag is on', () => {
    flagState['papercusp-video-channels'] = true;
    render(<WorkbenchVoicePanel {...props({ harnessSlug: 'demo' })} />);
    expect(screen.getByTestId('video-grid-stub').textContent).toBe('demo');
  });

  it('shows "select a shared harness" when the flag is on but no harness is set', () => {
    flagState['papercusp-video-channels'] = true;
    render(<WorkbenchVoicePanel {...props({})} />);
    expect(screen.queryByTestId('video-grid-stub')).toBeNull();
    expect(screen.getByText(/Select a shared harness/i)).toBeTruthy();
  });

  it('mounts the voice-channels panel only when papercusp-voice-channels is on', () => {
    render(<WorkbenchVoicePanel {...props({ harnessSlug: 'demo' })} />);
    expect(screen.queryByTestId('voice-channels-stub')).toBeNull();
    expect(screen.getByText(/universal-voice-interface/i)).toBeTruthy();
    cleanup();
    flagState['papercusp-voice-channels'] = true;
    render(<WorkbenchVoicePanel {...props({ harnessSlug: 'demo' })} />);
    expect(screen.getByTestId('voice-channels-stub')).toBeTruthy();
  });
});
