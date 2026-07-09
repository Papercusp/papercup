/**
 * Unit tests for cue-authority — the structured authority + scope stamp on
 * drain/pause/steer control cues (queen-fleet-authority-boundary-2026-07-02 P-003).
 *
 * The stamp lets a recipient distinguish "a fleet leader draining ITS members" from
 * "the Hive Queen pausing the whole hive" — the provenance whose ABSENCE was the
 * core of the 2026-07-02 incident. These pin the pure derive/render/read core; the
 * IO resolver (cue-authority-resolve) and the emit sites are covered separately.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCueAuthority,
  hiveWideCueAuthority,
  renderCueAuthorityTag,
  readCueAuthority,
  CUE_AUTHORITY_FIELD,
  type CueAuthorityStamp,
} from './cue-authority';

describe('resolveCueAuthority (P-003 — authority derived from the sender role)', () => {
  it('a queen/overwatch session speaks with hive-queen authority, hive-wide scope', () => {
    expect(resolveCueAuthority({ kind: 'mug', potSlug: 'papercusp' })).toEqual({
      authority: 'hive-queen',
      authorityRef: 'papercusp',
      scope: 'hive-wide',
    });
    expect(resolveCueAuthority({ kind: 'kettle', potSlug: 'papercusp' })).toMatchObject({
      authority: 'hive-queen',
      scope: 'hive-wide',
    });
    // A hive-level session even outranks a fleet label it happens to carry.
    expect(
      resolveCueAuthority({ kind: 'mug', potSlug: 'papercusp', fleetRole: 'leader', fleetSlug: 'x' }),
    ).toMatchObject({ authority: 'hive-queen', scope: 'hive-wide' });
  });

  it('a hive-level session with no known hive falls back to a (hive) ref, never empty', () => {
    expect(resolveCueAuthority({ kind: 'mug', potSlug: null })?.authorityRef).toBe('(hive)');
    expect(resolveCueAuthority({ kind: 'kettle', potSlug: '  ' })?.authorityRef).toBe('(hive)');
  });

  it('a fleet leader speaks with fleet-leader authority over its members only', () => {
    expect(
      resolveCueAuthority({ kind: 'su', fleetRole: 'leader', fleetSlug: 'windows-parity' }),
    ).toEqual({
      authority: 'fleet-leader',
      authorityRef: 'windows-parity',
      scope: 'fleet-members',
      scopeRef: 'windows-parity',
    });
  });

  it('no recognized control authority → NO stamp (a bee, a non-leader, a leader without a slug)', () => {
    expect(resolveCueAuthority({ kind: 'cup' })).toBeNull();
    // an owner-directed su session that is NOT a fleet leader
    expect(resolveCueAuthority({ kind: 'su', fleetRole: 'member', fleetSlug: 'ops' })).toBeNull();
    // a leader label without a slug is not addressable → no stamp
    expect(resolveCueAuthority({ kind: 'su', fleetRole: 'leader', fleetSlug: null })).toBeNull();
    expect(resolveCueAuthority({ kind: 'papercup' })).toBeNull();
  });
});

describe('hiveWideCueAuthority (intrinsic hive-level actions — pot:pause / kettle:pause)', () => {
  it('always stamps hive-queen / hive-wide regardless of who triggered it', () => {
    expect(hiveWideCueAuthority('papercusp')).toEqual({
      authority: 'hive-queen',
      authorityRef: 'papercusp',
      scope: 'hive-wide',
    });
    expect(hiveWideCueAuthority(null).authorityRef).toBe('(hive)');
  });
});

describe('renderCueAuthorityTag (the scannable inbox tag)', () => {
  it('renders a hive-wide Queen cue', () => {
    expect(renderCueAuthorityTag({ authority: 'hive-queen', authorityRef: 'papercusp', scope: 'hive-wide' })).toBe(
      'hive-queen(papercusp)→hive-wide',
    );
  });
  it('renders a fleet-leader cue with its members scope', () => {
    expect(
      renderCueAuthorityTag({
        authority: 'fleet-leader',
        authorityRef: 'windows-parity',
        scope: 'fleet-members',
        scopeRef: 'windows-parity',
      }),
    ).toBe('fleet-leader(windows-parity)→fleet-members(windows-parity)');
  });
});

describe('readCueAuthority (defensive envelope reader)', () => {
  it('round-trips a stamp carried on the reserved envelope field', () => {
    const stamp: CueAuthorityStamp = {
      authority: 'fleet-leader',
      authorityRef: 'ops',
      scope: 'fleet-members',
      scopeRef: 'ops',
    };
    const env = { from: 's-lead', summary: 'drain', [CUE_AUTHORITY_FIELD]: stamp };
    expect(readCueAuthority(env)).toEqual(stamp);
  });

  it('returns null for an envelope with no stamp', () => {
    expect(readCueAuthority({ from: 's-1', summary: 'hi' })).toBeNull();
    expect(readCueAuthority({})).toBeNull();
    expect(readCueAuthority(null)).toBeNull();
    expect(readCueAuthority(undefined)).toBeNull();
  });

  it('rejects a malformed/forged stamp (bad enum, empty ref, wrong type) — never throws', () => {
    expect(readCueAuthority({ [CUE_AUTHORITY_FIELD]: { authority: 'god', authorityRef: 'x', scope: 'hive-wide' } })).toBeNull();
    expect(readCueAuthority({ [CUE_AUTHORITY_FIELD]: { authority: 'hive-queen', authorityRef: '', scope: 'hive-wide' } })).toBeNull();
    expect(readCueAuthority({ [CUE_AUTHORITY_FIELD]: { authority: 'hive-queen', authorityRef: 'x', scope: 'galaxy-wide' } })).toBeNull();
    expect(readCueAuthority({ [CUE_AUTHORITY_FIELD]: 'not-an-object' })).toBeNull();
  });

  it('drops a non-string scopeRef but keeps the valid core', () => {
    expect(
      readCueAuthority({ [CUE_AUTHORITY_FIELD]: { authority: 'hive-queen', authorityRef: 'papercusp', scope: 'hive-wide', scopeRef: 42 } }),
    ).toEqual({ authority: 'hive-queen', authorityRef: 'papercusp', scope: 'hive-wide' });
  });
});
