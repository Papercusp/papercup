// @vitest-environment jsdom
/**
 * VoiceTab flag-gating + empty-state coverage (left-sidebar-tauri-2026-06-07).
 *
 * The desktop Voice tab mounts the holepunch VideoGrid (gated on VIDEO_CHANNELS +
 * a resolved shared harness) and the P2P VoiceChannelPanel (gated on VOICE_CHANNELS),
 * plus a deep link to /settings/voice. Both heavy children boot real runtimes, so
 * they're stubbed; the flags + resolved slug are driven from the test. Covers the
 * gating matrix (each flag independently), the per-state empty copy, the settings
 * deep link, and that `active=false` mounts neither child.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  slug: null as string | null,
  navigate: vi.fn(),
}));

vi.mock('@papercusp/flags/client', () => ({ useFlag: (f: string) => H.flags[f] ?? false }));
vi.mock('@/app/adv/create/use-create-data', () => ({ useResolvedHarnessSlug: () => H.slug }));
vi.mock('@papercusp/operator-core/lib/client-navigation', () => ({ navigateClient: H.navigate }));
vi.mock('../voice-video/VideoGrid', () => ({
  default: ({ harnessSlug }: { harnessSlug: string }) => <div data-testid="video-grid">{harnessSlug}</div>,
}));
vi.mock('../voice-video/VoiceChannelPanel', () => ({
  default: () => <div data-testid="voice-channels" />,
}));

import VoiceTab from './VoiceTab';

beforeEach(() => {
  H.flags = {};
  H.slug = null;
  // Clear (don't reassign) — the vi.mock factory bound this exact fn reference.
  H.navigate.mockClear();
});
afterEach(() => cleanup());

describe('<VoiceTab>', () => {
  it('with both flags off, mounts neither child and shows the flag-gated hint', () => {
    render(<VoiceTab active={true} />);
    expect(screen.queryByTestId('video-grid')).toBeNull();
    expect(screen.queryByTestId('voice-channels')).toBeNull();
    expect(screen.getByText(/Peer audio\/video channels are flag-gated/)).toBeTruthy();
  });

  it('mounts the VoiceChannelPanel only when VOICE_CHANNELS is on and active', () => {
    H.flags['papercusp-voice-channels'] = true;
    render(<VoiceTab active={true} />);
    expect(screen.getByTestId('voice-channels')).toBeTruthy();
  });

  it('mounts VideoGrid (with the slug) when VIDEO_CHANNELS is on and a shared harness is resolved', () => {
    H.flags['papercusp-video-channels'] = true;
    H.slug = 'pot-x';
    render(<VoiceTab active={true} />);
    expect(screen.getByTestId('video-grid').textContent).toBe('pot-x');
    // The bar shows the resolved slug.
    expect(screen.getByText(/peers · pot-x/)).toBeTruthy();
  });

  it('prompts to select a shared harness when VIDEO_CHANNELS is on but no slug', () => {
    H.flags['papercusp-video-channels'] = true;
    H.slug = null;
    render(<VoiceTab active={true} />);
    expect(screen.queryByTestId('video-grid')).toBeNull();
    expect(screen.getByText(/Select a shared harness to join its peer channel/)).toBeTruthy();
  });

  it('does not mount the children when the tab is inactive', () => {
    H.flags['papercusp-voice-channels'] = true;
    H.flags['papercusp-video-channels'] = true;
    H.slug = 'pot-x';
    render(<VoiceTab active={false} />);
    expect(screen.queryByTestId('voice-channels')).toBeNull();
    expect(screen.queryByTestId('video-grid')).toBeNull();
  });

  it('the settings button deep-links to the full voice settings', () => {
    render(<VoiceTab active={true} />);
    fireEvent.click(screen.getByLabelText(/Peer audio settings/));
    expect(H.navigate).toHaveBeenCalledWith('/settings/voice');
  });
});
