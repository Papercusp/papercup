#!/usr/bin/env tsx
/**
 * P-007 (green-main-fast-2026-08-25): the ACTUATOR for `gate-auto-repair`.
 *
 * Finds generated artifacts whose freshness checker is failing, regenerates them, and
 * re-verifies with that same checker. A stale generated artifact is the single most
 * pointless way to hold `main` red — the whole remedy is "run the generator" — and this
 * makes clearing the whole class a one-liner instead of an archaeology session.
 *
 * ## Why this is a STANDALONE script and not a green-checkpoint.ts caller
 *
 * The obvious placement is inside the gate, repairing before it judges. That is
 * deliberately NOT what this is, and the reason is measured rather than cautious:
 * `apps/operator/lib/release/green-checkpoint.ts` is shared MULTI-TENANT code executed
 * straight from the staging tree with NO deploy hop — a co-hosted install's scheduled
 * gate booted an edit to it 81 seconds after that edit was saved (plan decision D-009).
 * So wiring an auto-repair caller into the gate changes promotion behaviour for every
 * co-hosted install on its next scheduled run, which is an owner-facing call.
 *
 * An explicitly-invoked tool has none of that blast radius: it runs when a human or an
 * agent asks it to, on the tree in front of it, and it delivers P-007's actual value
 * today. Wiring the gate remains available later; this does not foreclose it, and the
 * decision layer it calls is the same one the gate would use.
 *
 * ## What it will NOT do
 *
 *   - It does not commit. git-sync owns commit+push on this tree; a second committer is
 *     how you get races nobody can reproduce. Repaired files are simply left in the tree
 *     for the normal sweep.
 *   - It does not retry. `assessRepairOutcomes` returns `retryRecommended: false` on
 *     every shape, and this honours it: a repair that did not take on the first pass is
 *     a real problem, and re-running the generator is how auto-repair becomes a loop
 *     that hides one.
 *   - It does not run anything outside the DERIVED `gen:X` / `gen:X:check` pairs. See
 *     plan decision D-011: a hygiene `remedy` string is prose for a human and is not
 *     reliably a fixer (one entry's remedy is the failing checker itself).
 *
 * ## Usage
 *
 *   npx tsx scripts/repair-stale-generated-artifacts.ts            # report only
 *   npx tsx scripts/repair-stale-generated-artifacts.ts --fix      # repair + re-verify
 *   npx tsx scripts/repair-stale-generated-artifacts.ts --only=gen:declarations:check
 *   npx tsx scripts/repair-stale-generated-artifacts.ts --entries=a,b --fix
 *
 * `--entries` skips the detection sweep and takes the failing set directly — that is the
 * shape a gate's `AFFECTED_TESTS_FAILING_FILES` line gives you, so a red can be triaged
 * without re-running all 17 checkers.
 *
 * Exit codes: 0 = nothing stale, or (with --fix) everything repaired and re-verified.
 *             1 = something is stale (report mode) or did not repair clean (--fix).
 *             2 = misuse.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessRepairOutcomes,
  decideAutoRepair,
  type RepairOutcome,
} from "../packages/operator-core/lib/release/gate-auto-repair.ts";
import { deriveGeneratedArtifactHygiene } from "../packages/operator-core/lib/release/gate-hygiene-split.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  fix: boolean;
  only: string[];
  entries: string[] | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { fix: false, only: [], entries: null };
  for (const a of argv) {
    if (a === "--fix") out.fix = true;
    else if (a.startsWith("--only=")) {
      out.only = a.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith("--entries=")) {
      out.entries = a.slice("--entries=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--help" || a === "-h") {
      console.log("See the header of scripts/repair-stale-generated-artifacts.ts");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/** Run a root npm script. Inherits nothing: output is captured so a 17-checker sweep
 *  does not bury the summary that matters. */
function runScript(script: string): { exitCode: number } {
  const r = spawnSync("npm", ["run", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15 * 60 * 1_000,
    // A generator that asks a question would hang the sweep forever.
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) return { exitCode: 127 };
  return { exitCode: typeof r.status === "number" ? r.status : 1 };
}

/** The set of dirty paths, as git sees them right now. */
function dirtyPaths(): Set<string> {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const set = new Set<string>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const p = line.slice(3).trim();
    if (p) set.add(p);
  }
  return set;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  const rootScripts: Record<string, string> = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ).scripts;

  const derived = [...deriveGeneratedArtifactHygiene(rootScripts).keys()];
  if (derived.length === 0) {
    console.error(
      "REPAIR_ABORT reason=no-derived-pairs — no 'gen:X' + 'gen:X:check' pair exists in " +
        "the root package.json. Refusing rather than reporting a vacuous clean sweep.",
    );
    return 2;
  }

  let failing: string[];

  if (args.entries) {
    // Trusted directly: this is the gate's own failing list being triaged.
    failing = args.entries;
    console.log(`REPAIR_INPUT source=entries count=${failing.length}`);
  } else {
    const candidates = args.only.length > 0 ? args.only : derived;
    const unknown = candidates.filter((c) => !derived.includes(c));
    if (unknown.length > 0) {
      console.error(
        `REPAIR_ABORT reason=not-a-derived-pair entries=${unknown.join(",")} — ` +
          `refusing to run a checker that has no paired generator.`,
      );
      return 2;
    }
    console.log(`REPAIR_SWEEP checkers=${candidates.length}`);
    failing = [];
    for (const checker of candidates) {
      const { exitCode } = runScript(checker);
      const state = exitCode === 0 ? "current" : "STALE";
      console.log(`REPAIR_CHECK entry=${checker} exit=${exitCode} state=${state}`);
      if (exitCode !== 0) failing.push(checker);
    }
  }

  if (failing.length === 0) {
    console.log("REPAIR_SUMMARY stale=0 — every generated artifact is current.");
    return 0;
  }

  const decision = decideAutoRepair({ failures: failing, ctx: { rootScripts } });

  for (const u of decision.unrepairable) {
    console.log(`REPAIR_SKIP entry=${u.entry} why=${JSON.stringify(u.why)}`);
  }
  for (const p of decision.productFailures) {
    console.log(`REPAIR_PRODUCT entry=${p.entry} reason=${JSON.stringify(p.reason)}`);
  }

  if (!decision.repair) {
    console.log(`REPAIR_SUMMARY repairable=0 reason=${JSON.stringify(decision.reason)}`);
    return 1;
  }

  if (!args.fix) {
    for (const s of decision.steps) {
      console.log(`REPAIR_PLAN entry=${s.entry} repair='${s.repairCommand}' verify='${s.verifyCommand}'`);
    }
    console.log(
      `REPAIR_SUMMARY stale=${decision.steps.length} mode=report — re-run with --fix to repair.`,
    );
    return 1;
  }

  const outcomes: RepairOutcome[] = [];
  for (const step of decision.steps) {
    const before = dirtyPaths();
    const repair = runScript(step.repairCommand.replace(/^npm run /, ""));
    const after = dirtyPaths();

    // NOTE ON producedDiff: git-sync sweeps this tree on a schedule, so a concurrent
    // commit can retire a path between the two snapshots. That direction only REMOVES
    // entries, and we look for ADDED ones, so a sweep cannot manufacture a false
    // `true`. It can in principle mask a real change into a false `false` — which only
    // affects the DIAGNOSTIC split between `still-failing` and `not-stale-product`,
    // never whether the entry blocks. Both block.
    const producedDiff = [...after].some((p) => !before.has(p));

    const verify =
      repair.exitCode === 0 ? runScript(step.verifyCommand.replace(/^npm run /, "")) : { exitCode: 1 };

    outcomes.push({
      entry: step.entry,
      repairExitCode: repair.exitCode,
      verifyExitCode: verify.exitCode,
      producedDiff,
    });
  }

  const assessment = assessRepairOutcomes(outcomes);
  for (const r of assessment.results) {
    console.log(`REPAIR_RESULT entry=${r.entry} verdict=${r.verdict}`);
  }
  console.log(
    `REPAIR_SUMMARY allRepaired=${assessment.allRepaired} ` +
      `stillBlocking=${assessment.stillBlocking.join(",") || "(none)"} ` +
      `retryRecommended=${assessment.retryRecommended}`,
  );
  console.log(
    "REPAIR_NOTE this script does not commit — git-sync owns commit+push; repaired files " +
      "are left in the tree for the normal sweep.",
  );

  return assessment.allRepaired ? 0 : 1;
}

process.exit(main());
