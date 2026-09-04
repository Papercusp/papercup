/**
 * P-006 / D-004 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): the queue's
 * TYPED failure signature — kind + recipe per entry, `failingTests` as its flat projection,
 * EXTEND (not replace) across a red that measured only some kinds, and a parse that derives
 * the signature for the pre-schema-4 row still live in production (the P-014 migration).
 */
import { describe, expect, it } from 'vitest';
import {
  FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
  REPAIR_SIGNATURE_BUILD_SENTINEL,
  REPAIR_SIGNATURE_FULL_GATE_RECIPE,
  classifyRepairSignature,
  classifyRepairSignatureEntry,
  createFrozenCandidateQueue,
  createFrozenCandidateRepairQueue,
  diagnoseFrozenCandidateRepairQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  markFrozenRepairVerificationGreen,
  markFrozenRepairVerificationRed,
  nextRepairSignature,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const BASE = '0000000000000000000000000000000000000000';
const T0 = 1_800_000_000_000;
const REGISTRY = {
  'lint:tsc': ['lint:tsc'],
  'lint:identity-leak': ['lint:no-owner-name-tags', 'lint:no-box-identity', 'lint:no-identity-literals'],
};

function admit(queue: FrozenCandidateRepairQueue, to: string, atMs: number): FrozenCandidateRepairQueue {
  return markFrozenRepairAdmitted(queue, {
    atMs,
    actor: 'su-test',
    source: { ref: 'staging', sha: to },
    fromRepairHead: queue.repairHead,
    toRepairHead: to,
    paths: ['lib/a.ts'],
    unchanged: [],
    blobs: { 'lib/a.ts': 'deadbeef' },
  });
}

describe('P-006 — classifying a flat failing entry into a typed signature entry', () => {
  it('names each population by the runner that re-measures it, with a recipe', () => {
    expect(classifyRepairSignatureEntry('@papercusp/web :: lint:design-primitives')).toEqual({
      kind: 'workspace-task',
      id: '@papercusp/web :: lint:design-primitives',
      recipe: 'npm run lint:design-primitives -w @papercusp/web',
      workspace: '@papercusp/web',
    });
    expect(classifyRepairSignatureEntry('@papercusp/operator-core :: seed:substitutions:check')).toMatchObject({
      kind: 'seed',
      recipe: 'npm run seed:substitutions:check -w @papercusp/operator-core',
      workspace: '@papercusp/operator-core',
    });
    expect(classifyRepairSignatureEntry('lint:identity-leak', { gateRegistry: REGISTRY })).toEqual({
      kind: 'lint-leg',
      id: 'lint:identity-leak',
      recipe: 'npm run lint:no-owner-name-tags && npm run lint:no-box-identity && npm run lint:no-identity-literals',
    });
    expect(classifyRepairSignatureEntry('lint:not-registered')).toMatchObject({
      kind: 'lint-leg',
      recipe: 'npm run lint:not-registered',
    });
    expect(classifyRepairSignatureEntry(REPAIR_SIGNATURE_BUILD_SENTINEL)).toMatchObject({
      kind: 'post-suite-leg',
      recipe: `npm --workspace ${REPAIR_SIGNATURE_BUILD_SENTINEL} run build`,
    });
    expect(classifyRepairSignatureEntry('@papercusp/operator-core')).toEqual({
      kind: 'workspace-task',
      id: '@papercusp/operator-core',
      recipe: 'npm run test -w @papercusp/operator-core',
      workspace: '@papercusp/operator-core',
    });
    for (const sentinel of ['package.json-unreadable', 'lint:tsc-missing', 'repair-staging-mismatch', 'weird-crash-id']) {
      expect(classifyRepairSignatureEntry(sentinel), sentinel).toEqual({
        kind: 'post-suite-leg',
        id: sentinel,
        recipe: REPAIR_SIGNATURE_FULL_GATE_RECIPE,
      });
    }
  });

  it('pairs a workspace-relative test path with the ONE workspace the list names, and refuses to guess between two', () => {
    const one = classifyRepairSignature(['lib/a.test.ts', '@papercusp/operator-core', '@papercusp/operator-core :: test']);
    expect(one).toEqual([
      { kind: 'test-file', id: 'lib/a.test.ts', recipe: 'npm run test:file -- lib/a.test.ts', workspace: '@papercusp/operator-core' },
      { kind: 'workspace-task', id: '@papercusp/operator-core', recipe: 'npm run test -w @papercusp/operator-core', workspace: '@papercusp/operator-core' },
      {
        kind: 'workspace-task',
        id: '@papercusp/operator-core :: test',
        recipe: 'npm run test -w @papercusp/operator-core',
        workspace: '@papercusp/operator-core',
      },
    ]);
    const two = classifyRepairSignature(['lib/a.test.ts', '@papercusp/operator-core', '@papercusp/web']);
    expect(two[0]).toEqual({ kind: 'test-file', id: 'lib/a.test.ts', recipe: 'npm run test:file -- lib/a.test.ts' });
    // The build sentinel is package-shaped but never a test workspace: it must not be the hint.
    const withBuild = classifyRepairSignature(['lib/a.test.ts', '@papercusp/operator-core', REPAIR_SIGNATURE_BUILD_SENTINEL]);
    expect(withBuild[0]).toMatchObject({ workspace: '@papercusp/operator-core' });
    // Duplicates and blanks collapse; first occurrence wins.
    expect(classifyRepairSignature(['lint:tsc', ' ', 'lint:tsc']).map((e) => e.id)).toEqual(['lint:tsc']);
  });
});

describe('P-006 — the typed signature on the queue row', () => {
  it('a red opens the queue on exactly what the run measured, typed, at round 1 — failingTests is the projection', () => {
    const queue = createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      failingTests: ['lib/a.test.ts', '@papercusp/operator-core', 'lint:tsc'],
      signatureContext: { gateRegistry: REGISTRY },
      nowMs: T0,
    });
    expect(queue.schemaVersion).toBe(FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION);
    expect(queue.signature).toEqual([
      { kind: 'test-file', id: 'lib/a.test.ts', recipe: 'npm run test:file -- lib/a.test.ts', workspace: '@papercusp/operator-core', admittedRound: 1, measuredHead: C },
      { kind: 'workspace-task', id: '@papercusp/operator-core', recipe: 'npm run test -w @papercusp/operator-core', workspace: '@papercusp/operator-core', admittedRound: 1, measuredHead: C },
      { kind: 'lint-leg', id: 'lint:tsc', recipe: 'npm run lint:tsc', admittedRound: 1, measuredHead: C },
    ]);
    expect(queue.failingTests).toEqual(queue.signature.map((e) => e.id));
    expect(diagnoseFrozenCandidateRepairQueue(queue, { nowMs: T0 + 1 }).signature).toEqual(queue.signature);
  });

  it('a LINT-ONLY red (suite green, one post-suite leg red) opens the SAME queue on that leg alone', () => {
    const queue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({ candidate: C, base: BASE, nowMs: T0 }), {
      failingTests: ['lint:plane-integrity'],
      signatureContext: { gateRegistry: { 'lint:plane-integrity': ['lint:plane-producers', 'lint:plane-guards'] } },
      nowMs: T0 + 1,
    });
    expect(queue.phase).toBe('awaiting-fixer');
    expect(queue.signature).toEqual([
      {
        kind: 'lint-leg',
        id: 'lint:plane-integrity',
        recipe: 'npm run lint:plane-producers && npm run lint:plane-guards',
        admittedRound: 1,
        measuredHead: C,
      },
    ]);
    expect(queue.failingTests).toEqual(['lint:plane-integrity']);
  });

  it('a typed measurement from the judge wins over the flat list on the same id, and typed-only ids still project', () => {
    const queue = createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      failingTests: ['lib/a.test.ts'],
      signature: [{ kind: 'test-file', id: 'lib/a.test.ts', recipe: 'custom', workspace: '@papercusp/web' }, { kind: 'lint-leg', id: 'lint:tsc', recipe: 'npm run lint:tsc' }],
      nowMs: T0,
    });
    expect(queue.signature.map((e) => [e.id, e.kind, e.recipe, e.workspace])).toEqual([
      ['lib/a.test.ts', 'test-file', 'custom', '@papercusp/web'],
      ['lint:tsc', 'lint-leg', 'npm run lint:tsc', undefined],
    ]);
    expect(queue.failingTests).toEqual(['lib/a.test.ts', 'lint:tsc']);
  });
});

describe('P-006 — EXTEND across a verification red: unmeasured is never passing', () => {
  function opened(): FrozenCandidateRepairQueue {
    return createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      failingTests: ['lib/a.test.ts', '@papercusp/operator-core', 'lint:tsc'],
      signatureContext: { gateRegistry: REGISTRY },
      nowMs: T0,
    });
  }

  it('a suite-red run that deferred the post-suite legs carries the lint leg forward with its original round', () => {
    const verified = markFrozenRepairVerificationRed(admit(opened(), C1, T0 + 10), {
      repairHead: C1,
      failingTests: ['lib/b.test.ts', '@papercusp/operator-core'],
      measuredKinds: ['test-file', 'workspace-task', 'seed'],
      nowMs: T0 + 20,
    });
    expect(verified.failingTests).toEqual(['lib/b.test.ts', '@papercusp/operator-core', 'lint:tsc']);
    expect(verified.signature).toEqual([
      { kind: 'test-file', id: 'lib/b.test.ts', recipe: 'npm run test:file -- lib/b.test.ts', workspace: '@papercusp/operator-core', admittedRound: 2, measuredHead: C1 },
      // Present before: keeps round 1, re-measured at C1.
      { kind: 'workspace-task', id: '@papercusp/operator-core', recipe: 'npm run test -w @papercusp/operator-core', workspace: '@papercusp/operator-core', admittedRound: 1, measuredHead: C1 },
      // NOT measured this run: carried forward untouched — still at the head it was last measured red at.
      { kind: 'lint-leg', id: 'lint:tsc', recipe: 'npm run lint:tsc', admittedRound: 1, measuredHead: C },
    ]);
    // The round count reflects the EXTENDED signature, not the fresh suite-only slice.
    expect(verified.convergenceRounds?.at(-1)).toMatchObject({ round: 2, head: C1, failingCount: 3 });
  });

  it('a full run that measured every kind REPLACES the signature: a leg absent from the fresh red was measured passing', () => {
    const verified = markFrozenRepairVerificationRed(admit(opened(), C1, T0 + 10), {
      repairHead: C1,
      failingTests: ['lib/a.test.ts', '@papercusp/operator-core'],
      nowMs: T0 + 20,
    });
    expect(verified.failingTests).toEqual(['lib/a.test.ts', '@papercusp/operator-core']);
    expect(verified.signature.find((e) => e.id === 'lib/a.test.ts')).toMatchObject({ admittedRound: 1, measuredHead: C1 });
    expect(verified.signature.some((e) => e.kind === 'lint-leg')).toBe(false);
  });

  it('a green verification clears both the signature and its projection', () => {
    const green = markFrozenRepairVerificationGreen(admit(opened(), C1, T0 + 10), { repairHead: C1, nowMs: T0 + 20 });
    expect(green.signature).toEqual([]);
    expect(green.failingTests).toEqual([]);
  });

  it('nextRepairSignature is pure and bounded to the persisted-failure cap', () => {
    const many = Array.from({ length: 80 }, (_, i) => `lib/t${i}.test.ts`);
    const next = nextRepairSignature([], { failingTests: many, head: C, round: 1 });
    expect(next.signature.length).toBe(50);
    expect(next.failingTests).toEqual(next.signature.map((e) => e.id));
  });
});

describe('P-006 / P-014 — parsing: the live pre-schema-4 row keeps parsing, its signature derived', () => {
  function v3Row(): Record<string, unknown> {
    return {
      schemaVersion: 3,
      phase: 'ready-to-verify',
      candidate: C,
      qualificationAttemptId: null,
      base: BASE,
      repairHead: C1,
      affectedTestProofGroup: null,
      attempts: 0,
      openedAtMs: T0,
      updatedAtMs: T0 + 10,
      fixerSpawnId: null,
      failingTests: ['lib/cell-assessment-reality.test.ts', 'lint:plane-integrity'],
      convergenceRounds: [{ round: 1, head: C, failingCount: 2, atMs: T0 + 1 }],
      admissions: [
        {
          atMs: T0 + 5,
          actor: 'su-test',
          source: { ref: 'staging', sha: C1 },
          fromRepairHead: C,
          toRepairHead: C1,
          paths: ['lib/a.ts'],
          unchanged: [],
          blobs: {},
        },
      ],
    };
  }

  it('derives a typed signature from failingTests, re-stamps the version, and keeps the flat list byte-identical', () => {
    const parsed = parseFrozenCandidateRepairQueue(v3Row());
    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(4);
    expect(parsed!.failingTests).toEqual(['lib/cell-assessment-reality.test.ts', 'lint:plane-integrity']);
    expect(parsed!.signature).toEqual([
      // Derived without the registry: shape-only, still the right kinds.
      { kind: 'test-file', id: 'lib/cell-assessment-reality.test.ts', recipe: 'npm run test:file -- lib/cell-assessment-reality.test.ts', admittedRound: 1, measuredHead: C1 },
      { kind: 'lint-leg', id: 'lint:plane-integrity', recipe: 'npm run lint:plane-integrity', admittedRound: 1, measuredHead: C1 },
    ]);
  });

  it('round-trips a v4 row exactly, drops a malformed entry, and classifies in an id only the flat list names', () => {
    const queue = createFrozenCandidateRepairQueue({
      candidate: C,
      base: BASE,
      failingTests: ['lib/a.test.ts', '@papercusp/operator-core', 'lint:tsc'],
      signatureContext: { gateRegistry: REGISTRY },
      nowMs: T0,
    });
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(queue)))).toEqual(queue);

    const skewed = {
      ...JSON.parse(JSON.stringify(queue)),
      signature: [{ kind: 'nonsense', id: 'x' }, queue.signature[2], { kind: 'test-file', id: '  ' }],
      failingTests: ['lint:tsc', 'lib/z.test.ts'],
    };
    const parsed = parseFrozenCandidateRepairQueue(skewed);
    expect(parsed!.signature.map((e) => [e.id, e.kind, e.admittedRound])).toEqual([
      ['lint:tsc', 'lint-leg', 1],
      ['lib/z.test.ts', 'test-file', 1],
    ]);
    expect(parsed!.failingTests).toEqual(['lint:tsc', 'lib/z.test.ts']);
  });
});
