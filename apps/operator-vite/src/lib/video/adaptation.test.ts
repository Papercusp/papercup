import { describe, expect, it } from 'vitest';
import {
  QUALITY_LEVELS,
  VIDEO_TILE_CAP,
  VideoAdapter,
  estimateDownlinkMbps,
  estimateUplinkMbps,
  hiddenTileCount,
  minLevelForPeers,
  shouldDegradeToAudioOnly,
  visibleTileCount,
} from './adaptation';

describe('quality ladder', () => {
  it('is monotonically non-increasing in resolution + bitrate', () => {
    for (let i = 1; i < QUALITY_LEVELS.length; i++) {
      expect(QUALITY_LEVELS[i].width).toBeLessThanOrEqual(QUALITY_LEVELS[i - 1].width);
      expect(QUALITY_LEVELS[i].bitrate).toBeLessThanOrEqual(QUALITY_LEVELS[i - 1].bitrate);
      expect(QUALITY_LEVELS[i].framerate).toBeLessThanOrEqual(QUALITY_LEVELS[i - 1].framerate);
    }
    expect(QUALITY_LEVELS[0]).toMatchObject({ width: 640, height: 360, framerate: 15 });
  });
});

describe('minLevelForPeers', () => {
  it('degrades the floor as peers grow', () => {
    expect(minLevelForPeers(1)).toBe(0);
    expect(minLevelForPeers(2)).toBe(0);
    expect(minLevelForPeers(3)).toBe(1);
    expect(minLevelForPeers(4)).toBe(1);
    expect(minLevelForPeers(5)).toBe(2);
    expect(minLevelForPeers(8)).toBe(2);
    expect(minLevelForPeers(9)).toBe(3);
    expect(minLevelForPeers(50)).toBe(3);
  });
});

describe('tile capping', () => {
  it('caps visible tiles and reports the overflow', () => {
    expect(visibleTileCount(3)).toBe(3);
    expect(visibleTileCount(20)).toBe(VIDEO_TILE_CAP);
    expect(visibleTileCount(0)).toBe(0);
    expect(hiddenTileCount(3)).toBe(0);
    expect(hiddenTileCount(VIDEO_TILE_CAP + 5)).toBe(5);
  });
});

describe('bandwidth estimates', () => {
  it('uplink scales with peer fan-out, downlink with visible tiles', () => {
    const cfg = QUALITY_LEVELS[0]; // 500k
    expect(estimateUplinkMbps(cfg, 4)).toBeCloseTo(2.0, 5); // 0.5 Mbps × 4
    expect(estimateDownlinkMbps(cfg, 2)).toBeCloseTo(1.0, 5);
    expect(estimateUplinkMbps(cfg, 0)).toBe(0);
  });
});

describe('shouldDegradeToAudioOnly', () => {
  it('degrades when WebCodecs missing OR camera unavailable', () => {
    expect(shouldDegradeToAudioOnly({ webCodecsSupported: false })).toBe(true);
    expect(shouldDegradeToAudioOnly({ webCodecsSupported: true, cameraDenied: true })).toBe(true);
    expect(shouldDegradeToAudioOnly({ webCodecsSupported: true, cameraError: true })).toBe(true);
    expect(shouldDegradeToAudioOnly({ webCodecsSupported: true })).toBe(false);
  });
});

describe('VideoAdapter', () => {
  it('starts at the peer-count floor', () => {
    expect(new VideoAdapter(1).config()).toEqual(QUALITY_LEVELS[0]);
    expect(new VideoAdapter(6).config()).toEqual(QUALITY_LEVELS[2]);
  });

  it('onLoss steps down, clamped at the worst level', () => {
    const a = new VideoAdapter(1);
    a.onLoss();
    expect(a.level_()).toBe(1);
    a.onLoss();
    a.onLoss();
    a.onLoss(); // beyond the ladder
    expect(a.level_()).toBe(QUALITY_LEVELS.length - 1);
  });

  it('onClean steps up but never finer than the peer-count floor', () => {
    const a = new VideoAdapter(1);
    a.onLoss();
    a.onLoss(); // level 2
    expect(a.onClean(1).width).toBe(QUALITY_LEVELS[1].width); // up to L1
    expect(a.onClean(1).width).toBe(QUALITY_LEVELS[0].width); // up to L0
    expect(a.onClean(1)).toEqual(QUALITY_LEVELS[0]); // can't go finer than L0
  });

  it('onClean respects a degraded floor from peer count', () => {
    const a = new VideoAdapter(1);
    a.onLoss();
    a.onLoss(); // L2
    a.onClean(6); // floor for 6 peers is L2 → stays at L2
    expect(a.level_()).toBe(2);
  });

  it('setPeerCount degrades when more peers join, never upgrades on its own', () => {
    const a = new VideoAdapter(1); // L0
    a.setPeerCount(9); // floor L3
    expect(a.level_()).toBe(3);
    a.setPeerCount(1); // floor L0, but setPeerCount only degrades — stays L3 until onClean
    expect(a.level_()).toBe(3);
  });
});
