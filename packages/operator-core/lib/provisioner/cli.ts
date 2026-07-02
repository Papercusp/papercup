#!/usr/bin/env node
/**
 * Headless CLI for the provisioner wizard (local-concurrent-inference-2026-07-02 P-009, D-006).
 * The non-Desktop entrypoint to the SAME plan/apply logic the SetupWizard step drives via
 * `/api/desktop/provisioner*` (provision.ts is the shared core — no forked logic here).
 *
 * Usage:
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts               # detect + recommend + dry-run plan
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --install     # write config + register in the
 *                                                                        # gateway pool (does NOT start it)
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --install --start
 *                                                                        # ALSO enable+start the backend —
 *                                                                        # this loads the model onto the
 *                                                                        # GPU. Confirm nothing else is
 *                                                                        # GPU-resident first (coord:presence
 *                                                                        # / coord:ask) — this is the ONLY
 *                                                                        # flag in this tool that touches
 *                                                                        # the GPU.
 *   npx tsx packages/operator-core/lib/provisioner/cli.ts --json        # machine-readable output
 *
 * Exit code: 0 on a successful detect/plan (and, with --install, a successful apply); 1 if the
 * plan is blocked (no combo fits / weights missing) or --install's apply fails.
 */
import { planProvision, applyProvision } from './provision';

interface CliArgs {
  install: boolean;
  start: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    install: argv.includes('--install'),
    start: argv.includes('--start'),
    json: argv.includes('--json'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = await planProvision();

  if (!args.json) {
    const hw = plan.hardware;
    const gpuDesc = hw.gpu ? `${hw.gpu.vendor} ${hw.gpu.model ?? ''} (${hw.gpu.vramGB ?? '?'}GB)`.trim() : 'none detected';
    console.log(`Hardware: ${hw.platform}/${hw.arch}, RAM ${hw.ramGB}GB, GPU: ${gpuDesc}`);
    console.log(`Recommendation: ${plan.recommendation.entry ? plan.recommendation.entry.displayName : '(none)'} — ${plan.recommendation.reason}`);
    if (plan.blocked) console.log(`BLOCKED: ${plan.blocked}`);
  }

  if (!args.install) {
    if (args.json) console.log(JSON.stringify({ plan }, null, 2));
    process.exitCode = plan.blocked ? 1 : 0;
    return;
  }

  if (args.start && !args.json) {
    console.log(
      '⚠️  --start will enable+start the backend and load the model onto the GPU. ' +
        'Make sure nothing else is currently GPU-resident (check coord:presence / coord:ask first).',
    );
  }

  const result = await applyProvision(plan, { start: args.start });
  if (args.json) {
    console.log(JSON.stringify({ plan, result }, null, 2));
  } else {
    console.log(`Install: ${JSON.stringify(result)}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((e) => {
  console.error('[provisioner] fatal:', (e as Error)?.stack || String(e));
  process.exitCode = 1;
});
