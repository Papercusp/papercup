/**
 * `system:template-gym` — the template gym cadence action
 * (app-templates-2026-07-04 P-009; seeded by seed-template-gym-routine.ts).
 *
 * Per tick: shell out to template-gym-runner.ts (the standalone CLI in this
 * same dir — mirrors the release-actions/p2p-perf layering), which re-verifies
 * the five anti-rot legs (materialization verbatim-copy, docs⇄catalog drift,
 * kit drift pins, template-side suite, consumer #1's materialized union). Any
 * RED leg auto-files a **template-drift work-item** via `captureImprovement`,
 * pre-filtered by an exact `findIssuesByWatchdogKeys` lookup (EI-7254: fuzzy
 * title dedup is defeated once near-duplicates accumulate — the stable
 * watchdogKey `template-gym:<leg>` is the authoritative once-per-standing-red
 * guard). The gym is advisory: it never gates anything; it files.
 *
 * Interruption classification reuses p2p-perf's exported
 * `classifyNoSummaryRun` (EI-5753): a signal-killed run (bg-host restart /
 * OOM) is NOT a finding; a timeout files as human-reviewed `kind:'change'`;
 * only a genuine crash files as `kind:'bug'`.
 *
 * Single-flight lock (the p2p-perf-reaper-requeue-oom lesson): the multi-minute
 * shell-out has no DBOS step, so the executor reaper may cancel + requeue the
 * fire while the OS child still runs — the lock makes every requeued fire a
 * fast no-op skip instead of a second stacked runner.
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerSystemAction, type SystemActionCtx } from "./system-actions";
import { captureImprovement } from "../improvements/capture-core";
import { findIssuesByWatchdogKeys } from "../../issues-engineer";
import { classifyNoSummaryRun } from "./p2p-perf-actions";
import type { GymRunSummary } from "./template-gym-runner";

const RUNNER_REL = "packages/operator-core/lib/harness/routines/template-gym-runner.ts";
const RUN_TIMEOUT_MS = 25 * 60_000;

function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), "..", "..");
}

// --- single-flight lock (same semantics as p2p-perf-actions; see its doc-comment) ---

interface GymRunLock {
  pid: number;
  startedAt: number;
}

const LOCK_PATH = path.join(os.tmpdir(), "papercusp-template-gym.lock");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(maxAgeMs: number): boolean {
  try {
    const cur = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as GymRunLock;
    if (pidAlive(cur.pid) && Date.now() - cur.startedAt < maxAgeMs) return false;
  } catch {
    /* no lock — acquire */
  }
  try {
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies GymRunLock));
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    const cur = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as GymRunLock;
    if (cur.pid === process.pid) rmSync(LOCK_PATH, { force: true });
  } catch {
    /* already gone */
  }
}

// --- EI-7254 pre-filter (exact indexed watchdogKey lookup, not fuzzy title search) ---

async function openIssueExistsForKeys(keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const issues = await findIssuesByWatchdogKeys([...keys]).catch(() => []);
  const open = new Set<string>();
  for (const i of issues) {
    if (i.state !== "open") continue;
    const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
    if (typeof k === "string") open.add(k);
  }
  return open;
}

/** Stable per-leg key — never embeds live output, so a standing red files ONCE. */
export function gymWatchdogKey(leg: string): string {
  return `template-gym:${leg}`;
}

// --- the runner shell-out (detached ⇒ whole vitest subtree killable on timeout) ---

interface RunnerResult {
  code: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function runRunner(root: string, args: string[], timeoutMs: number): Promise<RunnerResult> {
  return new Promise((resolve) => {
    const child = spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, RUNNER_REL), ...args], {
      cwd: root,
      env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: root },
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* dead */
        }
      }
    };
    let escalate: NodeJS.Timeout | null = null;
    const killer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      escalate = setTimeout(() => killTree("SIGKILL"), 15_000);
      escalate.unref();
    }, timeoutMs);
    const finish = (res: RunnerResult): void => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolve(res);
    };
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => finish({ code: 1, stdout, stderr: stderr + String(e), signal: null, timedOut }));
    child.on("close", (code, signal) => finish({ code: code ?? 1, stdout, stderr, signal: signal ?? null, timedOut }));
  });
}

// --- filing ---

/** docs-catalog drift is a doc-sync chore (human-reviewed change); every other
 *  red leg is a real template-system defect (auto-implement-eligible bug). */
function filingFor(leg: string): { kind: "bug" | "change"; severity: "major" | "minor" } {
  return leg === "docs-catalog" ? { kind: "change", severity: "minor" } : { kind: "bug", severity: "major" };
}

async function fileRedLegs(summary: GymRunSummary): Promise<void> {
  const red = summary.legs.filter((l) => !l.ok);
  if (red.length === 0) return;
  const alreadyOpen = await openIssueExistsForKeys(red.map((l) => gymWatchdogKey(l.leg)));
  for (const l of red) {
    const watchdogKey = gymWatchdogKey(l.leg);
    if (alreadyOpen.has(watchdogKey)) continue; // a standing red already has an open item
    const { kind, severity } = filingFor(l.leg);
    await captureImprovement({
      kind,
      severity,
      // Stable title (no live output) — dedup-friendly; the volatile detail goes in the body.
      title: `template-drift: gym leg '${l.leg}' is RED`,
      body:
        `system:template-gym run ${summary.runId} (${summary.startedAt}): leg '${l.leg}' failed.\n\n` +
        `${l.detail}\n\n` +
        `papercup: ${summary.papercupRoot}\nquartermaster (consumer #1): ${summary.quartermasterRoot}\n` +
        `Re-run manually: npx tsx ${RUNNER_REL} --legs ${l.leg}\n` +
        `Rule of repair: templates/<id>/checks are the source of truth — re-materialize into the app, ` +
        `never hand-edit app-side copies; manifest/docs drift is fixed at the source that moved.\n` +
        `(auto-filed by system:template-gym — app-templates-2026-07-04 P-009)`,
      source: "su",
      sourceRole: "system",
      dedupScope: "open",
      createdBy: "system:template-gym",
      watchdogKey,
    }).catch(() => {
      /* dedup-decline / capture failure never breaks the routine */
    });
  }
}

/** Exported for the unit test (watchdogKey stability + filing classification). */
export const _testing = { fileRedLegs, filingFor };

// --- the action ---

async function runTemplateGym(ctx: SystemActionCtx): Promise<void> {
  const root = integrationRoot();
  if (!acquireLock(RUN_TIMEOUT_MS + 5 * 60_000)) {
    // eslint-disable-next-line no-console
    console.info("[template-gym] a run already holds the lock — skipping this (likely reaper-requeued) fire");
    return;
  }
  try {
    const summaryPath = path.join(os.tmpdir(), `template-gym-${Date.now()}.json`);
    const args = ["--summary-json", summaryPath];
    const qmRoot = ctx.triggerConfig?.qmRoot;
    if (typeof qmRoot === "string" && qmRoot) args.push("--qm-root", qmRoot);
    const r = await runRunner(root, args, RUN_TIMEOUT_MS);

    let summary: GymRunSummary | null = null;
    try {
      summary = JSON.parse(readFileSync(summaryPath, "utf8")) as GymRunSummary;
    } catch {
      summary = null;
    }

    if (!summary) {
      const cls = classifyNoSummaryRun(r);
      if (cls === "signal") {
        // eslint-disable-next-line no-console
        console.info(`[template-gym] run interrupted by a signal (exit ${r.code}) — not a finding; next cycle re-runs`);
        return;
      }
      const mins = Math.round(RUN_TIMEOUT_MS / 60_000);
      await captureImprovement({
        kind: cls === "timeout" ? "change" : "bug",
        severity: cls === "timeout" ? "minor" : "major",
        title:
          cls === "timeout"
            ? `template-gym run overran its ${mins}min budget`
            : `template-gym runner failed to produce a summary (exit ${r.code})`,
        body:
          `system:template-gym could not complete.\nexit ${r.code}${r.signal ? `, signal ${r.signal}` : ""}` +
          `${r.timedOut ? " (killed by our timeout)" : ""}\nstderr tail:\n${r.stderr.slice(-1500)}\n` +
          `(auto-filed by system:template-gym — P-009)`,
        source: "su",
        sourceRole: "system",
        dedupScope: "open",
        createdBy: "system:template-gym",
        watchdogKey: gymWatchdogKey(cls === "timeout" ? "run-timeout" : "runner-crash"),
      }).catch(() => {});
      return;
    }

    // eslint-disable-next-line no-console
    console.info(
      `[template-gym] run ${summary.runId}: ${summary.green ? "ALL GREEN" : "RED"} — ` +
        summary.legs.map((l) => `${l.leg}=${l.ok ? "green" : "RED"}`).join(", ") +
        ` (record: ~/.papercusp/template-gym/last-run.json)`,
    );
    await fileRedLegs(summary);
  } finally {
    releaseLock();
  }
}

registerSystemAction("template-gym", runTemplateGym);
