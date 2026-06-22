/**
 * The green-checkpoint job — plan release-gate-ready-branch-2026-06-04, Phase 1
 * (D-003); staging→main model since staging-branch-pipeline-2026-06-06.
 * Fast-forwards the green pin (`releaseRef`, now the **`main` branch**) to the
 * newest integration commit that is GREEN, so `main` only ever holds known-good,
 * tests-passing states — with zero manual curation. git-sync keeps committing
 * ALL WIP to the integration branch (`staging`, unchanged); this advances the
 * green `main` behind it. The gap between staging HEAD and `main` IS the
 * untested buffer. Requires `main` NOT to be checked out in the integration
 * tree (it lives on `staging`), so `git branch -f main` is free to move.
 *
 * Two correctness rules from the plan's Risks:
 *   - "Green" is measured in an ISOLATED checkout of the CANDIDATE commit (the
 *     dedicated checkpoint worktree), NEVER the churning shared tree — otherwise
 *     a peer's in-flight edit pollutes test:affected.
 *   - It only ever FAST-FORWARDS the green pin (advanceReady refuses non-FF), and
 *     reads a FIXED candidate sha up front, so it can't race git-sync's commits.
 *
 * Effects are injected (CheckpointDeps) so the orchestration is unit-tested
 * without running the (heavy) suite; realCheckpointDeps wires the real ones.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import {
  revParse,
  refExists,
  isAncestor,
  advanceReady,
  type AdvanceResult,
} from './git-ops';
import type { ReleaseConfig } from './release-config';
import { runPerfGate, perfGatePolicyFromEnv } from './perf-gate';
import { runDeltaGate, deltaGatePolicyFromEnv } from './delta-gate';

export interface CheckpointDeps {
  /** (Re)build the isolated checkpoint checkout at `ref` (setup-release-checkout.sh). */
  setupTree(ref: string): Promise<void>;
  /** Run the "green" suite in `treeDir` against `base`; resolve green=true on pass.
   *  `failingTests` is a STABLE signature of what failed (test files / workspaces),
   *  extracted from the FULL output — used to dedup the release-fixer dispatch by the
   *  failure rather than the candidate sha (P-012). */
  runGreen(treeDir: string, base: string | null): Promise<{ green: boolean; summary: string; failingTests?: string[] }>;
  /** Fast-forward `ready` to `candidate` (advanceReady). */
  advance(candidate: string): Promise<AdvanceResult>;
  /** Publish `ready` to origin. */
  push(ref: string): Promise<void>;
  broadcast(summary: string, body?: string): Promise<void>;
  /** release-pipeline-resilience-2026-06-09 P-002: open a durable, human-facing
   *  `release-not-green` escalation on red. Transition-only (no-op if one is
   *  already open) so the hourly tick doesn't re-open it while the gate stays
   *  red. Optional so existing test stubs need not provide it. */
  escalate?(summary: string, body: string): Promise<void>;
  /** Resolve any open `release-not-green` escalation — the gate recovered. */
  clearEscalation?(): Promise<void>;
  /** F2 (round-4 P-031): perf-regression deploy gate. Runs post-runGreen / pre-advance
   *  on a GREEN candidate: if the operator is in a definitive per-thread wedge right now,
   *  WARN (default — still advance) or BLOCK (only when the owner armed block-mode). Optional
   *  + flag-gated (a no-op `pass` unless PAPERCUSP_PERF_GATE=1) so existing stubs need not
   *  provide it and the default deploy behaviour is unchanged. */
  perfGate?(candidate: string): Promise<{ action: 'pass' | 'warn' | 'block'; summary: string }>;
  /** P-016 (agent-tool-delta-protocol D-008): the delta-protocol SAFETY gate.
   *  Runs post-runGreen / pre-advance on a GREEN candidate: if the production
   *  semantic-delta flag is ON but the Lane-C scenarios (S23/S24/S25) are not
   *  recorded-green-and-fresh, WARN (default) or BLOCK (owner-armed). Optional +
   *  flag-gated (a no-op `pass` unless PAPERCUSP_DELTA_GATE=1) so existing stubs
   *  need not provide it and the default deploy behaviour is unchanged. */
  deltaGate?(candidate: string): Promise<{ action: 'pass' | 'warn' | 'block'; summary: string }>;
  log(s: string): void;
}

export interface CheckpointResult {
  advanced: boolean;
  candidate: string;
  from: string | null;
  green: boolean | null;
  reason: 'up-to-date' | 'not-fast-forward' | 'not-green' | 'advanced' | 'create-failed' | 'perf-held' | 'delta-held';
  summary?: string;
  /** P-012: a stable signature of what failed (test files / workspaces) on the
   *  not-green path, so the release-fixer dispatch dedups by FAILURE, not candidate sha. */
  failingTests?: string[];
}

/** The marker the green-checkpoint CLI prints its CheckpointResult JSON behind, so the
 *  release-actions routine parses one delimited line instead of brace-slicing the whole
 *  stdout (P-008). MUST stay in sync with the literal in release-actions.ts. */
export const GREEN_CHECKPOINT_RESULT_MARKER = '__GREEN_CHECKPOINT_RESULT__';

/** Extract a stable failure signature from the FULL suite output (NOT the 2000-char
 *  tail, which can truncate the markers): vitest `FAIL <file>` lines + the affected
 *  runner's `>>> <ws> FAILED` workspace markers. Used for the release-fixer dedup. */
export function extractFailingTests(out: string): string[] {
  const set = new Set<string>();
  for (const m of out.matchAll(/^\s*FAIL\s+(\S+)/gm)) set.add(m[1]);
  for (const m of out.matchAll(/>>>\s+(\S+)\s+FAILED\b/g)) set.add(m[1]);
  return [...set].sort().slice(0, 50);
}

/** Host-set, test-affecting NON-`PAPERCUSP_` env vars the gate must strip (P-008).
 *  `AGENT_MODELS` (the operator's per-role model map, e.g. `{"worker":"opus"}` in
 *  .env.local) leaked into the gate and broke `@papercusp/orchestrator` invoke.test
 *  2026-06-09 — green in a clean shell, red only under the routine. The gate measures
 *  the COMMITTED defaults; tests that need it set it themselves. */
export const HOST_ENV_STRIP = ['AGENT_MODELS'];

/**
 * Build the GREEN suite's environment — the COMMITTED DEFAULTS, with the host's
 * identity stripped — as a fresh env (so realCheckpointDeps.runGreen's env logic,
 * which twice held `main` red for hours via leaked env, is unit-testable without
 * running the suite). `source` defaults to the live process env.
 *
 * - Strip ALL `PAPERCUSP_*` (a demo flag leaked from the systemd user-manager env
 *   held `main` red for hours 2026-06-06; non-flag host vars — PAPERCUSP_OPERATOR_URL
 *   / SPAWN_SU_BEARER — struck again 2026-06-07, failing spawn-chokepoint tests 8/8
 *   under the routine while the same sha passed in a login shell) + every
 *   {@link HOST_ENV_STRIP} key. The host's identity must never define green.
 * - `GREEN_CHECKPOINT=1` — a marker so genuinely load-/live-network-sensitive tests
 *   that CANNOT be hermetic (real Hyperswarm/DHT, ports) self-exclude via
 *   `describe.skipIf(process.env.GREEN_CHECKPOINT === '1')`; they still run in CI/local.
 * - `AFFECTED_BASE=<base>` (when given) so test:affected runs exactly the candidate's delta;
 *   any host-leaked AFFECTED_BASE is dropped — the `base` arg is the ONLY source, so a
 *   base-null full run is never silently narrowed by an inherited value.
 * - `VITEST_MAX_FORKS/THREADS` default to 8 (respecting a pre-set value): the checkpoint
 *   shares the box with the live fleet; uncapped workers under that load produce timeout
 *   FLAKES that read as "not green" (a 1-of-8881 load-flake held `main` back 2026-06-06).
 * - `AFFECTED_RETRY_FAILED` defaults to 1 (respecting a pre-set value): re-run a failed
 *   workspace once before calling it red — a real regression fails twice, a flake doesn't.
 */
export function buildGreenCheckpointEnv(
  base: string | null,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const k of Object.keys(env)) {
    if (k.startsWith('PAPERCUSP_') || HOST_ENV_STRIP.includes(k)) delete env[k];
  }
  env.GREEN_CHECKPOINT = '1';
  // AFFECTED_BASE comes ONLY from the `base` argument — never a host-leaked value.
  // The gate runs the suite with AFFECTED_BASE set, so a child runGreen(tree, null)
  // would otherwise inherit that base and silently NARROW a "full" affected run —
  // the host's env defining what green measures, the very leak this builder exists
  // to prevent (held `main` red on the candidate-base sha, 2026-06-14).
  delete env.AFFECTED_BASE;
  if (base) env.AFFECTED_BASE = base;
  env.VITEST_MAX_FORKS = env.VITEST_MAX_FORKS ?? '8';
  env.VITEST_MAX_THREADS = env.VITEST_MAX_THREADS ?? '8';
  env.AFFECTED_RETRY_FAILED = env.AFFECTED_RETRY_FAILED ?? '1';
  // VITEST_UNIT_TIMEOUT_MS=180000 (respecting a pre-set value): the gate runs
  // operator-core's heaviest `await import()` unit tests (create-*, hive/guard,
  // coord-program-workflow.smoke, endpoint routes) under 8 concurrent forks that
  // serialize the shared SRC transform — a single cold heavy import measured 74-97s
  // even on an idle box (2026-06-22). The 60s dev default flaked the gate red on
  // ~9 such files (all passing in isolation); 180s gives headroom. Dev/CI keep 60s
  // (libs/test-config reads this env; unset ⇒ 60s).
  env.VITEST_UNIT_TIMEOUT_MS = env.VITEST_UNIT_TIMEOUT_MS ?? '180000';
  return env;
}

/** P-012 failure signature for the release-fixer dedup, folding the SPA-build break in:
 *  a green run has none; otherwise the extracted suite failures, plus the sentinel
 *  `@papercusp/operator-vite` when the build (not the suite) is what failed — so a broken
 *  build holds `main` like any other red and dedups by FAILURE, not the hourly candidate sha. */
export function checkpointFailureSignature(
  fullOutput: string,
  green: boolean,
  buildOk: boolean,
): string[] {
  const failingTests = green ? [] : extractFailingTests(fullOutput);
  if (!buildOk && !failingTests.includes('@papercusp/operator-vite')) failingTests.push('@papercusp/operator-vite');
  return failingTests;
}

/** De-noise the suite (+ build) output for the held-gate broadcast/escalation: drop npm's
 *  error boilerplate (~10 lines/failed-workspace that repeatedly pushed the real `FAIL`
 *  test names out of the tail — cost two diagnosis round-trips 2026-06-06) and keep the
 *  last 2000 chars (FAIL lines, timeouts, assertion output, the SPA-build failure tail). */
export function summarizeSuiteOutput(fullOutput: string): string {
  return fullOutput
    .split('\n')
    .filter((l) => !/^npm error/.test(l))
    .join('\n')
    .slice(-2000);
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
    deps.log(`${cfg.releaseRef} already at integration HEAD ${candidate.slice(0, 8)} — nothing to checkpoint`);
    return { advanced: false, candidate, from: lastReady, green: null, reason: 'up-to-date' };
  }

  // The green pin only ever fast-forwards — refuse a candidate that isn't a descendant.
  if (lastReady && !(await isAncestor(cfg.integrationRoot, lastReady, candidate))) {
    deps.log(`candidate ${candidate.slice(0, 8)} is NOT a descendant of ${cfg.releaseRef} ${lastReady.slice(0, 8)} — refusing`);
    return { advanced: false, candidate, from: lastReady, green: null, reason: 'not-fast-forward' };
  }

  deps.log(`checkpointing candidate ${candidate.slice(0, 8)} (base ${lastReady?.slice(0, 8) ?? 'none'})`);
  await deps.setupTree(candidate);
  const { green, summary, failingTests } = await deps.runGreen(cfg.checkpointRoot, lastReady);
  if (!green) {
    deps.log(`candidate ${candidate.slice(0, 8)} is NOT green — ${cfg.releaseRef} stays at ${lastReady?.slice(0, 8) ?? 'unset'}`);
    await deps
      .broadcast(
        `🟥 green-checkpoint: ${candidate.slice(0, 8)} not green — \`${cfg.releaseRef}\` held at ${lastReady?.slice(0, 8) ?? 'unset'}`,
        summary,
      )
      .catch(() => {});
    // release-pipeline-resilience-2026-06-09 P-005: emit a reaction event on the
    // RED path, symmetric with the `release:green` emit below. A `release-fixer`
    // launch-blueprint (P-006) reacts to this to auto-diagnose the failing test;
    // it also unblocks any agent that `events:await`s the gate verdict. The
    // `summary` is the de-noised failing-test tail already captured above.
    void import('@papercusp/operator-core/lib/events/await/engine')
      .then(({ emitAwaitedEvent }) =>
        emitAwaitedEvent({
          key: 'green-checkpoint:red',
          summary: `green-checkpoint: ${candidate.slice(0, 8)} not green — ${cfg.releaseRef} held`,
          payload: { sha: candidate, from: lastReady ?? null, summary },
          source: 'green-checkpoint',
        }),
      )
      .catch(() => {});
    // P-002: durable human-facing escalation (transition-only, cleared on green).
    await deps.escalate?.(
      `green-checkpoint held: ${candidate.slice(0, 8)} not green`,
      `\`${cfg.releaseRef}\` stays at ${lastReady?.slice(0, 8) ?? 'unset'}.\n\nFailing tail:\n${summary}`,
    ).catch(() => {});
    return { advanced: false, candidate, from: lastReady, green: false, reason: 'not-green', summary, failingTests };
  }

  // F2 (round-4 P-031): the candidate is GREEN — but if the operator is in a definitive
  // per-thread wedge right NOW, don't silently advance the green pin into a degraded
  // runtime. Default-WARN (surface + still advance); BLOCK only when the owner armed
  // block-mode. Flag-gated + fail-soft (a no-op `pass` unless enabled), so the default
  // deploy path is unchanged until the owner opts in.
  const perf = await deps.perfGate?.(candidate).catch(() => undefined);
  if (perf && perf.action !== 'pass') {
    deps.log(perf.summary);
    await deps.broadcast(perf.summary).catch(() => {});
    if (perf.action === 'block') {
      await deps
        .escalate?.(`green-checkpoint held: ${candidate.slice(0, 8)} perf-degraded`, perf.summary)
        .catch(() => {});
      return { advanced: false, candidate, from: lastReady, green: true, reason: 'perf-held', summary: perf.summary };
    }
  }

  // P-016 (agent-tool-delta-protocol D-008): the delta SAFETY gate. If the
  // production semantic-delta flag is ON but the Lane-C scenarios (S23/S24/S25)
  // are not recorded-green-and-fresh, do not advance the green pin into a state
  // that ships an unverified silent-wrong-merge hazard. Default-WARN (surface +
  // still advance); BLOCK only when the owner armed block-mode. Flag-gated +
  // fail-closed-when-armed (a no-op `pass` unless enabled), so the default deploy
  // path is unchanged until the owner opts in.
  const delta = await deps.deltaGate?.(candidate).catch(() => undefined);
  if (delta && delta.action !== 'pass') {
    deps.log(delta.summary);
    await deps.broadcast(delta.summary).catch(() => {});
    if (delta.action === 'block') {
      await deps
        .escalate?.(`green-checkpoint held: ${candidate.slice(0, 8)} delta-unproven`, delta.summary)
        .catch(() => {});
      return { advanced: false, candidate, from: lastReady, green: true, reason: 'delta-held', summary: delta.summary };
    }
  }

  const adv = await deps.advance(candidate);
  if (adv.advanced && !opts.noPush) {
    await deps.push(cfg.releaseRef).catch((e) => deps.log(`warn: push ${cfg.releaseRef} failed: ${e}`));
  }
  deps.log(`✅ ${cfg.releaseRef} advanced ${adv.from?.slice(0, 8) ?? 'none'} → ${candidate.slice(0, 8)} (green)`);
  await deps
    .broadcast(
      `🟩 green-checkpoint: \`${cfg.releaseRef}\` advanced to ${candidate.slice(0, 8)} (green, deployable)`,
      `Was ${adv.from?.slice(0, 8) ?? 'unset'}. The next deploy will pick this up.`,
    )
    .catch(() => {});
  // P-002: the gate recovered — resolve any open `release-not-green` escalation.
  await deps.clearEscalation?.().catch(() => {});
  // await-event-primitive-2026-06-05 P-015: `release:green` is awaitable —
  // an agent blocked on "the next green ready" sleeps on it (events:await)
  // instead of polling the checkpoint. Fire-and-forget.
  void import('@papercusp/operator-core/lib/events/await/engine')
    .then(({ emitAwaitedEvent }) =>
      emitAwaitedEvent({
        key: 'release:green',
        summary: `${cfg.releaseRef} advanced to ${candidate.slice(0, 8)} (green, deployable)`,
        payload: { sha: candidate, from: adv.from },
        source: 'green-checkpoint',
      }),
    )
    .catch(() => {});
  return { advanced: adv.advanced, candidate, from: adv.from, green: true, reason: 'advanced', summary };
}

/** Real effect wiring. The heavy bit — runGreen — runs the configured suite in
 *  the isolated checkpoint tree with AFFECTED_BASE pinned to the last green. */
/** The shell-exec seam realCheckpointDeps shells the heavy ops through. Defaults
 *  to the module's spawn-backed runCmd; injected as a fake so the real-path
 *  WIRING (env-strip, SPA-build-folds-into-green per P-005, the push guard, the
 *  setup-script invocation) is unit-testable without running the suite / build /
 *  a git push (hive-run-evaluation gap #10). */
export type CheckpointExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; allowNonZero?: boolean },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function realCheckpointDeps(cfg: ReleaseConfig, exec: CheckpointExec = runCmd): CheckpointDeps {
  const log = (s: string) => console.log(`[green-checkpoint] ${s}`);
  return {
    async setupTree(ref) {
      const script = path.join(cfg.integrationRoot, 'apps/operator/bin/release/setup-release-checkout.sh');
      // `force` (not `auto`) for the CHECKPOINT tree: the `auto` lockfile/entry-set
      // heuristic is structurally blind to NESTED dependency drift (e.g. astro's nested
      // get-tsconfig@5.0.0-beta.4 vs the hoisted root 4.14.0), so it intermittently left
      // the throwaway checkpoint tree's node_modules stale → spurious DETERMINISTIC reds
      // (astro check "no export readTsconfig"; native-addon-preflight better-sqlite3) that
      // red the gate for the WHOLE fleet while PASSING on the real integration tree
      // (EI-2699). A throwaway, correctness-critical tree must always re-copy from
      // integration; the hardlink (cp -al) copy is cheap. The DEPLOY keeps `auto` + the
      // verify-before-cutover preflight (mcp-host-availability-resilience-2026-06-22).
      await exec('bash', [script, '--ref', ref, '--integration', cfg.integrationRoot, '--release', cfg.checkpointRoot, '--node-modules', 'force']);
    },
    async runGreen(treeDir, base) {
      const [cmd, ...args] = cfg.greenCmd.split(' ');
      // The gate measures the COMMITTED DEFAULTS: buildGreenCheckpointEnv strips the
      // host's identity (all PAPERCUSP_* + HOST_ENV_STRIP), pins AFFECTED_BASE to the
      // last green, caps vitest parallelism + retries once to absorb load-flakes, and
      // marks GREEN_CHECKPOINT=1 (its doc records the incidents behind each rule).
      const env = buildGreenCheckpointEnv(base);
      const r = await exec(cmd, args, { cwd: treeDir, env, allowNonZero: true });

      // P-005: the SPA build is PART of "green". A build break (a bad import, a type
      // error in a bundled module) passes the Vitest suite, then fails at the deploy's
      // swap step (`--build-spa`) and rolls back — needlessly draining + restarting the
      // live :3070 (2026-06-09 13:31–14:00: three rolled-back deploys of the same broken
      // green). Build it here, in the isolated checkpoint tree, so a broken build holds
      // `main` like any other red — before it ever reaches a deploy. Only run it once the
      // suite is green (a red suite already holds `main`; no point building).
      let buildOut = '';
      let buildOk = true;
      if (r.code === 0) {
        // EI-1836: a COMMITTED git conflict marker makes the SPA build die with a
        // cryptic CssSyntaxError ("Unknown word Stashed"). On 2026-06-20 three such
        // markers in globals.css (a bad git-sync auto-merge — the live-merge resolver
        // doesn't catch already-committed ones) froze the SPA/sidecar/WI-280-witness/
        // green-checkpoint builds: the whole fleet deploy, on a stray word in CSS, with
        // no named root. Catch markers HERE, before the expensive+cryptic build, so the
        // held gate NAMES the file:line. git grep (not scripts/check-conflict-markers.mjs)
        // keeps this robust for an older candidate tree predating that script. The ERE
        // mirrors its CONFLICT_MARKER_ERE: 7 of `<`/`>`/`|` at line start — brackets every
        // git conflict, zero false positives (the bare `=======` separator is excluded as
        // FP-prone). git grep exit 0 = match found, 1 = clean.
        const markers = await exec(
          'git',
          ['grep', '-n', '-I', '-E', '^(<{7}|>{7}|\\|{7})([ \\t]|$)', '--', '.'],
          { cwd: treeDir, env, allowNonZero: true },
        );
        if (markers.code === 0 && markers.stdout.trim()) {
          // Treat exactly like a failed build (buildOk=false folds @papercusp/operator-vite
          // into checkpointFailureSignature) and SKIP the build entirely — it would only
          // die cryptically on the same markers.
          buildOk = false;
          buildOut =
            '\n\n=== COMMITTED CONFLICT MARKERS (@papercusp/operator-vite, EI-1836) — would break the SPA build ===\n' +
            markers.stdout;
        } else {
          const b = await exec('npm', ['--workspace', '@papercusp/operator-vite', 'run', 'build'], {
            cwd: treeDir,
            env,
            allowNonZero: true,
          });
          buildOk = b.code === 0;
          if (!buildOk) {
            buildOut = '\n\n=== SPA BUILD FAILED (@papercusp/operator-vite) — would fail the deploy swap ===\n' + b.stdout + b.stderr;
          }
        }
      }
      const green = r.code === 0 && buildOk;
      const fullOutput = r.stdout + r.stderr + buildOut;

      // Persist the FULL suite (+ build) output — the 2000-char tail below repeatedly
      // proved undiagnosable post-hoc ("2 non-quarantined task(s) failed" with no test
      // names survived the truncation; 2026-06-06/07 cost five diagnosis round-trips +
      // manual re-runs). One file per run, tiny disk, names every failure forever.
      try {
        const logDir = cfg.checkpointLogDir;
        mkdirSync(logDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logPath = path.join(logDir, `${stamp}-base-${(base ?? 'none').slice(0, 12)}.log`);
        writeFileSync(logPath, fullOutput);
        log(`full suite output → ${logPath}`);
        // P-014: prune logs older than 14 days so this dir doesn't grow unbounded.
        pruneOldLogs(logDir, 14);
      } catch { /* best-effort — the gate verdict must not depend on logging */ }

      // P-012: a stable failure signature from the FULL output (before truncation), folding
      // the SPA build break in, so the release-fixer dedups by WHAT failed, not the candidate
      // sha. The de-noised 2000-char tail rides the held-gate broadcast/escalation.
      const failingTests = checkpointFailureSignature(fullOutput, green, buildOk);
      const summary = summarizeSuiteOutput(fullOutput);
      return { green, summary, failingTests };
    },
    advance: (candidate) => advanceReady(cfg.integrationRoot, candidate, cfg.releaseRef),
    // PAPERCUSP_MAIN_PUSH_OK=1 — green-checkpoint is the ONE writer allowed past
    // the pre-push guard on `main` (bin/git-hooks/pre-push). Everyone else's
    // pushes to main are blocked by that hook.
    push: async (ref) => {
      await exec('git', ['-C', cfg.integrationRoot, 'push', 'origin', `${ref}:${ref}`], {
        env: { ...process.env, PAPERCUSP_MAIN_PUSH_OK: '1' },
      });
    },
    async broadcast(summary, body) {
      const { sendMessage } = await import('@papercusp/operator-core/lib/agent-tools/coordination/messages');
      await sendMessage(
        { ownerId: 'green-checkpoint', ownerLabel: 'green-checkpoint', source: 'static-client', workspaceId: null, userId: null },
        { to: ['*'], summary, body, category: 'service-health' },
      );
    },
    // P-002: durable human-facing escalation surface for a held gate. Tagged
    // `source: 'green-checkpoint'` so the open/clear pair is idempotent across
    // the hourly tick. Fail-safe — the gate verdict never depends on this.
    async escalate(summary, body) {
      const { openEscalation, listEscalations } = await import(
        '@papercusp/operator-core/lib/agent-tools/coordination/escalations'
      );
      const open = await listEscalations({ status: 'open' });
      if (open.some((e) => (e as Record<string, unknown>).source === 'green-checkpoint')) return;
      await openEscalation(
        { ownerId: 'green-checkpoint', ownerLabel: 'green-checkpoint', source: 'static-client', workspaceId: null, userId: null },
        { severity: 'blocker', summary, body, meta: { source: 'green-checkpoint' } },
      );
    },
    async clearEscalation() {
      const { listEscalations, resolveEscalation } = await import(
        '@papercusp/operator-core/lib/agent-tools/coordination/escalations'
      );
      const open = await listEscalations({ status: 'open' });
      for (const e of open) {
        if ((e as Record<string, unknown>).source === 'green-checkpoint') {
          await resolveEscalation({
            msg_id: e.msg_id,
            choice: 'gate green',
            resolver: 'green-checkpoint',
          }).catch(() => {});
        }
      }
    },
    // F2 (round-4 P-031): the real perf gate reads the latest perf-signals-v1 capture
    // and evaluates it against the per-thread budgets; policy comes from the env flags
    // (PAPERCUSP_PERF_GATE / PAPERCUSP_PERF_GATE_BLOCK). Inert (`pass`, reads nothing)
    // until the owner enables it.
    perfGate: (candidate) => runPerfGate(perfGatePolicyFromEnv(), candidate),
    // P-016 (agent-tool-delta-protocol D-008): the real delta gate reads the
    // baked production delta-flag default + the latest recorded Lane-C scenario
    // verdicts (llm_test_runs) — NOT a synchronous live-model eval. Policy from
    // the env flags (PAPERCUSP_DELTA_GATE / PAPERCUSP_DELTA_GATE_BLOCK). Inert
    // (`pass`, reads nothing) until the owner enables it.
    deltaGate: (candidate) =>
      runDeltaGate(deltaGatePolicyFromEnv(), candidate, {
        readFlagEnabled: async () => {
          const { FLAG_DEFAULTS, FLAGS } = await import('@papercusp/flags');
          // The deploy-gate signal is the BAKED default that ships, not a
          // per-user PostHog eval — "is the delta opt-in flipped on in this build".
          return FLAG_DEFAULTS[FLAGS.TOOL_DELTA_PROTOCOL] === true;
        },
        readVerdicts: async (ids) => {
          const { latestScenarioVerdicts } = await import(
            '@papercusp/operator-core/lib/llm-testing/storage'
          );
          return latestScenarioVerdicts(ids);
        },
        now: () => Date.now(),
      }),
    log,
  };
}

/** P-014: delete checkpoint-log files older than `days` so the dir doesn't grow
 *  unbounded (it was trending ~16MB / 43 files in 3 days). Best-effort, never throws. */
function pruneOldLogs(dir: string, days: number): void {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch { /* skip a vanished/locked file */ }
    }
  } catch { /* dir gone — nothing to prune */ }
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
      // The pretty result goes to STDERR (human-readable); STDOUT carries ONLY the
      // single marker line. CRITICAL for cross-version compat: the routine that invokes
      // this CLI runs from the integration tree, so a DEPLOYED (older) green-checkpoint
      // handler — which still brace-slices stdout `slice(indexOf('{'), lastIndexOf('}'))`
      // — runs THIS newer CLI. Two JSON objects on stdout (pretty + marker) made that
      // slice span both + the marker text → invalid JSON → recorded 'error' (and wedged
      // the pipeline). One object on stdout keeps the old brace-slice AND the new marker
      // parse both working.
      console.error(JSON.stringify(r, null, 2));
      console.log(`${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify(r)}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[green-checkpoint] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
