// @vitest-environment jsdom
/**
 * SentinelVoiceBar coverage (voice-unified-sentinel-pipeline-2026-07-01, P-004 —
 * this is the ONLY surface that mounts <VoiceButton/>, i.e. what makes the
 * operator-voice round-trip startable, and it had no test). Children are stubbed;
 * this covers the bar's own contract: the region + persona label, the TTS
 * speaker toggle (hydrate → flip → persist → cross-tab event re-sync), and the
 * optional collapse control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  muted: false,
  setVoiceOutputMuted: vi.fn(),
}));

vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => () => 'Sentinel' }));
vi.mock('@/app/_components/AudienceModeSelector', () => ({
  AudienceModeSelector: () => <div data-testid="audience-mode" />,
}));
vi.mock('@/app/_components/OperatorActiveToggle', () => ({
  OperatorActiveToggle: () => <div data-testid="active-toggle" />,
}));
vi.mock('@/app/_components/voice/VoiceButton', () => ({
  VoiceButton: () => <div data-testid="voice-button" />,
}));
vi.mock('@/app/_components/voice/voice-mode', () => ({
  isVoiceOutputMuted: () => H.muted,
  setVoiceOutputMuted: (v: boolean) => H.setVoiceOutputMuted(v),
}));

import SentinelVoiceBar from './SentinelVoiceBar';

afterEach(() => {
  cleanup();
  H.muted = false;
  H.setVoiceOutputMuted.mockReset();
});

describe('SentinelVoiceBar', () => {
  it('renders the voice-controls region with the persona label + the VoiceButton', () => {
    render(<SentinelVoiceBar />);
    expect(screen.getByRole('region', { name: 'Sentinel voice controls' })).toBeTruthy();
    expect(screen.getByTestId('voice-button')).toBeTruthy();
    expect(screen.getByTestId('audience-mode')).toBeTruthy();
    expect(screen.getByTestId('active-toggle')).toBeTruthy();
  });

  it('hydrates the speaker toggle from the persisted mute flag', () => {
    H.muted = true;
    render(<SentinelVoiceBar />);
    const tts = screen.getByRole('button', { name: 'Unmute Sentinel spoken responses' });
    expect(tts.getAttribute('aria-pressed')).toBe('false');
  });

  it('flips + persists the mute on click', () => {
    render(<SentinelVoiceBar />);
    const tts = screen.getByRole('button', { name: 'Mute Sentinel spoken responses' });
    expect(tts.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tts);
    expect(H.setVoiceOutputMuted).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Unmute Sentinel spoken responses' })).toBeTruthy();
  });

  it('re-syncs when another tab broadcasts a mute change', () => {
    render(<SentinelVoiceBar />);
    fireEvent(
      window,
      new CustomEvent('papercusp:voiceOutputMutedChanged', { detail: { muted: true } }),
    );
    expect(screen.getByRole('button', { name: 'Unmute Sentinel spoken responses' })).toBeTruthy();
  });

  it('renders the collapse control only when onCollapse is provided, and fires it', () => {
    const { unmount } = render(<SentinelVoiceBar />);
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();
    unmount();

    const onCollapse = vi.fn();
    render(<SentinelVoiceBar onCollapse={onCollapse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
