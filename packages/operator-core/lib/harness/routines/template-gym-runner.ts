/**
 * Template-gym runner — app-templates-2026-07-04 P-009 (anti-rot, D-007).
 *
 * "The template is tested by building an app from it": this runner re-verifies,
 * on a cadence, that the templates system and its consumer #1 (quartermaster,
 * retrofitted as-if-template-built in P-013) still agree — and that the whole
 * two-sided acceptance union still runs green. Five legs, cheap → expensive:
 *
 *   1. `materialization` — the P-013 verbatim-copy invariant: every portable
 *      check under `templates/<id>/checks/*.test.ts` (except the declared
 *      repo-side-only ones) exists BYTE-IDENTICAL in quartermaster's
 *      `packages/template-checks/`. A template check that moved without a
 *      re-materialization is exactly the drift this gym exists to catch.
 *   2. `docs-catalog` — every `COMPONENT_CATALOG` component id is still
 *      mentioned in the published catalog page
 *      (`templates-component-catalog.mdx`): the docs⇄machine-catalog drift check.
 *   3. `kit-suite` — `@papercusp/template-kit` tests: the reference-manifest
 *      drift pins (templates/<id>/template.yaml ⇄ kit reference manifests),
 *      checks-config schema, composition semantics.
 *   4. `template-suite` — `@papercusp/templates` workspace tests: the template
 *      SET validates + composes (composition-integrity, unconfigured legs skip).
 *   5. `app-checks` — the materialized union INSIDE consumer #1: quartermaster's
 *      `packages/template-checks` run configured (`TEMPLATE_CHECKS_CONFIG=
 *      ./checks-config.json`) — confinement guard, seam round-trip (incl. the
 *      delegated integration leg), gym signals, boot attach.
 *
 * Standalone CLI (also shelled out to by `system:template-gym`,
 * template-gym-action.ts — mirrors the release-actions/p2p-perf layering):
 *
 *   npx tsx packages/operator-core/lib/harness/routines/template-gym-runner.ts \
 *     [--summary-json <path>] [--qm-root <path>] [--legs leg1,leg2]
 *
 * Roots: the papercup root is derived from THIS file's location (the runner
 * always tests the tree it lives in); the quartermaster root defaults to the
 * SIBLING clone `../quartermaster` (the canonical clones layout), overridable
 * via --qm-root / TEMPLATE_GYM_QM_ROOT. Exit 0 iff every leg is green. Each
 * run is also recorded durably at ~/.papercusp/template-gym/ (last-run.json +
 * runs.jsonl) — the gym's own history, independent of the caller.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENTIC_DESKTOP_APP_TEMPLATE, REFERENCE_TEMPLATES, resolveRequiresClosure } from "@papercusp/template-kit";

// ---------------------------------------------------------------- pure core

export interface MaterializationDrift {
  /** Template check files with NO counterpart in the app's template-checks dir. */
  missing: string[];
  /** Files present on both sides but no longer byte-identical. */
  changed: string[];
}

/**
 * The P-013 verbatim-copy invariant, as a pure function. `templateFiles` maps
 * check basename → template-side content; `appFiles` maps basename →
 * app-side content. `repoOnly` names checks that deliberately are NOT
 * materialized into apps (composition-integrity runs template-side as the
 * `@papercusp/templates` workspace suite).
 */
export function diffMaterialization(
  templateFiles: ReadonlyMap<string, string>,
  appFiles: ReadonlyMap<string, string>,
  repoOnly: ReadonlySet<string>,
): MaterializationDrift {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [name, content] of templateFiles) {
    if (repoOnly.has(name)) continue;
    const app = appFiles.get(name);
    if (app === undefined) missing.push(name);
    else if (app !== content) changed.push(name);
  }
  missing.sort();
  changed.sort();
  return { missing, changed };
}

/**
 * Docs⇄catalog drift: which machine-catalog component ids does the published
 * catalog page no longer mention? Substring match is deliberate — the page may
 * render ids inside backticks, tables, or headings.
 */
export function findCatalogDocDrift(catalogIds: readonly string[], mdxText: string): string[] {
  return catalogIds.filter((id) => !mdxText.includes(id)).sort();
}

/** Checks that live template-side only — never materialized into a composed app. */
export const REPO_ONLY_CHECKS: ReadonlySet<string> = new Set(["composition-integrity.test.ts"]);

// ------------------------------------------------------------- fs + process

interface LegResult {
  leg: string;
  ok: boolean;
  /** Short human diagnosis; on a red suite leg, the output tail. */
  detail: string;
  durationMs: number;
}

export interface GymRunSummary {
  runId: string;
  startedAt: string;
  papercupRoot: string;
  quartermasterRoot: string;
  legs: LegResult[];
  green: boolean;
}

function papercupRootFromHere(): string {
  // …/packages/operator-core/lib/harness/routines/<this> → repo root is 5 up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
}

/**
 * The template ids consumer #1 (quartermaster) actually COMPOSES — the
 * agentic-desktop-app requires-closure, derived from the kit so it
 * self-maintains (P-022's re-layer onto desktop-app updates it without
 * touching the gym). The P-013 verbatim-copy invariant applies to THESE
 * templates only: a template qm does not consume (data-sync, search, …)
 * has no qm-side twin by design and must not red the leg (P-017 fix).
 */
function consumer1TemplateIds(): Set<string> {
  const closure = resolveRequiresClosure([AGENTIC_DESKTOP_APP_TEMPLATE], REFERENCE_TEMPLATES);
  // Fallback (a broken closure fails the kit-suite leg loudly anyway): the 3-way split.
  if (!closure.ok) return new Set(["agentic-desktop-app", "papercusp-ops-hives", "tauri-desktop-shell"]);
  return new Set(closure.templates.map((t) => t.id));
}

/** Scan templates/<id>/checks/*.test.ts for consumer #1's composed set (skip node_modules / dot dirs). */
function readTemplateCheckFiles(papercupRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const templatesDir = path.join(papercupRoot, "templates");
  const consumed = consumer1TemplateIds();
  for (const d of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "node_modules" || d.name.startsWith(".")) continue;
    if (!consumed.has(d.name)) continue;
    const checksDir = path.join(templatesDir, d.name, "checks");
    if (!existsSync(checksDir)) continue;
    for (const f of readdirSync(checksDir)) {
      if (!f.endsWith(".test.ts")) continue;
      out.set(f, readFileSync(path.join(checksDir, f), "utf8"));
    }
  }
  return out;
}

function readAppCheckFiles(qmRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = path.join(qmRoot, "packages", "template-checks");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".test.ts")) continue;
    out.set(f, readFileSync(path.join(dir, f), "utf8"));
  }
  return out;
}

/** Prefer the package-local vitest bin (exact workspace version), else the hoisted root one. */
function vitestBin(repoRoot: string, pkgDir: string): string {
  const local = path.join(pkgDir, "node_modules", ".bin", "vitest");
  if (existsSync(local)) return local;
  return path.join(repoRoot, "node_modules", ".bin", "vitest");
}

interface SpawnOutcome {
  code: number;
  timedOut: boolean;
  tail: string;
}

function runSuite(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    // detached ⇒ own process group, so the timeout can kill the whole subtree
    // (vitest worker pools), not just the direct child — the p2p-perf lesson.
    const child = spawn(bin, args, { cwd, env, detached: true });
    let out = "";
    let timedOut = false;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
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
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolve({ code: 1, timedOut, tail: (out + String(e)).slice(-2000) });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolve({ code: code ?? 1, timedOut, tail: out.slice(-2000) });
    });
  });
}

// ---------------------------------------------------------------------- legs

const SUITE_TIMEOUT_MS = 10 * 60_000; // per suite leg; the seam integration leg alone budgets 330s

async function legMaterialization(papercupRoot: string, qmRoot: string): Promise<LegResult> {
  const t0 = Date.now();
  const templateFiles = readTemplateCheckFiles(papercupRoot);
  const appFiles = readAppCheckFiles(qmRoot);
  if (templateFiles.size === 0) {
    return { leg: "materialization", ok: false, detail: `no template checks found under ${papercupRoot}/templates`, durationMs: Date.now() - t0 };
  }
  if (appFiles.size === 0) {
    return {
      leg: "materialization",
      ok: false,
      detail: `no materialized checks at ${qmRoot}/packages/template-checks — consumer #1 missing or qm root wrong`,
      durationMs: Date.now() - t0,
    };
  }
  const drift = diffMaterialization(templateFiles, appFiles, REPO_ONLY_CHECKS);
  const ok = drift.missing.length === 0 && drift.changed.length === 0;
  return {
    leg: "materialization",
    ok,
    detail: ok
      ? `${templateFiles.size} template checks; ${appFiles.size} materialized; verbatim-identical`
      : `missing in app: [${drift.missing.join(", ")}]; diverged: [${drift.changed.join(", ")}] — re-materialize from templates/ (never hand-edit app-side)`,
    durationMs: Date.now() - t0,
  };
}

async function legDocsCatalog(papercupRoot: string): Promise<LegResult> {
  const t0 = Date.now();
  const kitIndex = path.join(papercupRoot, "libs", "generic", "template-kit", "src", "index.ts");
  const mdxPath = path.join(
    papercupRoot,
    "apps",
    "operator-docs",
    "src",
    "content",
    "docs",
    "agent-insights",
    "templates-component-catalog.mdx",
  );
  try {
    const kit = (await import(pathToFileURL(kitIndex).href)) as { COMPONENT_CATALOG?: Array<{ id: string }> };
    const ids = (kit.COMPONENT_CATALOG ?? []).map((c) => c.id);
    if (ids.length === 0) {
      return { leg: "docs-catalog", ok: false, detail: "COMPONENT_CATALOG is empty or not exported", durationMs: Date.now() - t0 };
    }
    const mdx = readFileSync(mdxPath, "utf8");
    const drift = findCatalogDocDrift(ids, mdx);
    return {
      leg: "docs-catalog",
      ok: drift.length === 0,
      detail:
        drift.length === 0
          ? `${ids.length} catalog component ids all present in templates-component-catalog.mdx`
          : `catalog ids missing from the docs page: [${drift.join(", ")}]`,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return { leg: "docs-catalog", ok: false, detail: `drift check errored: ${String(e).slice(0, 500)}`, durationMs: Date.now() - t0 };
  }
}

async function legSuite(leg: string, repoRoot: string, pkgDir: string, args: string[], env: NodeJS.ProcessEnv): Promise<LegResult> {
  const t0 = Date.now();
  const bin = vitestBin(repoRoot, pkgDir);
  if (!existsSync(bin)) {
    return { leg, ok: false, detail: `vitest bin not found (${bin}) — node_modules not installed?`, durationMs: Date.now() - t0 };
  }
  const r = await runSuite(bin, args, pkgDir, { ...process.env, ...env }, SUITE_TIMEOUT_MS);
  return {
    leg,
    ok: r.code === 0 && !r.timedOut,
    detail: r.code === 0 && !r.timedOut ? "green" : `${r.timedOut ? "TIMED OUT; " : ""}exit ${r.code}; tail:\n${r.tail}`,
    durationMs: Date.now() - t0,
  };
}

// ----------------------------------------------------------------------- main

export async function runGym(opts: { qmRoot?: string; legs?: string[]; summaryJson?: string }): Promise<GymRunSummary> {
  const papercupRoot = papercupRootFromHere();
  const qmRoot =
    opts.qmRoot ?? process.env.TEMPLATE_GYM_QM_ROOT ?? path.resolve(papercupRoot, "..", "quartermaster");
  const runId = `gym-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startedAt = new Date().toISOString();
  const want = (l: string): boolean => !opts.legs || opts.legs.includes(l);

  const legs: LegResult[] = [];
  if (want("materialization")) legs.push(await legMaterialization(papercupRoot, qmRoot));
  if (want("docs-catalog")) legs.push(await legDocsCatalog(papercupRoot));
  if (want("kit-suite"))
    legs.push(await legSuite("kit-suite", papercupRoot, path.join(papercupRoot, "libs", "generic", "template-kit"), ["run"], {}));
  if (want("template-suite"))
    legs.push(await legSuite("template-suite", papercupRoot, path.join(papercupRoot, "templates"), ["run"], {}));
  if (want("app-checks"))
    legs.push(
      await legSuite(
        "app-checks",
        qmRoot,
        path.join(qmRoot, "packages", "template-checks"),
        ["run", "--project", "packages/template-checks"],
        { TEMPLATE_CHECKS_CONFIG: "./checks-config.json" },
      ),
    );

  const summary: GymRunSummary = {
    runId,
    startedAt,
    papercupRoot,
    quartermasterRoot: qmRoot,
    legs,
    green: legs.length > 0 && legs.every((l) => l.ok),
  };

  // Durable record, independent of the caller (the action reads --summary-json;
  // humans/agents read ~/.papercusp/template-gym/).
  try {
    const recDir = path.join(os.homedir(), ".papercusp", "template-gym");
    mkdirSync(recDir, { recursive: true });
    writeFileSync(path.join(recDir, "last-run.json"), JSON.stringify(summary, null, 2));
    appendFileSync(
      path.join(recDir, "runs.jsonl"),
      JSON.stringify({ runId, startedAt, green: summary.green, legs: legs.map((l) => ({ leg: l.leg, ok: l.ok, durationMs: l.durationMs })) }) + "\n",
    );
  } catch {
    /* recording must never fail the run */
  }
  if (opts.summaryJson) {
    writeFileSync(opts.summaryJson, JSON.stringify(summary));
  }
  return summary;
}

// CLI entry — only when executed directly (not when imported by the action/tests).
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const legsArg = flag("--legs");
  runGym({
    qmRoot: flag("--qm-root"),
    summaryJson: flag("--summary-json"),
    legs: legsArg ? legsArg.split(",").map((s) => s.trim()) : undefined,
  })
    .then((summary) => {
      for (const l of summary.legs) {
        // eslint-disable-next-line no-console
        console.log(`[template-gym] ${l.ok ? "GREEN" : "RED"} ${l.leg} (${Math.round(l.durationMs / 1000)}s) — ${l.ok ? l.detail : ""}`);
        if (!l.ok) console.log(l.detail);
      }
      // eslint-disable-next-line no-console
      console.log(`[template-gym] run ${summary.runId}: ${summary.green ? "ALL GREEN" : "RED"}`);
      process.exit(summary.green ? 0 : 1);
    })
    .catch((e) => {
      console.error("[template-gym] runner crashed:", e);
      process.exit(1);
    });
}
