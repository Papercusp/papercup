import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  markFrozenRepairVerificationRed,
  parseFrozenCandidateRepairQueue,
  recordFrozenRepairSupersededRed,
  selectFrozenRepairAdmissionPaths,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from './frozen-candidate-repair-queue';

const C = 'a'.repeat(40);
const H1 = 'b'.repeat(40);
const H2 = 'c'.repeat(40);
const H3 = 'd'.repeat(40);
const admission = (fromRepairHead: string, toRepairHead: string, p: string): FrozenRepairAdmission => ({
  fromRepairHead, toRepairHead, paths: [p], unchanged: [], blobs: { [p]: 'e'.repeat(40) },
  source: { ref: 'staging', sha: 'e'.repeat(40) }, atMs: 2, actor: 'test',
});
function queue(): FrozenCandidateRepairQueue {
  return {
    ...createFrozenCandidateRepairQueue({ candidate: C, base: 'f'.repeat(40), failingTests: ['lint:x'], nowMs: 1 }),
    phase: 'ready-to-verify', repairHead: H3,
    admissions: [admission(C, H1, 'lib/old.ts'), admission(H1, H2, 'lib/new.ts'), admission(H2, H3, 'lib/third.ts')],
    selectiveCoverage: { schemaVersion: 1, candidate: C, head: H1 },
  };
}

describe('head-bound selective coverage', () => {
  it('selects only newly admitted paths after complete coverage', () => {
    expect(selectFrozenRepairAdmissionPaths(queue())).toEqual({
      paths: ['lib/new.ts', 'lib/third.ts'], mode: 'delta', reason: 'complete-admission-suffix',
      coverageComplete: true,
    });
  });
  it('keeps a repeated changed path and shared semantic input in the new radius', () => {
    const q = queue();
    q.admissions = [admission(C, H1, 'lib/old.ts'), admission(H1, H2, 'lib/old.ts'), admission(H2, H3, 'libs/test-config/src/lane-split.ts')];
    expect(selectFrozenRepairAdmissionPaths(q).paths).toEqual(['lib/old.ts', 'libs/test-config/src/lane-split.ts']);
  });
  it.each(['missing', 'foreign-candidate', 'version', 'head', 'gap', 'cap', 'blob', 'path', 'cycle'] as const)(
    'falls back wider for %s evidence',
    (kind) => {
      const q = queue();
      if (kind === 'missing') delete q.selectiveCoverage;
      if (kind === 'foreign-candidate') q.selectiveCoverage!.candidate = H2;
      if (kind === 'version') (q.selectiveCoverage as { schemaVersion: number }).schemaVersion = 2;
      if (kind === 'head') q.selectiveCoverage!.head = 'invalid';
      if (kind === 'gap') q.admissions = [q.admissions![0]!, q.admissions![2]!];
      if (kind === 'cap') q.admissions = [q.admissions![2]!];
      if (kind === 'blob') q.admissions![1]!.blobs = {};
      if (kind === 'path') q.admissions![1]!.paths = ['../escape'];
      if (kind === 'cycle') q.admissions![2]!.toRepairHead = H1;
      expect(selectFrozenRepairAdmissionPaths(q).mode).toBe('cumulative');
    },
  );
  it('round-trips optional coverage without making legacy or damaged queues disappear', () => {
    const q = queue();
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(q)))?.selectiveCoverage).toEqual(q.selectiveCoverage);
    expect(parseFrozenCandidateRepairQueue({ ...q, selectiveCoverage: { head: H1 } })).toBeTruthy();
    expect(parseFrozenCandidateRepairQueue({ ...q, selectiveCoverage: { head: H1 } })?.selectiveCoverage).toBeUndefined();
  });
  it('stores complete coverage only through the exact-head verdict transition', () => {
    const q = queue();
    const coverage = { schemaVersion: 1 as const, candidate: C, head: H3 };
    const out = markFrozenRepairVerificationRed(q, { repairHead: H3, nowMs: 3, failingTests: ['lint:x'], selectiveCoverage: coverage });
    expect(out.selectiveCoverage).toEqual(coverage);
    expect(selectFrozenRepairAdmissionPaths(out)).toMatchObject({ paths: [], mode: 'delta' });
    expect(() => markFrozenRepairVerificationRed(q, { repairHead: H2, nowMs: 3, selectiveCoverage: coverage })).toThrow();
    expect(() => markFrozenRepairVerificationRed(q, { repairHead: H3, nowMs: 3, selectiveCoverage: { ...coverage, head: H2 } })).toThrow();
  });
  it('preserves the earlier receipt when a later verdict has no complete coverage', () => {
    const q = queue();
    const out = markFrozenRepairVerificationRed(q, { repairHead: H3, nowMs: 3, failingTests: ['lint:x'] });
    expect(out.selectiveCoverage).toEqual(q.selectiveCoverage);
    expect(selectFrozenRepairAdmissionPaths(out).paths).toContain('lib/new.ts');
  });
  it('a superseded measurement cannot certify the newer admitted head', () => {
    const q = queue();
    const out = recordFrozenRepairSupersededRed(q, { measuredHead: H2, nowMs: 3, failingTests: ['lint:remaining'] });
    expect(out.repairHead).toBe(H3);
    expect(out.phase).toBe(q.phase);
    expect(out.admissions).toEqual(q.admissions);
    expect(out.selectiveCoverage).toEqual(q.selectiveCoverage);
    expect(selectFrozenRepairAdmissionPaths(out).paths).toEqual(['lib/new.ts', 'lib/third.ts']);
  });
  it('does not reuse coverage when the recorded failure frontier may have been capped', () => {
    const q = queue();
    q.failingTests = Array.from({ length: 50 }, (_, i) => `lint:failure-${i}`);
    expect(selectFrozenRepairAdmissionPaths(q).mode).toBe('cumulative');
  });
  it('does not store a new receipt when the red transition truncates failure obligations', () => {
    const q = queue();
    const out = markFrozenRepairVerificationRed(q, {
      repairHead: H3, nowMs: 3,
      failingTests: Array.from({ length: 51 }, (_, i) => `lint:failure-${i}`),
      selectiveCoverage: { schemaVersion: 1, candidate: C, head: H3 },
    });
    expect(out.failingTests).toHaveLength(50);
    expect(out.selectiveCoverage).toBeUndefined();
    const smaller = markFrozenRepairVerificationRed({ ...out, phase: 'ready-to-verify' }, {
      repairHead: H3, nowMs: 4, failingTests: ['lint:remaining'],
      selectiveCoverage: { schemaVersion: 1, candidate: C, head: H3 },
    });
    expect(smaller.selectiveCoverage).toBeUndefined();
    expect(smaller.selectiveCoverageBlocked).toBe(true);
  });
  it('does not narrow around an overlong failure id whose identity would be truncated', () => {
    const q = queue();
    const out = markFrozenRepairVerificationRed(q, {
      repairHead: H3, nowMs: 3, failingTests: ['lint:' + 'x'.repeat(501)],
      selectiveCoverage: { schemaVersion: 1, candidate: C, head: H3 },
    });
    expect(out.selectiveCoverage).toBeUndefined();
  });
  it('does not turn a cumulative fallback with a missing prefix into a complete proof', () => {
    const q = queue();
    delete q.selectiveCoverage;
    q.admissions = [q.admissions![2]!];
    expect(selectFrozenRepairAdmissionPaths(q)).toMatchObject({ mode: 'cumulative', coverageComplete: false });
    const out = markFrozenRepairVerificationRed(q, {
      repairHead: H3, nowMs: 3, failingTests: ['lint:x'],
      selectiveCoverage: { schemaVersion: 1, candidate: C, head: H3 },
    });
    expect(out.selectiveCoverage).toBeUndefined();
  });
  it('retains the loss marker even when consecutive superseded results later become smaller', () => {
    const q = queue();
    const overflow = recordFrozenRepairSupersededRed(q, {
      measuredHead: H1, nowMs: 3,
      failingTests: Array.from({ length: 51 }, (_, i) => `lint:failure-${i}`),
    });
    const smaller = recordFrozenRepairSupersededRed(overflow, {
      measuredHead: H2, nowMs: 4, failingTests: ['lint:last'],
    });
    expect(smaller.repairHead).toBe(H3);
    expect(smaller.failingTests).toHaveLength(1);
    expect(smaller.selectiveCoverageBlocked).toBe(true);
    expect(smaller.selectiveCoverage).toBeUndefined();
    expect(selectFrozenRepairAdmissionPaths(smaller).mode).toBe('cumulative');
  });
  it.each(['object', 'dropped-entry', 'missing-recipe', 'duplicate', 'missing-with-receipt'] as const)(
    'tolerates %s signature data without trusting its coverage',
    (kind) => {
      const q = queue();
      const entry = q.signature[0]!;
      const raw: Record<string, unknown> = { ...q };
      if (kind === 'object') raw.signature = { corrupt: true };
      if (kind === 'dropped-entry') raw.signature = [entry, { corrupt: true }];
      if (kind === 'missing-recipe') raw.signature = [{ ...entry, recipe: null }];
      if (kind === 'duplicate') raw.signature = [entry, entry];
      if (kind === 'missing-with-receipt') delete raw.signature;
      const parsed = parseFrozenCandidateRepairQueue(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.repairHead).toBe(H3);
      expect(parsed!.selectiveCoverage).toBeUndefined();
      expect(parsed!.selectiveCoverageBlocked).toBe(true);
      expect(selectFrozenRepairAdmissionPaths(parsed!).mode).toBe('cumulative');
    },
  );
});
