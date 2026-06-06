import { describe, expect, it } from 'vitest';
import { buildGridModel, pickActiveSpeaker } from './video-grid-state';
import { VIDEO_TILE_CAP } from '../../lib/video/adaptation';
import type { VoicePeerStatus } from '../../lib/video/desktop-video-client';

function peer(id: string, over: Partial<VoicePeerStatus> = {}): VoicePeerStatus {
  return { id, label: id.toUpperCase(), muted: false, speaking: false, cameraOn: false, ...over };
}
const self = { id: 'me', label: 'Me', cameraOn: false, muted: false };

describe('pickActiveSpeaker', () => {
  it('returns the (stable) speaking peer, or null when silent', () => {
    expect(pickActiveSpeaker([peer('a'), peer('b')])).toBeNull();
    expect(pickActiveSpeaker([peer('a'), peer('b', { speaking: true })])).toBe('b');
    // deterministic when multiple speak
    expect(pickActiveSpeaker([peer('z', { speaking: true }), peer('a', { speaking: true })])).toBe('a');
  });
});

describe('buildGridModel', () => {
  it('marks empty with no peers and renders the self tile', () => {
    const m = buildGridModel({ peers: [], self });
    expect(m.empty).toBe(true);
    expect(m.peerTiles).toHaveLength(0);
    expect(m.self.kind).toBe('self');
    expect(m.self.label).toBe('Me');
  });

  it('builds peer tiles sorted by id with the active-speaker flagged', () => {
    const m = buildGridModel({
      peers: [peer('b', { speaking: true, cameraOn: true }), peer('a')],
      self,
    });
    expect(m.empty).toBe(false);
    expect(m.peerTiles.map((t) => t.id)).toEqual(['a', 'b']);
    expect(m.activeSpeakerId).toBe('b');
    expect(m.peerTiles.find((t) => t.id === 'b')!.isActiveSpeaker).toBe(true);
    expect(m.peerTiles.find((t) => t.id === 'a')!.isActiveSpeaker).toBe(false);
    expect(m.peerTiles.find((t) => t.id === 'b')!.cameraOn).toBe(true);
  });

  it('caps visible peer tiles at VIDEO_TILE_CAP and reports the overflow', () => {
    const peers = Array.from({ length: VIDEO_TILE_CAP + 4 }, (_, i) => peer(`p${String(i).padStart(2, '0')}`));
    const m = buildGridModel({ peers, self });
    expect(m.peerTiles).toHaveLength(VIDEO_TILE_CAP);
    expect(m.hiddenCount).toBe(4);
  });

  it('audioOnly forces every tile to an avatar (cameraOn=false)', () => {
    const m = buildGridModel({
      peers: [peer('a', { cameraOn: true })],
      self: { ...self, cameraOn: true },
      audioOnly: true,
    });
    expect(m.peerTiles[0].cameraOn).toBe(false);
    expect(m.self.cameraOn).toBe(false);
  });

  it('carries mute + camera flags through to tiles', () => {
    const m = buildGridModel({
      peers: [peer('a', { muted: true, cameraOn: true })],
      self: { ...self, muted: true, cameraOn: true },
    });
    expect(m.peerTiles[0].muted).toBe(true);
    expect(m.peerTiles[0].cameraOn).toBe(true);
    expect(m.self.muted).toBe(true);
    expect(m.self.cameraOn).toBe(true);
  });
});
