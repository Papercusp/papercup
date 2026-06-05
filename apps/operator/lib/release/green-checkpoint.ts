/**
 * The green-checkpoint job — plan release-gate-ready-branch-2026-06-04, Phase 1
 * (D-003). Fast-forwards `ready` to the newest integration commit that is GREEN,
 * so "deploy ready" always deploys a known-good, tests-passing state — with zero
 * manual curation. git-sync keeps committing ALL WIP to the integration branch
 * (unchanged); this advances the green pin behind it. The gap between HEAD and
 * `ready` IS the staging buffer.
 *
 * Two correctness rules from the plan's Risks:
 *   - "Green" is measured in an ISOLATED checkout of the CANDIDATE commit (the
 *     dedicated checkpoint worktree), NEVER the churning shared tree — otherwise
 *     a peer's in-flight edit pollutes test:affected.
 *   - It only ever FAST-FORWARDS `ready` (advanceReady refuses non-FF), and reads
 *     a FIXED candidate sha up front, so it can't race git-sync's commits.
 *
 * Effects are injected (CheckpointDeps) so the orchestration is unit-tested
 * without running the (heavy) suite; realCheckpointDeps wires the real ones.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  revParse,
  refExists,
  isAncestor,
  advanceReady,
  pushRef,
  type AdvanceResult,
} from './git-ops';
import type { ReleaseConfig } from './release-config';

export interface CheckpointDeps {
  /** (Re)build the isolated checkpoint checkout at `ref` (setup-release-checkout.sh). */
  setupTree(ref: string): Promise<void>;
  /** Run the "green" suite in `treeDir` against `base`; resolve green=true on pass. */
  runGreen(treeDir: string, base: string | null): Promise<{ green: boolean; summary: string }>;
  /** Fast-forward `ready` to `candidate` (advanceReady). */
  advance(candidate: string): Promise<AdvanceResult>;
  /** Publish `ready` to origin. */
  push(ref: string): Promise<void>;
  broadcast(summary: string, body?: string): Promise<void>;
  log(s: string): void;
}

export interface CheckpointResult {
  advanced: boolean;
  candidate: string;
  from: string | null;
  green: boolean | null;
  reason: 'up-to-date' | 'not-fast-forward' | 'not-green' | 'advanced' | 'create-failed';
  summary?: string;
}

export interface CheckpointOpts {
  /** Override the candidate (default: integration-branch HEAD). */
  candidate?: string;
  /** Don't push `ready` to origin (local-only). */
  noPush?: boolean;
}

export async function runGreenCheckpoint(
  cfg: ReleaseConfig,
  deps: CheckpointDeps,
  opts: CheckpointOpts = {},
): Promise<CheckpointResult> {
  const candidate = opts.candidate
    ? await revParse(cfg.integrationRoot, opts.candidate)
    : await revParse(cfg.integrationRoot, cfg.integrationBranch);
  const lastReady = (await refExists(cfg.integrationRoot, cfg.releaseRef))
    ? await revParse(cfg.integrationRoot, cfg.releaseRef)
    : null;

  if (candidate === lastReady) {
    deps.log(`ready already at integration HEAD ${candidate.slice(0, 8)} — nothing to checkpoint`);
    return { advanced: false, candidate, from: lastReady, green: null, reason: 'up-to-date' };
  }

  // `ready` only ever fast-forwards — refuse a candidate that isn't a descendant.
  if (lastReady && !(await isAncestor(cfg.integrationRoot, lastReady, candidate))) {
    deps.log(`candidate ${candidate.slice(0, 8)} is NOT a descendant of ready ${lastReady.slice(0, 8)} — refusing`);
    return { advanced: false, candidate, from: lastReady, green: null, reason: 'not-fast-forward' };
  }

  deps.log(`checkpointing candidate ${candidate.slice(0, 8)} (base ${lastReady?.slice(0, 8) ?? 'none'})`);
  await deps.setupTree(candidate);
  const { green, summary } = await deps.runGreen(cfg.checkpointRoot, lastReady);
  if (!green) {
    deps.log(`candidate ${candidate.slice(0, 8)} is NOT green — ready stays at ${lastReady?.slice(0, 8) ?? 'unset'}`);
    await deps
      .broadcast(
        `🟥 green-checkpoint: ${candidate.slice(0, 8)} not green — \`ready\` held at ${lastReady?.slice(0, 8) ?? 'unset'}`,
        summary,
      )
      .catch(() => {});
    return { advanced: false, candidate, from: lastReady, green: false, reason: 'not-green', summary };
  }

  const adv = await deps.advance(candidate);
  if (adv.advanced && !opts.noPush) {
    await deps.push(cfg.releaseRef).catch((e) => deps.log(`warn: push ${cfg.releaseRef} failed: ${e}`));
  }
  deps.log(`✅ ready advanced ${adv.from?.slice(0, 8) ?? 'none'} → ${candidate.slice(0, 8)} (green)`);
  await deps
    .broadcast(
      `🟩 green-checkpoint: \`ready\` advanced to ${candidate.slice(0, 8)} (green, deployable)`,
      `Was ${adv.from?.slice(0, 8) ?? 'unset'}. The next deploy will pick this up.`,
    )
    .catch(() => {});
  return { advanced: adv.advanced, candidate, from: adv.from, green: true, reason: 'advanced', summary };
}

/** Real effect wiring. The heavy bit — runGreen — runs the configured suite in
 *  the isolated checkpoint tree with AFFECTED_BASE pinned to the last green. */
export function realCheckpointDeps(cfg: ReleaseConfig): CheckpointDeps {
  const log = (s: string) => console.log(`[green-checkpoint] ${s}`);
  return {
    async setupTree(ref) {
      const script = path.join(cfg.integrationRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
      await runCmd('bash', [script, '--ref', ref, '--integration', cfg.integrationRoot, '--release', cfg.checkpointRoot, '--node-modules', 'auto']);
    },
    async runGreen(treeDir, base) {
      const [cmd, ...args] = cfg.greenCmd.split(' ');
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (base) env.AFFECTED_BASE = base;
      const r = await runCmd(cmd, args, { cwd: treeDir, env, allowNonZero: true });
      return { green: r.code === 0, summary: (r.stdout + r.stderr).slice(-2000) };
    },
    advance: (candidate) => advanceReady(cfg.integrationRoot, candidate, cfg.releaseRef),
    push: (ref) => pushRef(cfg.integrationRoot, ref),
    async broadcast(summary, body) {
      const { sendMessage } = await import('@papercusp/operator-core/lib/agent-tools/coordination/messages');
      await sendMessage(
        { ownerId: 'green-checkpoint', ownerLabel: 'green-checkpoint', source: 'static-client', workspaceId: null, userId: null },
        { to: ['*'], summary, body, category: 'service-health' },
      );
    },
    log,
  };
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; allowNonZero?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || opts.allowNonZero) resolve({ code: code ?? 0, stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

// CLI: `tsx green-checkpoint.ts [--candidate <ref>] [--no-push]`
if (require.main === module) {
  const { releaseConfig } = require('./release-config') as typeof import('./release-config');
  const cfg = releaseConfig();
  const arg = (f: string) => {
    const i = process.argv.indexOf(f);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  runGreenCheckpoint(cfg, realCheckpointDeps(cfg), {
    candidate: arg('--candidate'),
    noPush: process.argv.includes('--no-push'),
  })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error('[green-checkpoint] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
