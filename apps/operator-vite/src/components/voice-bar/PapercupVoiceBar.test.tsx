// @vitest-environment jsdom
/**
 * PapercupVoiceBar coverage (voice-unified-sentinel-pipeline-2026-07-01, P-004 —
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
  session: {
    active: false,
    muted: false,
    deafened: false,
    mode: 'off' as 'off' | 'push-to-talk' | 'always-on',
    elected: false,
  },
  setVoiceOutputMuted: vi.fn(),
  toggleOperatorVoiceMute: vi.fn(),
  setOperatorVoiceBusMode: vi.fn(),
  setOperatorVoicePtt: vi.fn(),
  forceOperatorVoiceHost: vi.fn(),
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
  getOperatorVoiceSessionUiState: () => H.session,
  toggleOperatorVoiceMute: () => H.toggleOperatorVoiceMute(),
  setOperatorVoiceBusMode: (mode: 'push-to-talk' | 'always-on') => H.setOperatorVoiceBusMode(mode),
  setOperatorVoicePtt: (down: boolean) => H.setOperatorVoicePtt(down),
  forceOperatorVoiceHost: () => H.forceOperatorVoiceHost(),
}));

import PapercupVoiceBar from './PapercupVoiceBar';

afterEach(() => {
  cleanup();
  H.muted = false;
  H.session = { active: false, muted: false, deafened: false, mode: 'off', elected: false };
  H.setVoiceOutputMuted.mockReset();
  H.toggleOperatorVoiceMute.mockReset();
  H.setOperatorVoiceBusMode.mockReset();
  H.setOperatorVoicePtt.mockReset();
  H.forceOperatorVoiceHost.mockReset();
});

describe('PapercupVoiceBar', () => {
  it('renders the voice-controls region with the persona label + the VoiceButton', () => {
    render(<PapercupVoiceBar />);
    expect(screen.getByRole('region', { name: 'Sentinel voice controls' })).toBeTruthy();
    expect(screen.getByTestId('voice-button')).toBeTruthy();
    expect(screen.getByTestId('audience-mode')).toBeTruthy();
    expect(screen.getByTestId('active-toggle')).toBeTruthy();
  });

  it('hydrates the speaker toggle from the persisted mute flag', () => {
    H.muted = true;
    render(<PapercupVoiceBar />);
    const tts = screen.getByRole('button', { name: 'Unmute Sentinel spoken responses' });
    expect(tts.getAttribute('aria-pressed')).toBe('false');
  });

  it('flips + persists the mute on click', () => {
    render(<PapercupVoiceBar />);
    const tts = screen.getByRole('button', { name: 'Mute Sentinel spoken responses' });
    expect(tts.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tts);
    expect(H.setVoiceOutputMuted).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Unmute Sentinel spoken responses' })).toBeTruthy();
  });

  it('re-syncs when another tab broadcasts a mute change', () => {
    render(<PapercupVoiceBar />);
    fireEvent(
      window,
      new CustomEvent('papercusp:voiceOutputMutedChanged', { detail: { muted: true } }),
    );
    expect(screen.getByRole('button', { name: 'Unmute Sentinel spoken responses' })).toBeTruthy();
  });

  it('renders shared-session controls only while the shared voice session is active', () => {
    const { unmount } = render(<PapercupVoiceBar />);
    expect(screen.queryByRole('button', { name: 'Mute shared microphone' })).toBeNull();

    unmount();
    H.session = { active: true, muted: false, deafened: false, mode: 'always-on', elected: false };
    render(<PapercupVoiceBar />);
    expect(screen.getByRole('button', { name: 'Mute shared microphone' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set shared voice mode to push-to-talk' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Force this rail to host shared voice' })).toBeTruthy();
  });

  it('drives the shared-session affordances through the voice bus helpers', () => {
    H.session = { active: true, muted: false, deafened: false, mode: 'push-to-talk', elected: false };
    render(<PapercupVoiceBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Mute shared microphone' }));
    expect(H.toggleOperatorVoiceMute).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Set shared voice mode to always-on' }));
    expect(H.setOperatorVoiceBusMode).toHaveBeenCalledWith('always-on');

    const talk = screen.getByRole('button', { name: 'Hold shared push-to-talk' });
    fireEvent.mouseDown(talk);
    fireEvent.mouseUp(talk);
    expect(H.setOperatorVoicePtt).toHaveBeenNthCalledWith(1, true);
    expect(H.setOperatorVoicePtt).toHaveBeenNthCalledWith(2, false);

    fireEvent.click(screen.getByRole('button', { name: 'Force this rail to host shared voice' }));
    expect(H.forceOperatorVoiceHost).toHaveBeenCalledTimes(1);
  });

  it('re-syncs the shared-session controls from the runtime event', () => {
    render(<PapercupVoiceBar />);
    fireEvent(
      window,
      new CustomEvent('papercusp:operatorVoiceSessionStateChanged', {
        detail: { active: true, muted: true, deafened: false, mode: 'always-on', elected: true },
      }),
    );
    expect(screen.getByRole('button', { name: 'Unmute shared microphone' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'This rail currently hosts shared voice' })).toBeTruthy();
  });

  it('renders the collapse control only when onCollapse is provided, and fires it', () => {
    const { unmount } = render(<PapercupVoiceBar />);
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();
    unmount();

    const onCollapse = vi.fn();
    render(<PapercupVoiceBar onCollapse={onCollapse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
