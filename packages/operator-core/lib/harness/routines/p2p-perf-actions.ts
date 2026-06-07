/**
 * p2p-perf system actions — p2p-performance-suite-2026-06-07 P-014.
 *
 * Two cron routines (seeded by `seed-p2p-perf-routines.ts`):
 *   - `system:p2p-perf-tier1` — NIGHTLY Tier-1 run (loopback benches, ci
 *     profile) against the committed baseline.
 *   - `system:p2p-perf-tier2` — WEEKLY Tier-2 run (netem WAN matrix; skips
 *     cleanly on hosts without userns).
 * Tier 3 (real frames) is deliberately NOT here — on-demand only (D-004).
 *
 * Findings that cross thresholds AUTO-FILE via `captureImprovement` (the
 * improvements backlog, kind=bug): every loop-lag SLO violation (D-003 — the
 * headline gate) and every advisory regression past tolerance. capture-core's
 * search-first dedup means a STANDING regression files once, not nightly.
 * The run itself stays advisory (D-005): the routine never gates anything.
 *
 * Mirrors release-actions.ts layering: the handler SHELLS OUT to the runner
 * (which lives in this same package but is designed as a standalone tsx CLI)
 * and runs it from the INTEGRATION tree so nightly numbers track staging.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { captureImprovement } from '../improvements/capture-core';
import type { RunSummary } from '../../sync/hyperbee/perf/runner';

const RUNNER_REL = 'packages/operator-core/lib/sync/hyperbee/perf/runner.ts';

function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

function tsxBin(root: string): string {
  return path.join(root, 'node_modules/.bin/tsx');
}

function runRunner(
  root: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(tsxBin(root), [path.join(root, RUNNER_REL), ...args], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root },
    });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ code: 1, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** File one improvement per threshold-crossing finding (deduped by capture-core). */
async function fileFindings(summary: RunSummary, tierLabel: string): Promise<void> {
  for (const v of summary.sloViolations) {
    await captureImprovement({
      kind: 'bug',
      severity: 'major',
      title: `p2p-perf SLO violation: ${v.scenario} loop-lag p95 ${v.p95Ms}ms (limit ${v.limitMs}ms)`,
      body:
        `${tierLabel} run ${summary.runId} (profile ${summary.profile}): host event-loop lag p95 ` +
        `crossed the D-003 SLO while sync ran.\nscenario: ${v.scenario} [${v.paramsKey}]\n` +
        `p95=${v.p95Ms}ms limit=${v.limitMs}ms\nartifacts: ${summary.outDir}\nreport: ${summary.reportPath}\n` +
        `(auto-filed by system:p2p-perf — p2p-performance-suite-2026-06-07 P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
    }).catch(() => {
      // capture-core declines duplicates — exactly what we want for a standing
      // violation; any other failure must not break the routine.
    });
  }
  for (const r of summary.regressions) {
    await captureImprovement({
      kind: 'bug',
      severity: 'minor',
      title: `p2p-perf regression: ${r.scenario} ${r.metric} ${r.baseline} → ${r.current} (${Math.round(r.relChange * 100)}% worse)`,
      body:
        `${tierLabel} run ${summary.runId} (profile ${summary.profile}): metric regressed past the ` +
        `advisory tolerance vs the committed baseline (D-005 — informational, not gating).\n` +
        `scenario: ${r.scenario} [${r.paramsKey}]\nmetric: ${r.metric}: ${r.baseline} → ${r.current}\n` +
        `artifacts: ${summary.outDir}\nreport: ${summary.reportPath}\n` +
        `(auto-filed by system:p2p-perf — p2p-performance-suite-2026-06-07 P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
    }).catch(() => {
      /* dedup-decline / capture failure never breaks the routine */
    });
  }
}

async function runTier(ctx: SystemActionCtx, tier: '--tier1' | '--tier2', timeoutMs: number): Promise<void> {
  const root = integrationRoot();
  const label = tier === '--tier1' ? 'nightly Tier-1' : 'weekly Tier-2';
  const summaryPath = path.join(os.tmpdir(), `p2p-perf-${tier.slice(2)}-${Date.now()}.json`);
  const r = await runRunner(root, [tier, '--profile', 'ci', '--summary-json', summaryPath], timeoutMs);

  let summary: RunSummary | null = null;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary;
  } catch {
    summary = null;
  }

  if (!summary) {
    // The runner died before writing a summary — that IS a finding.
    await captureImprovement({
      kind: 'bug',
      severity: 'major',
      title: `p2p-perf ${label} run failed to produce a summary (exit ${r.code})`,
      body:
        `system:p2p-perf could not complete the ${label} run.\nexit code: ${r.code}\n` +
        `stderr tail:\n${r.stderr.slice(-1500)}\n(auto-filed by system:p2p-perf — P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
    }).catch(() => {});
    return;
  }

  // eslint-disable-next-line no-console
  console.info(
    `[p2p-perf] ${label} run ${summary.runId}: ${summary.artifacts} artifacts, ` +
      `${summary.sloViolations.length} SLO violations, ${summary.regressions.length} regressions, ` +
      `${summary.improvements} improvements (advisory — D-005). Report: ${summary.reportPath}`,
  );
  await fileFindings(summary, label);
  for (const f of summary.scenarioFailures) {
    await captureImprovement({
      kind: 'bug',
      severity: 'major',
      title: `p2p-perf scenario crashed in ${label} run: ${f.slice(0, 140)}`,
      body: `Run ${summary.runId}: scenario failure.\n${f}\nartifacts: ${summary.outDir}\n(auto-filed by system:p2p-perf — P-014)`,
      source: 'su',
      sourceRole: 'system',
      dedupScope: 'open',
      createdBy: 'system:p2p-perf',
    }).catch(() => {});
  }
  void ctx;
}

// Nightly Tier-1 — 30 min bound (ci profile measures ~10-15 min on the dev box).
registerSystemAction('p2p-perf-tier1', (ctx) => runTier(ctx, '--tier1', 30 * 60_000));

// Weekly Tier-2 — netem cells are deliberately slow under impairment; 60 min bound.
registerSystemAction('p2p-perf-tier2', (ctx) => runTier(ctx, '--tier2', 60 * 60_000));
