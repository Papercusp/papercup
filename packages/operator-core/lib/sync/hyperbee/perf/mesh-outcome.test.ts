/**
 * mesh-outcome.test.ts — a netem mesh-formation failure must be RECORDED as a
 * did-not-form cell, not raised as a fatal that crashes the Tier-2 sweep
 * (EI-116 regression).
 */

import { describe, expect, it } from 'vitest';
import {
  MeshFormationError,
  meshDidNotFormArtifact,
  resolveNetemFailure,
} from './mesh-outcome';

describe('MeshFormationError', () => {
  it('is an Error subclass carrying the failed peer index', () => {
    const e = new MeshFormationError('proc mesh: reader 1 never admitted the writer', 1);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(MeshFormationError);
    expect(e.name).toBe('MeshFormationError');
    expect(e.peerIndex).toBe(1);
  });
});

describe('meshDidNotFormArtifact', () => {
  it('records the cell as a did-not-form result with no metrics and a null SLO', () => {
    const a = meshDidNotFormArtifact({
      scenario: 'netem.loss-curve',
      tier: 2,
      params: { rttMs: 150, jitterMs: 10, lossPct: 2, peers: 2, mode: 'loss-curve' },
      reason: 'proc mesh: reader 1 never admitted the writer',
    });
    expect(a.scenario).toBe('netem.loss-curve');
    expect(a.tier).toBe(2);
    expect(a.params.meshFormed).toBe(false);
    // The profile is preserved so the did-not-form cell overlays the loss curve.
    expect(a.params.lossPct).toBe(2);
    expect(Object.keys(a.metrics)).toHaveLength(0);
    expect(a.sloPassed).toBeNull();
    expect(a.notes.some((n) => n.includes('mesh did not form'))).toBe(true);
  });
});

describe('resolveNetemFailure', () => {
  const ctx = {
    scenario: 'netem.loss-curve' as const,
    tier: 2 as const,
    params: { rttMs: 150, jitterMs: 10, lossPct: 2, peers: 2, mode: 'loss-curve' },
  };

  it('folds the EI-116 mesh-formation failure into a recorded artifact (not fatal)', () => {
    const resolved = resolveNetemFailure(
      new MeshFormationError('proc mesh: reader 1 never admitted the writer', 1),
      ctx,
    );
    expect(resolved.kind).toBe('artifact');
    if (resolved.kind !== 'artifact') throw new Error('unreachable');
    expect(resolved.artifact.params.meshFormed).toBe(false);
    expect(resolved.artifact.scenario).toBe('netem.loss-curve');
  });

  it('keeps any other error fatal, with its message preserved', () => {
    const resolved = resolveNetemFailure(new Error('topology setup blew up'), ctx);
    expect(resolved.kind).toBe('fatal');
    if (resolved.kind !== 'fatal') throw new Error('unreachable');
    expect(resolved.message).toContain('topology setup blew up');
  });

  it('stringifies a non-Error throw on the fatal path', () => {
    const resolved = resolveNetemFailure('plain string failure', ctx);
    expect(resolved.kind).toBe('fatal');
    if (resolved.kind !== 'fatal') throw new Error('unreachable');
    expect(resolved.message).toBe('plain string failure');
  });
});
