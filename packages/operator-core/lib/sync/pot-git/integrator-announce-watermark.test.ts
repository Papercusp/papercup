/**
 * WI-10003781 — `resolveAnnouncementWatermark`: the integrator's own
 * announcement record is the announce watermark within its publication term;
 * outside that term the local bridge's accepted watermark is used, as before.
 * The end-to-end double-announce regression lives in
 * `integrator-tick.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { resolveAnnouncementWatermark } from './integrator-tick';

const TERM = { epoch: 4, authorityDevice: 'dev-A', storeGeneration: 'sg-1' };
const ANNOUNCED = '2d936ad7f978cf51e2733b22e669bbbaf9bd5478';
const BRIDGE = '54dc17c9332b511ac1adc1926e7ead4ca644aa12';

describe('resolveAnnouncementWatermark (WI-10003781)', () => {
  it('same term: the announced staging wins over a lagging bridge watermark', () => {
    expect(resolveAnnouncementWatermark({ ...TERM, stagingSha: ANNOUNCED }, TERM, BRIDGE)).toBe(ANNOUNCED);
  });

  it('same term, bridge never accepted anything: still the announced staging', () => {
    expect(resolveAnnouncementWatermark({ ...TERM, stagingSha: ANNOUNCED }, TERM, null)).toBe(ANNOUNCED);
  });

  it.each([
    ['a different epoch', { ...TERM, epoch: 3 }],
    ['a different authority device', { ...TERM, authorityDevice: 'dev-B' }],
    ['a different store generation', { ...TERM, storeGeneration: 'sg-0' }],
  ])('a record from %s falls back to the bridge watermark', (_label, priorTerm) => {
    expect(resolveAnnouncementWatermark({ ...priorTerm, stagingSha: ANNOUNCED }, TERM, BRIDGE)).toBe(BRIDGE);
  });

  it('a record written before stagingSha was persisted falls back to the bridge watermark', () => {
    expect(resolveAnnouncementWatermark({ ...TERM }, TERM, BRIDGE)).toBe(BRIDGE);
    expect(resolveAnnouncementWatermark({ ...TERM, stagingSha: null }, TERM, BRIDGE)).toBe(BRIDGE);
  });

  it('no integrator record at all: the bridge watermark, or null for a first announcement', () => {
    expect(resolveAnnouncementWatermark(null, TERM, BRIDGE)).toBe(BRIDGE);
    expect(resolveAnnouncementWatermark(null, TERM, null)).toBeNull();
  });
});
