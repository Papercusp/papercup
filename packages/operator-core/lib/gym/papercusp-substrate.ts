/**
 * THE REAL PAPERCUSP SUBSTRATE — the gym's task repo is the actual Papercusp
 * checkout at a pinned commit, and fitness is the repo's own test result.
 *
 * Plan gym-real-fitness-signal-2026-07-27, P-001. Design rulings D-004 (owner:
 * "IT SHOULD BE PUTTING THE REAL PAPERCUSP APP THROUGH THE GYM") and D-006.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The gym optimized coding-role prompts against three toy tasks on a 4-line
 * service it generated itself, whose only gate was `node --check`. D-003 tried
 * to fix that with hand-extracted micro-tasks because a real clone-and-test per
 * cycle "was not affordable". D-006 MEASURED that premise and it is false:
 *
 *   clone the real repo @ a pinned commit   3.5s   (437MB tree)
 *   npm install                             not needed at all
 *   run the repo's own real test            8.4s
 *
 * Two facts make it cheap, and both are load-bearing here:
 *
 *   1. The repo's BULK IS NOT ITS SOURCE. 8.1G of the 8.6G tracked is
 *      `papercusp-desktop` — committed ONNX model weights and a seed corestore.
 *      apps+packages+libs together are ~570MB. A cone sparse-checkout that
 *      omits the binaries cuts the checkout ~94% and removes nothing a unit
 *      test can reach. Hence SPARSE_CONE_DIRS below.
 *
 *   2. `node_modules` IS A BUILD ARTIFACT, NOT SOURCE. It is gitignored, so a
 *      clone never carries it — and it never has to be installed either: the
 *      canonical checkout's copy is symlinked in. Hence the symlink plan.
 *
 * ── WHAT A TASK IS, AND WHY NOT "THE COMMIT BEFORE THE FIX" ──────────────────
 * `real-anchor.ts` models a task as a real feature replayed at `baseCommit`,
 * "the commit immediately BEFORE the feature was implemented". That cannot work
 * on THIS repo, and D-006 records why: git-sync squashes the entire shared tree
 * into one commit every few minutes, so commits are not semantic units (the
 * last ten ranged from 1 to 1060 files). The parent of a fix is an arbitrary
 * fleet-wide snapshot that ALSO predates the fix's test file — so replaying
 * there hands the agent a repo whose oracle does not exist. That design gap,
 * not anyone's follow-through, is why its descriptor list stayed empty.
 *
 * A task here is instead a SURGICAL REVERT:
 *
 *   world  = the real repo at a recent pinned commit (coherent, everything else intact)
 *   oracle = the REAL test file, at that same pinned commit, untouched
 *   task   = ONE implementation file rewound to an earlier version
 *
 * The agent must restore the behaviour the real test demands. Nothing is
 * stubbed, extracted, or paraphrased: the spec is a real requirement, the
 * oracle is the real test a human wrote, and the codebase around it is the real
 * codebase — so this measures working in a large repo, which D-003's extraction
 * explicitly could not.
 *
 * ── VALIDITY IS PROVEN, NEVER ASSERTED ───────────────────────────────────────
 * A candidate only becomes a task if it demonstrably DISCRIMINATES: reverted ⇒
 * the real test FAILS, restored ⇒ it PASSES. Measured across 4 real pairs, 3
 * discriminated and 1 did not (its change carried no oracle) — and that one is
 * REJECTED. `judgeDiscrimination` is that gate. A bar that cannot fail proves
 * nothing, which is the failure this whole plan exists to correct; the corpus
 * must not repeat it one level down.
 *
 * This module is PURE: it builds command plans and judges observed results. It
 * runs nothing itself, mirroring `clone.ts`, so every rule here is unit-testable
 * without a container, a network, or a gym cycle.
 */
import { isPinnedCommit, type GitCommand } from './clone';
import type { GymTaskPool } from './task-generator';

/**
 * The cone-sparse-checkout dirs that make up the real substrate.
 *
 * Deliberately OMITS `papercusp-desktop` (8.1G of committed model weights and a
 * seed corestore — 94% of the tracked bytes, none of it reachable from a unit
 * test). Cone mode always materialises the root files, so `package.json`,
 * `package-lock.json`, `tsconfig.base.json` and the npm-workspace wiring are
 * present regardless of what is listed here.
 */
export const SPARSE_CONE_DIRS: readonly string[] = Object.freeze([
  'packages',
  'libs',
  'apps',
  'scripts',
  'tools',
  'docs',
  'design-tokens',
]);

export interface PinnedSubstrateInput {
  /** The canonical Papercusp checkout to clone FROM (a local path). */
  sourceRepo: string;
  /** The commit the task world is pinned at — a hex SHA, never a ref. */
  commit: string;
  /** Absolute scratch dir to materialise the substrate in. */
  destDir: string;
  /**
   * `node_modules` dirs to symlink, RELATIVE to the repo root (e.g.
   * 'node_modules', 'packages/operator-core/node_modules'). Enumerated from the
   * source checkout by the caller — 136 of them on this tree today, and the
   * count changes with the workspace layout, so it is never hardcoded.
   */
  nodeModulesDirs: readonly string[];
}

export interface PinnedSubstratePlan {
  /** Clone + sparse-checkout + detach, in order. */
  commands: GitCommand[];
  /** Symlinks to create: `link` (inside destDir) → `target` (in the source checkout). */
  symlinks: Array<{ link: string; target: string }>;
}

/**
 * Build the command plan for a pinned, sparse, dependency-ready clone of the
 * real Papercusp repo.
 *
 * `--local` is what makes this ~free: git hardlinks the object store instead of
 * copying 9.9G. It requires source and dest on the SAME filesystem — a
 * cross-device dest fails with "Invalid cross-device link" (measured), so the
 * caller must place `destDir` on the workspace's device, not /tmp.
 *
 * `--no-checkout` first, then sparse, then detach: checking out eagerly would
 * materialise the 8.1G of binaries this plan exists to skip.
 */
export function buildPinnedSubstratePlan(input: PinnedSubstrateInput): PinnedSubstratePlan {
  const { sourceRepo, commit, destDir, nodeModulesDirs } = input;
  if (!isPinnedCommit(commit)) {
    throw new Error(`papercusp substrate commit must be a pinned hex SHA, got: ${JSON.stringify(commit)}`);
  }
  if (!sourceRepo.startsWith('/')) {
    throw new Error(`papercusp substrate source must be an absolute local path (--local hardlinking), got: ${JSON.stringify(sourceRepo)}`);
  }

  return {
    commands: [
      { argv: ['git', 'clone', '--quiet', '--local', '--no-checkout', sourceRepo, destDir] },
      { argv: ['git', '-C', destDir, 'sparse-checkout', 'init', '--cone'] },
      { argv: ['git', '-C', destDir, 'sparse-checkout', 'set', ...SPARSE_CONE_DIRS] },
      { argv: ['git', '-C', destDir, 'checkout', '--detach', '-q', commit] },
    ],
    symlinks: nodeModulesDirs.map((d) => ({ link: `${destDir}/${d}`, target: `${sourceRepo}/${d}` })),
  };
}

/** A real Papercusp task: one implementation file rewound inside a real, pinned repo. */
export interface PapercuspTaskDescriptor {
  taskId: string;
  pool: GymTaskPool;
  /** The commit the whole repo — and crucially the ORACLE TEST — is pinned at. */
  pinCommit: string;
  /** Repo-relative implementation file the agent must restore. */
  implPath: string;
  /** Repo-relative REAL test file that judges it. Never modified, never stubbed. */
  testPath: string;
  /** The commit whose version of `implPath` the task starts from (the rewind point). */
  revertToCommit: string;
  /** The real requirement, as the task statement handed to the agent. */
  spec: string;
  /** Why it was needed — the real rationale. */
  intent: string;
  /** Work-item / commit this came from. Auditable provenance. */
  sourceRef: string;
}

/**
 * The command that sets a task up inside an already-materialised substrate:
 * rewind ONE file. Everything else — including the oracle — stays at `pinCommit`.
 */
export function buildTaskSetupCommands(desc: PapercuspTaskDescriptor, destDir: string): GitCommand[] {
  assertDescriptorPins(desc);
  return [
    // Normalise first: a substrate reused across tasks must not carry a previous rewind.
    { argv: ['git', '-C', destDir, 'checkout', '-q', desc.pinCommit, '--', desc.implPath] },
    { argv: ['git', '-C', destDir, 'checkout', '-q', desc.revertToCommit, '--', desc.implPath] },
  ];
}

/** Restore the reference solution — the real file as shipped at `pinCommit`. */
export function buildReferenceSolutionCommands(desc: PapercuspTaskDescriptor, destDir: string): GitCommand[] {
  assertDescriptorPins(desc);
  return [{ argv: ['git', '-C', destDir, 'checkout', '-q', desc.pinCommit, '--', desc.implPath] }];
}

function assertDescriptorPins(desc: PapercuspTaskDescriptor): void {
  for (const [field, value] of [['pinCommit', desc.pinCommit], ['revertToCommit', desc.revertToCommit]] as const) {
    if (!isPinnedCommit(value)) {
      throw new Error(`papercusp task ${desc.taskId}: ${field} must be a pinned hex SHA, got: ${JSON.stringify(value)}`);
    }
  }
  if (desc.pinCommit === desc.revertToCommit) {
    throw new Error(`papercusp task ${desc.taskId}: revertToCommit equals pinCommit — the task starts already solved`);
  }
  if (desc.implPath === desc.testPath) {
    throw new Error(`papercusp task ${desc.taskId}: implPath and testPath are the same file — the agent would edit its own oracle`);
  }
  if (/\.test\.[cm]?[jt]sx?$/.test(desc.implPath)) {
    throw new Error(`papercusp task ${desc.taskId}: implPath is a test file (${desc.implPath}) — the agent must never be asked to edit the oracle`);
  }
}

/** Observed result of running the task's real test, from the repo's own runner. */
export type ObservedTestStatus = 'passed' | 'failed';

export interface DiscriminationEvidence {
  /** Status with the implementation REWOUND — the agent's starting point. */
  reverted: ObservedTestStatus;
  /** Status with the real shipped implementation restored — the reference solution. */
  restored: ObservedTestStatus;
}

export type DiscriminationVerdict =
  | { valid: true }
  | { valid: false; reason: 'no-oracle' | 'broken-baseline' | 'inverted' };

/**
 * THE VALIDITY GATE. A candidate is a real task only if the real test actually
 * moves with the real implementation.
 *
 * The rejections are not symmetric bookkeeping — each is a different lie a
 * candidate can tell:
 *
 *   `no-oracle`       reverted PASSES. The change is real but no test covers it,
 *                     so the agent could do nothing and score. This is the
 *                     common case (1 of 4 measured) and the dangerous one: it
 *                     looks like a task and scores like a gift.
 *   `broken-baseline` restored FAILS. The reference solution does not pass — the
 *                     test is flaky, environment-dependent, or the pin is bad.
 *                     Nobody could score, so it measures the harness, not the agent.
 *   `inverted`        both fail. Same conclusion, stated separately because the
 *                     fix differs: a broken pin, versus a test that never passed.
 */
export function judgeDiscrimination(evidence: DiscriminationEvidence): DiscriminationVerdict {
  const { reverted, restored } = evidence;
  if (reverted === 'failed' && restored === 'passed') return { valid: true };
  if (reverted === 'passed' && restored === 'passed') return { valid: false, reason: 'no-oracle' };
  if (reverted === 'failed' && restored === 'failed') return { valid: false, reason: 'inverted' };
  // reverted passed, restored failed — the shipped code is the one that fails.
  return { valid: false, reason: 'broken-baseline' };
}

/** Keep only candidates whose discrimination was OBSERVED. Order is preserved. */
export function admitValidatedTasks(
  candidates: readonly { descriptor: PapercuspTaskDescriptor; evidence: DiscriminationEvidence }[],
): { admitted: PapercuspTaskDescriptor[]; rejected: Array<{ taskId: string; reason: string }> } {
  const admitted: PapercuspTaskDescriptor[] = [];
  const rejected: Array<{ taskId: string; reason: string }> = [];
  for (const c of candidates) {
    const verdict = judgeDiscrimination(c.evidence);
    if (verdict.valid) admitted.push(c.descriptor);
    else rejected.push({ taskId: c.descriptor.taskId, reason: verdict.reason });
  }
  return { admitted, rejected };
}

/**
 * Map a validated descriptor to the gym-task row.
 *
 * `corpus: 'real'` is the claim P-011's `fitness-signal-is-real` release bar
 * reads, so it is only ever produced HERE — downstream of the discrimination
 * gate — and never from an unvalidated descriptor.
 */
export function papercuspTaskToGymTask(
  desc: PapercuspTaskDescriptor,
  repoUrl: string,
): {
  taskId: string;
  pool: GymTaskPool;
  spec: string;
  intent: string;
  projectContext: string;
  corpus: 'real';
  repoUrl: string;
  repoCommit: string;
} {
  assertDescriptorPins(desc);
  return {
    taskId: desc.taskId,
    pool: desc.pool,
    spec: desc.spec,
    intent: desc.intent,
    projectContext:
      `The REAL Papercusp monorepo at commit ${desc.pinCommit.slice(0, 12)}. Implement ${desc.implPath}; ` +
      `${desc.testPath} is the REAL test that shipped with this change and is the oracle — do not edit it. ` +
      `Run it with \`npm run test:file -- ${desc.testPath}\`; the observed test result is the score. ` +
      `Provenance: ${desc.sourceRef}.`,
    corpus: 'real' as const,
    repoUrl,
    repoCommit: desc.pinCommit,
  };
}
