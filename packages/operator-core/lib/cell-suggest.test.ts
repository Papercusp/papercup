/**
 * P-002 + P-003 of state-plane-interest-and-hardening-2026-08-21.
 *
 * The two properties that matter here are ADVERSARIAL, not cosmetic:
 *   1. aftercare must never name a cell the reader may not see (P-019's
 *      non-oracle property — a "did you mean" over the full registry would leak
 *      precisely what `absent` exists to hide);
 *   2. `self` must resolve ONLY for identity-keyed cells — resolving it for a
 *      per-PATH cell would silently answer about a file named "self".
 *
 * The guess strings below are the REAL misses measured in tool_invocations over
 * the plane's first two weeks, not invented ones.
 */
import { describe, it, expect } from 'vitest';
import {
  absentReadAftercare,
  cellNameSimilarity,
  declaredNonCellKeys,
  isIdentityParam,
  resolveSelfSubject,
} from './cell-suggest';
import type { CellSpec } from './cell-registry';

const visible = (...ids: string[]) => ids.map((cell) => ({ cell }) as CellSpec);

const GATE_CELLS = visible(
  'gate.greenCheckpoint.verdict',
  'gate.greenCheckpoint.candidate',
  'gate.greenCheckpoint.ownership',
  'deploy.3070.sha',
  'git.mainBehindStaging',
  'host.memoryPressure',
);

describe('absentReadAftercare — navigation help on a refusal that stays an information dead end', () => {
  it('answers a real measured miss (`gate.greenCheckpoint`, 1 call) with the leaf cells, not a fuzzy guess', () => {
    const out = absentReadAftercare('gate.greenCheckpoint', GATE_CELLS);
    expect(out.notACell).toMatch(/namespace, not a cell/i);
    expect(out.notACell).toContain('gate.greenCheckpoint.verdict');
    // A declared answer must never be rendered alongside a guessed one.
    expect(out.didYouMean).toBeUndefined();
  });

  it('redirects `host.load` (2 real callers) to the orient payload rather than the nearest cell name', () => {
    const out = absentReadAftercare('host.load', GATE_CELLS);
    expect(out.notACell).toMatch(/coord:orient/);
    expect(out.didYouMean).toBeUndefined();
  });

  it('suggests near-miss cells for a typo-shaped guess', () => {
    const out = absentReadAftercare('gate.greenCheckpoint.noSuchCellZZQQ', GATE_CELLS);
    expect(out.didYouMean?.length).toBeGreaterThan(0);
    expect(out.didYouMean?.every((c) => c.startsWith('gate.greenCheckpoint.'))).toBe(true);
  });

  it('NEVER names a cell outside the caller\'s directory — the P-019 non-oracle property', () => {
    // The caller sees only host.memoryPressure; the gate cells exist but are not theirs.
    const narrowView = visible('host.memoryPressure');
    const out = absentReadAftercare('gate.greenCheckpoint.verdict', narrowView);
    expect(JSON.stringify(out)).not.toContain('gate.greenCheckpoint.verdict');
    expect(out.didYouMean ?? []).not.toContain('gate.greenCheckpoint.verdict');
  });

  it('says NOTHING when nothing is close — an empty "did you mean" reads as a broken feature', () => {
    expect(absentReadAftercare('completely.unrelated.nonsense', GATE_CELLS)).toEqual({});
    expect(absentReadAftercare('anything', [])).toEqual({});
  });

  it('caps suggestions to a readable few', () => {
    const many = visible(...Array.from({ length: 20 }, (_, i) => `gate.greenCheckpoint.leaf${i}`));
    expect((absentReadAftercare('gate.greenCheckpoint.leaf', many).didYouMean ?? []).length).toBeLessThanOrEqual(3);
  });

  it('is deterministic — the same guess orders the same way twice (no spurious diff between reads)', () => {
    const a = absentReadAftercare('gate.greenCheckpoint.verdictt', GATE_CELLS);
    const b = absentReadAftercare('gate.greenCheckpoint.verdictt', GATE_CELLS);
    expect(a).toEqual(b);
  });

  it('scores an exact-ish name above an unrelated one (the ordering the suggestion rests on)', () => {
    expect(cellNameSimilarity('deploy.3070.sha', 'deploy.3070.sha')).toBeGreaterThan(
      cellNameSimilarity('deploy.3070.sha', 'host.memoryPressure'),
    );
  });
});

describe('declaredNonCellKeys — the redirect table cannot shadow a real cell', () => {
  it('exposes its keys for the registry-collision guard', () => {
    const keys = declaredNonCellKeys();
    expect(keys).toContain('host.load');
    expect(keys.every((k) => k === k.toLowerCase())).toBe(true);
  });
});

describe('resolveSelfSubject — P-003, and the trap it must not fall into', () => {
  const identityCell = { callerRelativity: { kind: 'parameter', param: 'ownerId' } } as Pick<CellSpec, 'callerRelativity'>;
  const pathCell = { callerRelativity: { kind: 'parameter', param: 'path' } } as Pick<CellSpec, 'callerRelativity'>;
  const globalCell = { callerRelativity: { kind: 'global' } } as Pick<CellSpec, 'callerRelativity'>;

  it('resolves "self" to the caller\'s ownerId for an identity-keyed cell', () => {
    expect(resolveSelfSubject('self', identityCell, 'su-me')).toBe('su-me');
    expect(resolveSelfSubject('SELF', identityCell, 'su-me')).toBe('su-me');
  });

  it('does NOT resolve "self" for a per-PATH cell — it would answer about a file named "self"', () => {
    expect(resolveSelfSubject('self', pathCell, 'su-me')).toBe('self');
  });

  it('leaves every other subject untouched, and passes an absent subject through', () => {
    expect(resolveSelfSubject('su-someone-else', identityCell, 'su-me')).toBe('su-someone-else');
    expect(resolveSelfSubject('libs/flags/src/types.ts', pathCell, 'su-me')).toBe('libs/flags/src/types.ts');
    expect(resolveSelfSubject(undefined, identityCell, 'su-me')).toBeUndefined();
    expect(resolveSelfSubject('self', globalCell, 'su-me')).toBe('self');
  });

  it('recognises the identity param spellings and rejects subject-shaped ones', () => {
    expect(isIdentityParam('ownerId')).toBe(true);
    expect(isIdentityParam('owner_id')).toBe(true);
    expect(isIdentityParam('path')).toBe(false);
    expect(isIdentityParam('slug')).toBe(false);
  });
});
