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
});
