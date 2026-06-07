import { describe, expect, it } from 'vitest';
import { buildVoiceChannelModel, meterPct } from './voice-channel-state';
import type { VoiceChannelState } from '../../lib/voice/desktop-voice-channel-runtime';

function state(overrides: Partial<VoiceChannelState> = {}): VoiceChannelState {
  return {
    connected: true,
    status: null,
    channels: [],
    micLevel: 0,
    micError: null,
    lastError: null,
    ...overrides,
  };
}

describe('buildVoiceChannelModel', () => {
  it('lists channels and marks none active when out of channel', () => {
    const m = buildVoiceChannelModel(
      state({ channels: [{ id: 'vc-1', name: 'dev' }, { id: 'vc-2', name: 'war-room' }] }),
    );
    expect(m.rows).toEqual([
      { id: 'vc-1', name: 'dev', active: false },
      { id: 'vc-2', name: 'war-room', active: false },
    ]);
    expect(m.inChannel).toBeNull();
  });

  it('marks the joined channel active and builds the in-channel view', () => {
    const m = buildVoiceChannelModel(
      state({
        channels: [{ id: 'vc-1', name: 'dev' }],
        status: {
          channel: { id: 'vc-1', name: 'dev' },
          muted: true,
          agentSpeaking: true,
          peers: [
            { id: 'a', label: 'Alice', muted: false, speaking: true, cameraOn: false },
            { id: 'b', label: 'Bob', muted: true, speaking: false, cameraOn: false },
          ],
        },
      }),
    );
    expect(m.rows[0].active).toBe(true);
    expect(m.inChannel).toEqual({
      id: 'vc-1',
      name: 'dev',
      muted: true,
      agentSpeaking: true,
      peers: [
        { id: 'a', label: 'Alice', speaking: true, muted: false },
        { id: 'b', label: 'Bob', speaking: false, muted: true },
      ],
    });
  });

  it('falls back to the channel id when the status has no name', () => {
    const m = buildVoiceChannelModel(
      state({ status: { channel: { id: 'vc-9' }, muted: false, peers: [] } }),
    );
    expect(m.inChannel?.name).toBe('vc-9');
  });

  it('passes mic/connection errors through', () => {
    const m = buildVoiceChannelModel(state({ micError: 'denied', lastError: 'ws down', connected: false }));
    expect(m.micError).toBe('denied');
    expect(m.lastError).toBe('ws down');
    expect(m.connected).toBe(false);
  });
});

describe('meterPct', () => {
  it('is 0 for silence', () => {
    expect(meterPct(0)).toBe(0);
  });
  it('perception-scales quiet speech to a visible bar', () => {
    expect(meterPct(0.04)).toBe(20); // sqrt(0.04)=0.2
  });
  it('caps at 100', () => {
    expect(meterPct(1)).toBe(100);
    expect(meterPct(4)).toBe(100);
  });
});
