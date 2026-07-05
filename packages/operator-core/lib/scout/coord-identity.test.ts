import { describe, it, expect } from 'vitest';
import {
  scoutCoordOwnerId,
  isScoutCoordOwnerId,
  hiveOfScoutCoordOwnerId,
  SCOUT_COORD_PREFIX,
} from './coord-identity';

describe('scout coord identity (P-003)', () => {
  it('derives a stable scout:<hive> owner id', () => {
    expect(scoutCoordOwnerId('papercusp')).toBe('blender:papercusp');
    expect(scoutCoordOwnerId('shared-hive-test')).toBe('blender:shared-hive-test');
  });

  it('trims whitespace and rejects an empty hive slug', () => {
    expect(scoutCoordOwnerId('  papercusp  ')).toBe('blender:papercusp');
    expect(() => scoutCoordOwnerId('')).toThrow(/per-hive/);
    expect(() => scoutCoordOwnerId('   ')).toThrow(/per-hive/);
  });

  it('round-trips: the identity is recognised + its hive recovered', () => {
    const id = scoutCoordOwnerId('papercusp');
    expect(isScoutCoordOwnerId(id)).toBe(true);
    expect(hiveOfScoutCoordOwnerId(id)).toBe('papercusp');
  });

  it('does not mistake a session id (or the bare prefix) for a scout identity', () => {
    expect(isScoutCoordOwnerId('su-37003884-6dac')).toBe(false);
    expect(isScoutCoordOwnerId('s-1781941290115-34eb51c9')).toBe(false);
    expect(isScoutCoordOwnerId('queen:papercusp')).toBe(false);
    expect(isScoutCoordOwnerId(SCOUT_COORD_PREFIX)).toBe(false); // empty ref
    expect(hiveOfScoutCoordOwnerId('su-37003884-6dac')).toBeNull();
  });
});
