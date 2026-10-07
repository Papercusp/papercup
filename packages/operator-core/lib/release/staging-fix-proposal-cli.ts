/**
 * P-007 (gate-throughput-shift-left-2026-10-06, R-6, D-003): run the staging-fix proposer against
 * the LIVE frozen repair queue and print ready one-call admissions as JSON. Read-only: it builds
 * dry-run admission commits (unpublished garbage) and runs pre-checks in its OWN tree, so it can
 * never race the queue holder's admission pre-check or move repairHead.
 *
 *   npx tsx packages/operator-core/lib/release/staging-fix-proposal-cli.ts [--leg <id>]...
 *
 * Pre-checks take minutes per leg: launch it with `capability:bash { run_in_background: true }`.
 * Each `ready[].admitCall` is the exact `release:repair-queue` call that admits that proposal;
 * nothing is admitted until someone makes it.
 */
import { execFileSync } from 'node:child_process';
import { createCheckpointTreeFixPrecheckRunner, deriveAdmissionPrecheckRoot, resolveCanonicalIntegrationRoot, type SignatureLike } from './admission-fix-precheck';
import { importCompletenessPreflight } from './admission-import-completeness';
import { resolveDependencyGenerationRoot } from './dependency-generation-prebuild';
import { integrationBranch } from './judged-sha-containment';
import { createStagingFixProposalDeps, proposeStagingFixes, type FailingLeg } from './staging-fix-proposal';

/** Group a frozen signature into legs: test files by owning workspace, every other entry as its own leg. */
export function legsFromSignature(signature: readonly SignatureLike[]): FailingLeg[] {
  const byLeg = new Map<string, SignatureLike[]>();
  for (const entry of signature) {
    const leg = entry.kind === 'test-file' ? `${entry.workspace ?? 'unknown-workspace'}::test` : `${entry.kind}:${entry.id}`;
    byLeg.set(leg, [...(byLeg.get(leg) ?? []), entry]);
  }
  return [...byLeg.entries()].map(([leg, entries]) => ({ leg, signature: entries }));
}

async function main(argv: string[]): Promise<number> {
  const only = argv.flatMap((a, i) => (a === '--leg' && argv[i + 1] ? [argv[i + 1]!] : []));
  const [{ readFrozenCandidateRepairQueueState }, { integrationRoot }, { checkpointRootMirror }, { activeWorkspaceId }, { operatorHomeHarnessSlug }] =
    await Promise.all([
      import('../harness/routines/release-actions'),
      import('../release-deploy-launch'),
      import('../release-checkpoint-launch'),
      import('../workspace-registry'),
      import('../harness/operator-home-harness'),
    ]);
  const read = await readFrozenCandidateRepairQueueState({ workspaceId: activeWorkspaceId(), installSlug: operatorHomeHarnessSlug() });
  const queue = read.status === 'value' ? read.queue : null;
  if (!queue) {
    console.log(JSON.stringify({ ok: false, reason: 'no-frozen-queue', read: read.status }));
    return 0;
  }
  const root = resolveCanonicalIntegrationRoot(integrationRoot());
  const tip = execFileSync('git', ['rev-parse', '--verify', `${integrationBranch()}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const legs = legsFromSignature(queue.signature).filter((l) => only.length === 0 || only.includes(l.leg));
  // Its OWN pre-check tree: never the holder's `<checkpoint>-admission-precheck` checkout (D-003).
  const precheckRoot = deriveAdmissionPrecheckRoot({
    checkpointRoot: `${checkpointRootMirror(root)}-fix-proposal`,
    generationRoot: resolveDependencyGenerationRoot(root),
  }).root;
  const deps = createStagingFixProposalDeps({
    root,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    actor: process.env.PAPERCUSP_SID ?? 'staging-fix-proposal',
    precheck: createCheckpointTreeFixPrecheckRunner({
      integrationRoot: root,
      checkpointRoot: checkpointRootMirror(root),
      testRunHarness: operatorHomeHarnessSlug(),
      precheckRoot,
      log: (line) => console.error(line),
    }),
    preflight: importCompletenessPreflight({ root, probeRef: tip, enforceSourceCohort: true }),
  });
  const result = await proposeStagingFixes({ candidate: queue.candidate, repairHead: queue.repairHead, tip, legs }, deps);
  console.log(JSON.stringify({ ok: true, candidate: queue.candidate, repairHead: queue.repairHead, tip, ...result }, null, 2));
  return 0;
}

if (process.argv[1] && /staging-fix-proposal-cli\.[cm]?[jt]s$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
