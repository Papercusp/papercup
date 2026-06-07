// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { VoiceChannelState } from '../../lib/voice/desktop-voice-channel-runtime';

// A controllable fake runtime behind the module mock (hoisted: the mock
// factory references it).
const h = vi.hoisted(() => {
  const subs = new Set<(s: unknown) => void>();
  const state = {
    connected: true,
    status: null as unknown,
    channels: [] as Array<{ id: string; name: string }>,
    micLevel: 0,
    micError: null as string | null,
    lastError: null as string | null,
  };
  return {
    subs,
    state,
    runtime: {
      state: () => ({ ...state }),
      subscribe: (cb: (s: unknown) => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      ensureStarted: vi.fn(async () => {}),
      join: vi.fn(),
      leave: vi.fn(),
      setMuted: vi.fn(),
      refreshChannels: vi.fn(),
      createChannel: vi.fn(),
      stop: vi.fn(async () => {}),
    },
    push(patch: Partial<typeof state>) {
      Object.assign(state, patch);
      for (const cb of subs) cb({ ...state });
    },
  };
});

vi.mock('../../lib/voice/desktop-voice-channel-runtime', () => ({
  getVoiceChannelRuntime: () => h.runtime,
}));

import VoiceChannelPanel from './VoiceChannelPanel';

beforeEach(() => {
  vi.clearAllMocks();
  h.state.connected = true;
  h.state.status = null;
  h.state.channels = [];
  h.state.micLevel = 0;
  h.state.micError = null;
  h.state.lastError = null;
});
afterEach(() => cleanup());

function renderPanel(searchParams = '') {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <VoiceChannelPanel />
    </NuqsTestingAdapter>,
  );
}

function push(patch: Partial<VoiceChannelState>) {
  act(() => h.push(patch as never));
}

describe('<VoiceChannelPanel>', () => {
  it('primes the channel list on mount and renders the empty state', () => {
    renderPanel();
    expect(h.runtime.refreshChannels).toHaveBeenCalled();
    expect(screen.getByText(/No channels yet/)).toBeTruthy();
  });

  it('renders channel rows; Join joins via the runtime', () => {
    renderPanel();
    push({ channels: [{ id: 'vc-1', name: 'dev' }, { id: 'vc-2', name: 'war-room' }] });
    expect(screen.getByText('dev')).toBeTruthy();
    expect(screen.getByText('war-room')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Join')[0]);
    expect(h.runtime.join).toHaveBeenCalledWith('vc-1');
  });

  it('deep link ?vchan= joins once connected', () => {
    renderPanel('?vchan=vc-7');
    expect(h.runtime.join).toHaveBeenCalledWith('vc-7');
  });

  it('shows the in-channel session: peers, speaking, agent indicator, meter', () => {
    renderPanel();
    push({
      channels: [{ id: 'vc-1', name: 'dev' }],
      status: {
        channel: { id: 'vc-1', name: 'dev' },
        muted: false,
        agentSpeaking: true,
        peers: [
          { id: 'a', label: 'Alice', muted: false, speaking: true, cameraOn: false },
          { id: 'b', label: 'Bob', muted: true, speaking: false, cameraOn: false },
        ],
      } as never,
      micLevel: 0.04,
    });
    expect(screen.getByTestId('voice-channel-session')).toBeTruthy();
    expect(screen.getByTestId('agent-speaking')).toBeTruthy();
    expect(screen.getByText(/Alice/).textContent).toContain('(speaking)');
    expect(screen.getByText(/Bob/).textContent).toContain('🔇');
    expect(screen.getByRole('meter', { name: /mic level/i }).getAttribute('aria-valuenow')).toBe('20');
    expect(screen.getByText('Leave')).toBeTruthy();
  });

  it('mute / leave drive the runtime', () => {
    renderPanel();
    push({
      channels: [{ id: 'vc-1', name: 'dev' }],
      status: { channel: { id: 'vc-1', name: 'dev' }, muted: false, peers: [] } as never,
    });
    fireEvent.click(screen.getByText(/Mute/));
    expect(h.runtime.setMuted).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText('Leave'));
    expect(h.runtime.leave).toHaveBeenCalled();
  });

  it('creates a channel from the composer and clears the draft', () => {
    renderPanel();
    const input = screen.getByLabelText('New channel name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'standup' } });
    fireEvent.click(screen.getByText('Create'));
    expect(h.runtime.createChannel).toHaveBeenCalledWith('standup');
    expect(input.value).toBe('');
  });

  it('surfaces a mic error as listening-only, not a failure', () => {
    renderPanel();
    push({
      status: { channel: { id: 'vc-1', name: 'dev' }, muted: false, peers: [] } as never,
      micError: 'Permission denied',
    });
    expect(screen.getByText(/Mic unavailable: Permission denied/)).toBeTruthy();
  });
});
