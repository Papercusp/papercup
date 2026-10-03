import { describe, expect, it } from 'vitest';
import { buildR11TargetQuery, buildR11TimerSpecs, evaluateR11Snapshots, selectR11StageRows, type R11Snapshot } from './r11-window-snapshot';

const at = '2026-10-03T03:00:00.000Z';
const snapshot = (stage: R11Snapshot['stage'], offsetMs: number, rows: Array<{ key: string; stale: boolean }>): R11Snapshot => ({
  stage, capturedAt: new Date(Date.parse(at) + offsetMs).toISOString(), mode: 'gemma', profileId: 'gemma',
  targets: [{ table: 's.t', embedCol: 'embedding', keyCols: ['id'], predicateHash: 'p',
    rows: rows.map((row) => ({ ...row, recency: null })) }],
});
const cut = (24 * 60 - 10) * 60_000;
const end = 24 * 60 * 60_000;

describe('R-11 prospective snapshot', () => {
  it('uses shared sweep predicates and binds mode, exact profile and recipe', () => {
    const target = { table: 's.t', embedCol: 'embedding', bodySql: "coalesce(body, '')", keyCols: ['id'], recipeVersion: 2 };
    const query = buildR11TargetQuery(target, new Set(['id', 'embedding', 'body', 'embedding_mode', 'embedding_profile', 'embedding_recipe']),
      'gemma', { profileId: 'gemma-embeddinggemma-300m-768@v1', targetDims: 768, distanceMetric: 'cosine' });
    expect(query.query).toContain("length(coalesce(body, '')) > 0");
    expect(query.query).toContain('embedding_profile');
    expect(query.query).toContain('embedding_recipe');
    expect(query.params).toContain(2);
  });

  it('checks T0 and in-window eligible cohorts at the frozen T1', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }, { key: '[2]', stale: false }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[1]', stale: true }, { key: '[2]', stale: false }, { key: '[3]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[1]', stale: false }, { key: '[2]', stale: false }, { key: '[3]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('healthy');
    t1.targets[0]!.rows[2]!.stale = true;
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('failed');
  });

  it('keeps only newly eligible keys at Tcut and the frozen cohorts at T1', () => {
    const t0 = [{ key: '[1]', stale: true, recency: null }, { key: '[2]', stale: false, recency: null }];
    const now = [...t0, { key: '[3]', stale: true, recency: null }];
    const newKeys = selectR11StageRows('Tcut', now, t0);
    expect(newKeys.map((row) => row.key)).toEqual(['[3]']);
    expect(selectR11StageRows('T1', now, t0, newKeys).map((row) => row.key)).toEqual(['[1]', '[3]']);
  });

  it('keeps all-zero T0 and late captures inconclusive', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: false }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[1]', stale: false }, { key: '[2]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[2]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
    t0.targets[0]!.rows[0]!.stale = true;
    t1.capturedAt = new Date(Date.parse(at) + end + 61_000).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('freezes two UTC timer deadlines from the T0 database timestamp', () => {
    const t0 = snapshot('T0', 529, [{ key: '[1]', stale: true }]);
    expect(buildR11TimerSpecs(t0)).toEqual([
      { stage: 'Tcut', unit: `r11-p008-tcut-${Math.floor(Date.parse(t0.capturedAt) / 1000)}`,
        at: '2026-10-04 02:50:00 UTC' },
      { stage: 'T1', unit: `r11-p008-t1-${Math.floor(Date.parse(t0.capturedAt) / 1000)}`,
        at: '2026-10-04 03:00:00 UTC' },
    ]);
    expect(() => buildR11TimerSpecs(snapshot('Tcut', 0, []))).toThrow('T0 snapshot');
    t0.capturedAt = 'not-a-timestamp';
    expect(() => buildR11TimerSpecs(t0)).toThrow('invalid database timestamp');
  });

  it('rejects malformed, early and out-of-order cutoff captures', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, []);
    const t1 = snapshot('T1', end, [{ key: '[1]', stale: false }]);
    for (const malformed of ['not-a-timestamp', '', '2026-99-99']) {
      tcut.capturedAt = malformed;
      expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
      tcut.capturedAt = new Date(Date.parse(at) + cut).toISOString();
      t1.capturedAt = malformed;
      expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
      t1.capturedAt = new Date(Date.parse(at) + end).toISOString();
    }
    tcut.capturedAt = new Date(Date.parse(at) - 1).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
    tcut.capturedAt = new Date(Date.parse(at) + cut).toISOString();
    t1.capturedAt = new Date(Date.parse(at) + cut - 1).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('does not pass clause 1 if all originally stale rows leave the eligible set', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[2]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[2]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });
});
