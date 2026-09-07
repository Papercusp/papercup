/**
 * WI-10000598 — adjudicate-refusal.ts.
 *
 * ⚠ This file is deliberately free of literal credential shapes. It is NOT in
 * secrets-guard.ts's static FIXTURE_FILES set, so a literal here would be
 * scanned by the publish guard, refuse the own-head publish, and — because the
 * guard baseline never advances past a refused range — freeze the hive publish
 * plane permanently, with editing the file afterwards unable to clear it (the
 * blob is already in history). Every "bad" input below is assembled at runtime
 * via the module's own buildPositiveControlSource().
 */
import { describe, it, expect } from 'vitest';
import type { RunGit } from './storage';
import {
  adjudicateRefusal,
  buildPositiveControlSource,
  runPositiveControl,
  formatAdjudication,
  type AdjudicateRefusalResult,
} from './adjudicate-refusal';

const COMMIT = 'abc1234';

/** A RunGit stand-in over an in-memory tree; unlisted paths fail like git does. */
function fakeGit(tree: Record<string, string | { fail: true }>): RunGit {
  return async (args: string[]) => {
    if (args[1] === '--name-only') {
      return { code: 0, stdout: Object.keys(tree).join('\n') + '\n', stderr: '' };
    }
    const spec = args[1] ?? '';
    const path = spec.slice(spec.indexOf(':') + 1);
    const entry = tree[path];
    if (entry === undefined || typeof entry === 'object') {
      return { code: 128, stdout: '', stderr: `fatal: bad object ${spec}` };
    }
    return { code: 0, stdout: entry, stderr: '' };
  };
}

describe('positive control', () => {
  it('assembles its tokens intact — a decayed control would silently pass everything', () => {
    const src = buildPositiveControlSource();
    // The runtime string must really carry the shapes; if a refactor turned the
    // concatenation into inert text this assertion is the thing that notices.
    expect(src).toContain('BEGIN PRIVATE KEY');
    expect(src).toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it('fires on known-bad input, which is what makes a zero-finding result meaningful', () => {
    const control = runPositiveControl();
    expect(control.fired).toBe(true);
    expect(control.findingCount).toBeGreaterThan(0);
  });
});

describe('adjudicateRefusal', () => {
  it('reports findings from the real scanner and counts what it scanned', async () => {
    const r = await adjudicateRefusal({
      commit: COMMIT,
      repoPath: '/repo',
      runGit: fakeGit({ 'src/clean.ts': 'export const a = 1;\n', 'src/bad.ts': buildPositiveControlSource() }),
    });

    expect(r.pathsTouched).toBe(2);
    expect(r.scanned).toBe(2);
    expect(r.blocking.length).toBeGreaterThan(0);
    expect(r.blocking.every((f) => f.path === 'src/bad.ts')).toBe(true);
    expect(r.exempted).toEqual([]);
    expect(r.control.fired).toBe(true);
  });

  it('partitions findings against runtime path exemptions instead of reporting them as blocking', async () => {
    const runGit = fakeGit({ 'src/bad.ts': buildPositiveControlSource() });

    const withoutExemption = await adjudicateRefusal({ commit: COMMIT, repoPath: '/repo', runGit });
    expect(withoutExemption.blocking.length).toBeGreaterThan(0);
    expect(withoutExemption.exempted).toEqual([]);

    const withExemption = await adjudicateRefusal({
      commit: COMMIT,
      repoPath: '/repo',
      runGit,
      exemptions: new Set(['src/bad.ts']),
    });
    expect(withExemption.blocking).toEqual([]);
    expect(withExemption.exempted.length).toBe(withoutExemption.blocking.length);
  });

  it('names unresolvable paths rather than burying them in a count', async () => {
    // A submodule gitlink and a deletion both land here. A bare count cannot
    // distinguish "nothing to scan" from "I failed to scan it".
    const r = await adjudicateRefusal({
      commit: COMMIT,
      repoPath: '/repo',
      runGit: fakeGit({ 'src/ok.ts': 'const a = 1;\n', 'some-submodule': { fail: true } }),
    });

    expect(r.skippedUnresolvable).toEqual(['some-submodule']);
    expect(r.scanned).toBe(1);
  });

  it('skips binary blobs without scanning them', async () => {
    const r = await adjudicateRefusal({
      commit: COMMIT,
      repoPath: '/repo',
      runGit: fakeGit({ 'bin/blob': `PK\x00\x01${buildPositiveControlSource()}` }),
    });

    expect(r.skippedBinary).toBe(1);
    expect(r.scanned).toBe(0);
    expect(r.blocking).toEqual([]);
  });

  it('throws rather than reporting a clean commit when the commit cannot be resolved', async () => {
    const runGit: RunGit = async () => ({ code: 128, stdout: '', stderr: 'fatal: bad object nope' });
    await expect(adjudicateRefusal({ commit: 'nope', repoPath: '/repo', runGit })).rejects.toThrow(/cannot resolve/);
  });
});

describe('formatAdjudication', () => {
  const base: AdjudicateRefusalResult = {
    commit: COMMIT,
    pathsTouched: 1,
    scanned: 1,
    skippedBinary: 0,
    skippedUnresolvable: [],
    fixtureSkipped: [],
    blocking: [],
    exempted: [],
    control: { fired: true, findingCount: 2 },
  };

  it('states the counts are a measurement when the control fired', () => {
    const out = formatAdjudication(base);
    expect(out).toContain('BLOCKING FINDINGS: 0');
    expect(out).toContain('scanner is live');
  });

  it('marks the whole adjudication UNUSABLE when the control did not fire', () => {
    // The load-bearing case: zero findings from a dead scanner must never read
    // as a clean commit, because that is exactly when an exemption gets written.
    const out = formatAdjudication({ ...base, control: { fired: false, findingCount: 0 } });
    expect(out).toContain('DID NOT FIRE');
    expect(out).toContain('UNUSABLE');
    expect(out).toMatch(/do NOT write an exemption/i);
  });
});
