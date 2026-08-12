/**
 * build:typecheck — run `tsc --noEmit` for one project and return DISTILLED
 * diagnostics, refusing a run that would have checked nothing.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-024.
 *
 * ── Why this exists (measured, not assumed) ─────────────────────────────────
 * The 7d corpus holds 622 direct `tsc` atoms across 59 of 86 su sessions — the
 * widest bash family left after git and file-read, and 95% of it is
 * `--noEmit`, i.e. TYPECHECKING rather than building. 72% of the family's
 * whole-commands pipe the compiler's output into `grep`/`head`/`tail` and 17%
 * redirect it to a log file, so agents are pulling a full compiler log across
 * the pipe to throw nearly all of it away. That is the same defect `logs:read`
 * fixed for journalctl, and the reason this tool returns
 * `{ errors:[{file,line,column,code,message}], errorCount, byFile }` and
 * pushes the filtering down (`files`) instead of handing back text.
 *
 * ── The correctness argument: a typecheck that checked NOTHING ──────────────
 * This repo has NO root `tsconfig.json` (only `tsconfig.base.json`), yet the
 * two most common project operands in the corpus are `-p .` (183 atoms) and
 * `-p tsconfig.json` (225). Run from the repo root both fail instantly —
 * TS5057 / TS5058 — having checked zero files. Replaying each session's cwd
 * over the corpus, 45 of 425 decidable `tsc` invocations (11%, across 24 of 86
 * sessions) checked nothing; a cwd-agnostic reading of the same data puts it at
 * 103 of 455 (23%). Either way the failure mode is the same, and what makes it
 * expensive is how it was READ: 42% of those runs were piped into `grep`, and a
 * `grep <my-file>` over a one-line TS5057 prints NOTHING — indistinguishable
 * from "my file is clean". Under `2>&1 | tail`, `$?` is the PIPE's status, so
 * tsc's exit 1 is lost too.
 *
 * So this tool refuses rather than reporting a clean zero, exactly as
 * `testing:run` refuses a zero-match Vitest run. It is the same class as
 * EI-6479 (`npm run typecheck --if-present` silently no-opping) and the fifth
 * instance in this plan of ABSENT EVIDENCE MUST NOT READ AS EVIDENCE OF
 * ABSENCE — after the soak-report's zeroed OOM gate, `dev:listening_ports`'
 * `ownerVisible`, `logs:read`' `unitsUnknown`, and `dev:service_health`'s
 * phantom units.
 *
 * ── What it deliberately does NOT reimplement ───────────────────────────────
 * Nothing about the type-error BASELINE. `scripts/lint-tsc.mjs` +
 * `scripts/lib/tsc-baseline-gate.mjs` own the per-file ratchet, `--mine`
 * scoping and the ratchet-only-down policy; this tool answers the prior, more
 * literal question ("what does tsc say about this project right now") and
 * points at that gate for the verdict. `--incremental false` is inherited from
 * it as a correctness flag, not a style choice (EI-487: a warm tsbuildinfo
 * makes `--noEmit` UNDER-report).
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  errorsOnly,
  filterToFiles,
  noInputDiagnostic,
  parseFoundSummary,
  parseTscDiagnostics,
  summariseByFile,
  syntaxBrokenFiles,
} from '../../tsc-diagnostics';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { tscHeapEnv } from '../tsc-heap';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
} from '../capability/inspect';

/** A cold full-repo typecheck runs minutes, not seconds; a wedged one must still end. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;

/**
 * EI-18776865728050036 — this tool is dispatched FOREGROUND over the papercusp-su MCP
 * transport, which hard-caps a call at ~55s (EI-6073). Its own budget above is 300s default /
 * 900s max, so for any project slower than ~55s the transport killed the call BEFORE the
 * `error:'timeout'` branch below could ever be reached — and the failure surfaced as
 * `MCP error -32603: write CONNECTION_CLOSED 127.0.0.1:6432`, an error naming the DATABASE.
 *
 * Measured 2026-07-27: `packages/operator-core` takes 104.4s → failed 3/3, while `libs/flags`
 * (2.1s) succeeded on the identical path. So the tool was structurally unusable on the largest
 * workspace — and the one the repo's own CLAUDE.md tells every agent to typecheck after
 * editing. Worse, the pgbouncer-shaped error sends the reader off to debug PG (it cost me
 * several calls), and the fallback is a hand-rolled `npx tsc` — precisely the trap this tool
 * exists to prevent (`-p .` checks ZERO files and a grep over the one-line TS5057 prints
 * nothing, reading as "clean").
 *
 * EI-6073 already solved this class for the sibling `capability:inspect` — and its comment even
 * names this case ("operator-core's tsc runs 60-90s"). We IMPORT that ceiling rather than
 * re-declaring 50_000 here: a second copy of a transport constant is exactly the kind of twin
 * that drifts silently the day the cap moves.
 */
const DEFAULT_MAX_ERRORS = 50;

/** Depth-bounded scan for real tsconfigs, used only to make a refusal actionable. */
const SUGGEST_ROOTS = ['packages', 'apps', 'libs'];
const MAX_SUGGESTIONS = 12;

/** Never descend into these when hunting for projects. */
const SUGGEST_PRUNE = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '_retired']);

/**
 * How far BELOW a bucket root to hunt.
 *
 * EI-19302566985147894: this scan used to be exactly one level deep
 * (`libs/<entry>/tsconfig.json`), which silently made every project inside a
 * nested workspace UNSUGGESTABLE — `libs/papercusp` is a git submodule with its
 * own `apps/*`/`packages/*`/`libs/*`, so its projects live at depth 3
 * (`libs/papercusp/libs/db`). The user-visible failure was not a missing
 * suggestion but a WRONG conclusion: an agent told to run
 * `build:typecheck { project: "<workspace>" }` for the package it had just
 * edited got `project_not_found` plus an `availableProjects` list containing no
 * path under `libs/papercusp/**` at all, and reasonably read that as "this tree
 * cannot be typechecked" rather than "the suggester cannot see this far down".
 */
const SUGGEST_MAX_DEPTH = 3;

interface FoundProject {
  /** repo-relative path to the tsconfig.json */
  path: string;
  /** levels below the bucket root — shallower projects are suggested first */
  depth: number;
}

/**
 * Walk one bucket, collecting directories that really contain a tsconfig.json.
 * Descent stops AT a project: a project's own subdirectories are not separate
 * projects worth suggesting, and letting one package recurse freely would flood
 * the cap with its internals.
 */
function collectProjects(root: string, dir: string, depth: number, out: FoundProject[]): void {
  if (depth > SUGGEST_MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SUGGEST_PRUNE.has(entry.name)) continue;
    const child = join(dir, entry.name);
    const candidate = join(child, 'tsconfig.json');
    if (existsSync(candidate)) {
      out.push({ path: relative(root, candidate), depth });
      continue;
    }
    collectProjects(root, child, depth + 1, out);
  }
}

interface TscOutcome {
  code: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * Kill a spawned command's ENTIRE process group, not just the direct child.
 * Mirrors the already-vetted fix in capability/bash-jobs.ts
 * (capability-bash-orphan-kill-2026-06-21): `spawn(..., { detached: true })`
 * makes the child its own process-group leader (pgid === child.pid on Linux),
 * so signalling the NEGATIVE pid reaches it AND every descendant it spawned.
 * Falls back to a direct child kill if the group signal fails, or if `pid` is
 * unavailable (spawn never actually started the process — nothing to reach by
 * pgid, but a direct `.kill()` is still the right no-op-or-signal call rather
 * than silently doing nothing). Never throws.
 */
function killProcessTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, sig); // negative pid → the whole process group
      return;
    } catch {
      /* fall through to a direct kill below */
    }
  }
  try {
    child.kill(sig);
  } catch {
    /* already exited */
  }
}

export function runTsc(args: string[], cwd: string, timeoutMs: number): Promise<TscOutcome> {
  return new Promise((resolvePromise) => {
    let output = '';
    let settled = false;
    // EI-18793290418757939: the old version gated promise resolution on the
    // child's OWN 'close' event even after the timeout fired — it only killed
    // the child and kept waiting. A killed process is not guaranteed to close
    // promptly: under real memory-pressure thrashing (the WI-5471 class,
    // repeatedly observed on this box via the infra-liveness watchdog: "PSI
    // memory full avg60 ≥ 5 — all tasks stalled on memory reclaim/swap"), a
    // SIGKILL'd child can sit reaping in D-state for many extra seconds. That
    // pushed this tool's real wall-clock time past BOTH the outer MCP-transport
    // deadline (~55s) and the dispatch-stack's own hard AbortController timeout
    // (60s default — this tool declares no static `timeoutSec`, so it inherits
    // that default), producing exactly the watchdog signature this bug reports:
    // "exceeded timeout of 60s (handler returned but signal had aborted)" —
    // the handler eventually DID return, just long after the abort fired.
    // Fix: settle the promise the moment OUR OWN timer fires — kill + reap are
    // best-effort background cleanup from then on, never gating the return.
    const settle = (outcome: TscOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    // EI-19342308665972321: `npx tsc` is TWO processes — npx forks a separate
    // `node .../.bin/tsc` grandchild rather than exec-replacing itself. Killing
    // only `child` (the npx wrapper, via `child.kill`) leaves that grandchild
    // ORPHANED and running at full CPU — measured live: the "timed out" compile
    // was still running ~4 minutes after this tool returned `error:'timeout'`,
    // invisible to the task ledger and unattributable except by reading argv out
    // of `pgrep`. `detached: true` makes `child` the process-group leader, so
    // `killProcessTree` (negative-pid kill) reaches npx AND the tsc grandchild —
    // the same fix bash-jobs.ts already applies to `capability:bash`'s spawned
    // shells. Never `unref()`d, so the operator still tracks + reaps it normally.
    const child = spawn('npx', ['tsc', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // EI-20019651513530828: without a pinned heap this OOMs on operator-core
      // (~9k files vs node's default ~4GB old-space) and is killed BEFORE emitting
      // any diagnostics — which parses as zero errors, i.e. a clean pass.
      env: { ...process.env, ...tscHeapEnv() },
    });
    const timer = setTimeout(() => {
      killProcessTree(child, 'SIGTERM');
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 5000).unref();
      settle({ code: null, timedOut: true, output });
    }, timeoutMs);
    // Diagnostics are the payload here (unlike testing:run, where the router's
    // output is only an error-path fallback), so the buffer is generous: a
    // full-repo check can emit thousands of lines and truncating the HEAD would
    // silently drop errors rather than merely losing context.
    const append = (b: Buffer) => { output = (output + b.toString('utf8')).slice(-8 * 1024 * 1024); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => { settle({ code: null, timedOut: false, output: `${output}\n[spawn-error] ${e.message}` }); });
    child.on('close', (code) => { settle({ code, timedOut: false, output }); });
  });
}

/**
 * Resolve a project operand the way tsc does: a directory means
 * `<dir>/tsconfig.json`, a file means itself. Returns null when nothing is there.
 */
export function resolveProjectPath(root: string, project: string): string | null {
  const abs = isAbsolute(project) ? project : resolve(root, project);
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      const candidate = join(abs, 'tsconfig.json');
      return existsSync(candidate) ? candidate : null;
    }
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

/**
 * Real tsconfigs near the repo root, so a refusal names what the caller could
 * have meant. This is the whole reason the refusal is useful rather than merely
 * correct: an agent who typed `-p .` out of habit needs the list, not a scolding.
 *
 * The buckets are INTERLEAVED rather than concatenated. Filling the cap in
 * order put all 12 slots into `packages/` (it alone holds more than the cap), so
 * an agent who meant `apps/operator-vite` was handed twelve suggestions with not
 * one `apps/` entry among them — a list that is technically correct and
 * practically useless. Caught by live verification, not by the unit suite.
 *
 * `requested` — the operand that just failed — RANKS the list. Without it the
 * cap is the whole problem again in a new place (EI-19302566985147894): widening
 * the scan to find nested projects changed nothing on the real tree, because the
 * 12 slots are filled by depth-1 projects long before any `libs/papercusp/**`
 * entry is reached. A generic list cannot help someone who asked for a specific
 * path; the projects sharing that path's prefix are the only ones they plausibly
 * meant, so those go first. Verified against the live repo, not just fixtures.
 */
export function suggestProjects(root: string, requested?: string): string[] {
  const byBucket: string[][] = [];
  for (const bucket of SUGGEST_ROOTS) {
    const dir = resolve(root, bucket);
    if (!existsSync(dir)) continue;
    const found: FoundProject[] = [];
    collectProjects(root, dir, 1, found);
    if (found.length === 0) continue;
    // Shallowest first, then alphabetical: a top-level `libs/flags` still
    // outranks a submodule's `libs/papercusp/libs/db` for the same cap slot,
    // so widening the scan cannot demote the suggestions that were there
    // before — it only fills slots the old one-level scan left empty.
    found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    byBucket.push(found.map((f) => f.path));
  }

  const interleaved: string[] = [];
  for (let i = 0; interleaved.length < MAX_SUGGESTIONS; i += 1) {
    const before = interleaved.length;
    for (const bucket of byBucket) {
      if (interleaved.length >= MAX_SUGGESTIONS) break;
      if (i < bucket.length) interleaved.push(bucket[i]);
    }
    if (interleaved.length === before) break; // every bucket exhausted
  }

  const related = requested ? relatedProjects(byBucket, requested) : [];
  if (related.length === 0) return interleaved;
  // Related first, then the generic list fills whatever cap remains. Dedupe so a
  // project that is both related and generically-ranked appears once.
  const ordered = [...related];
  for (const p of interleaved) {
    if (ordered.length >= MAX_SUGGESTIONS) break;
    if (!ordered.includes(p)) ordered.push(p);
  }
  return ordered.slice(0, MAX_SUGGESTIONS);
}

/**
 * Projects whose path shares a leading directory prefix with what the caller
 * asked for, most-specific first. Matching on whole path SEGMENTS (not raw
 * characters) is deliberate: `libs/pap` must not look like a partial match for
 * `libs/papercusp`, or a typo would rank above a real neighbour.
 */
function relatedProjects(byBucket: string[][], requested: string): string[] {
  const wanted = requested.replace(/\\/g, '/').replace(/\/?(tsconfig\.json)?\/*$/, '').split('/').filter(Boolean);
  if (wanted.length === 0) return [];
  const scored: { path: string; shared: number }[] = [];
  for (const bucket of byBucket) {
    for (const path of bucket) {
      const segs = path.split('/').slice(0, -1); // drop the trailing tsconfig.json
      let shared = 0;
      while (shared < segs.length && shared < wanted.length && segs[shared] === wanted[shared]) shared += 1;
      if (shared > 0) scored.push({ path, shared });
    }
  }
  scored.sort((a, b) => b.shared - a.shared || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.path);
}

/**
 * EI-19297428004790873 — build a throwaway tsconfig that checks ONLY the given files
 * and their import graph, so a project too big to typecheck inline under fleet load
 * still has a fast, HONEST answer.
 *
 * Why this exists at all: the foreground cap (~50s, held below the transport's ~55s)
 * is not raisable, so on a big workspace under load the tool could only ever hand back
 * `error:'timeout'`. The documented next step (a detached `capability:inspect` + poll)
 * is several calls, so agents hand-rolled `npx tsc -p ... | head -25` instead — which
 * lies in the GREEN direction: tsc emits path-ordered, so on a project with a
 * pre-existing error backlog the head budget is consumed by unrelated files and your
 * file never appears. A zero-hit grep over that output is indistinguishable from a
 * pass, and whether you get away with it depends on your file's ALPHABETICAL position
 * relative to an unrelated backlog. This mode removes the reason to hand-roll.
 *
 * THREE TRAPS, all hit while proving the recipe out — do not "simplify" them away:
 *  1. The config lives OUTSIDE the tree (writing it inside would be swept into a commit
 *     by git-sync, which commits the whole shared tree). That means `typeRoots` MUST be
 *     absolute — left relative, `@types` resolves against the temp dir and every ambient
 *     type vanishes, producing a flood of phantom errors.
 *  2. `include: []` is required alongside `files`. Without it the extended project's own
 *     `include` globs survive and pull the entire project back in, silently restoring the
 *     very cost this mode exists to avoid — and it still LOOKS scoped.
 *  3. `types` must be listed EXPLICITLY. Absolute `typeRoots` (trap 1) is necessary but
 *     NOT sufficient: with `types` left undefined, TS's automatic "@types under typeRoots"
 *     inclusion does not survive the config living in a temp dir, so every ambient global
 *     disappears — the identical phantom-error flood trap 1 is about, from a different
 *     cause. It hid because the projects this mode was proved on (operator-core) declare
 *     `types: ["node"]` in their OWN tsconfig and so were immune; a project that does not
 *     (apps/operator) got a wall of nonsense. MEASURED 2026-08-02 on
 *     apps/operator/scripts/hooks/cc/__tests__/pc-heavy.test.ts: 28 errors, every one a
 *     "Cannot find name 'process'" / "Cannot find name 'node:fs'" phantom -> 0 errors with
 *     `types` populated, same file, same everything else.
 *
 *     The list is READ from disk rather than hardcoded to `["node"]` so this reproduces
 *     TS's own default faithfully instead of guessing: hardcoding node would both miss a
 *     project's other ambient packages AND inject node globals into a DOM-only project,
 *     where `process` SHOULD be an error and would silently start passing.
 *
 * `extends` is absolute for the same reason as (1): a relative extends would resolve
 * against the temp dir.
 */
/**
 * The `@types/*` packages tsc would auto-include for a config whose `types` is undefined
 * — i.e. every directory directly under `typeRoot`. Returned as bare package names
 * (`node`, `babel__core`), which is the form `compilerOptions.types` expects.
 *
 * Returns [] on any read failure, and the caller then OMITS `types` entirely: emitting
 * `types: []` would be strictly worse than not setting it, because it means "include NO
 * ambient packages" and would guarantee the very phantom-error flood this exists to stop.
 */
export function ambientTypePackages(typeRoot: string): string[] {
  try {
    return readdirSync(typeRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Does this project (or anything in its `extends` chain) DECLARE `compilerOptions.types`?
 *
 * This gate is why the trap-3 fix is not simply "always set `types`". A project that
 * declares `types` has usually done so to EXCLUDE things, and an explicit `types` in the
 * extending config silently overrides the inherited one. MEASURED 2026-08-02: injecting
 * the full 96-package enumeration into a scoped run of packages/operator-core took it from
 * 1 error to 92 — operator-core pins `types: ["node"]` precisely to keep the other ambient
 * test-framework globals out, and overriding it dragged them all back in. So: declared ⇒
 * inherit it untouched; undeclared ⇒ supply the enumeration tsc would have used anyway.
 *
 * Fails OPEN (returns true ⇒ "leave it alone") on an unreadable/malformed config: the
 * enumeration is a repair for a known-broken case, never something to force on a project
 * whose intent we could not read.
 */
export function projectDeclaresTypes(tsconfigAbs: string, depth = 0): boolean {
  if (depth > 8) return true; // cyclic or absurd extends chain — do not intervene
  let parsed: { compilerOptions?: { types?: unknown }; extends?: unknown };
  try {
    const raw = readFileSync(tsconfigAbs, 'utf8');
    // Plain JSON FIRST, and only fall back to comment-stripping if that fails.
    //
    // Not an optimisation — stripping unconditionally is actively WRONG here. tsconfig
    // path aliases contain `/*` (`"@/*": ["./*"]`), which a block-comment regex happily
    // treats as the start of a comment and eats through the rest of `paths`. That made
    // apps/operator's perfectly valid JSON unparseable, and since this function fails
    // open, every project silently reported "declares types" and the repair never ran —
    // a fix that quietly did nothing while its tests looked fine.
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(
        raw
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/,(\s*[}\]])/g, '$1'),
      );
    }
  } catch {
    return true;
  }
  if (parsed?.compilerOptions && 'types' in parsed.compilerOptions) return true;
  const ext = parsed?.extends;
  if (typeof ext !== 'string' || ext.length === 0) return false;
  // Only a relative/absolute path extends is resolvable here; a bare package specifier
  // (e.g. "@tsconfig/node20/tsconfig.json") is treated as declaring, i.e. hands-off.
  if (!ext.startsWith('.') && !isAbsolute(ext)) return true;
  const next = isAbsolute(ext) ? ext : resolve(dirname(tsconfigAbs), ext);
  const withExt = existsSync(next) ? next : `${next}.json`;
  if (!existsSync(withExt)) return true;
  return projectDeclaresTypes(withExt, depth + 1);
}

export function buildScopedTsconfig(
  root: string,
  projectTsconfigAbs: string,
  requestedFiles: string[],
): { configPath: string; cleanup: () => void; resolvedFiles: string[]; missing: string[] } {
  const resolvedFiles: string[] = [];
  const missing: string[] = [];
  for (const f of requestedFiles) {
    const abs = isAbsolute(f) ? f : resolve(root, f);
    if (existsSync(abs) && statSync(abs).isFile()) resolvedFiles.push(abs);
    else missing.push(f);
  }

  const typeRoot = join(root, 'node_modules', '@types');
  // Only repair a project that declares NO `types` — see projectDeclaresTypes for the
  // measured reason overriding a declared one is destructive.
  const ambientTypes = projectDeclaresTypes(projectTsconfigAbs) ? [] : ambientTypePackages(typeRoot);
  const dir = mkdtempSync(join(tmpdir(), 'pc-typecheck-scoped-'));
  const configPath = join(dir, 'tsconfig.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        extends: projectTsconfigAbs,
        compilerOptions: {
          noEmit: true,
          incremental: false,
          typeRoots: [typeRoot],
          // Trap 3 above — enumerated, not hardcoded, so this mirrors what tsc would have
          // auto-included. Omitted entirely when the scan finds nothing, so an unreadable
          // or absent @types dir degrades to today's behaviour rather than pinning `types`
          // to [] and deleting every ambient global we were trying to preserve.
          ...(ambientTypes.length > 0 ? { types: ambientTypes } : {}),
        },
        files: resolvedFiles,
        include: [],
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    configPath,
    resolvedFiles,
    missing,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leaked temp dir is harmless; never fail a typecheck over cleanup */
      }
    },
  };
}

export default defineTool({
  name: 'build:typecheck',
  description:
    'Run `tsc --noEmit` for ONE project and return structured diagnostics — { ok, errorCount, errors:[{file,line,column,code,message}], byFile, syntaxBroken } — instead of a compiler log you pipe through grep/tail. REFUSES a run that checked nothing (TS5057/TS5058/TS18003) rather than reporting a clean zero: this repo has no root tsconfig.json, so `-p .` silently checks zero files. `files` filters diagnostics server-side. Runs with --incremental false so a warm tsbuildinfo cannot under-report.',
  guidance: {
    when: 'You edited TypeScript and want to know whether a project typechecks, and exactly which errors are where. Also the way to check a workspace OUTSIDE operator-core, which `npm run lint:tsc` does not cover.',
    notWhen: 'You want the baseline VERDICT on whether your change added errors — that is `npm run lint:tsc -- --mine` (per-file ratchet, peer-drift aware), which this tool does not replace. Not for building/emitting, eslint, or cargo.',
    chaining: 'build:typecheck { project, files } → fix → re-run scoped to the same `files`; then `npm run lint:tsc -- --mine` for the gate verdict.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  // EI-18793290418757939: declare the REAL wall-clock budget instead of inheriting
  // dispatch-stack's generic 60s default. The handler's own worst case is bounded by
  // FOREGROUND_TIMEOUT_CEILING_MS (50s) now that runTsc() resolves at its own timer
  // instead of blocking on the child's 'close' event — this margin covers scheduling
  // + serialization overhead, not process-kill latency. Keeping this declared (rather
  // than implicit) means dispatch-stack's AbortController and _mcp-handler's
  // effectiveMcpDeadlineMs both derive their budget from the SAME number this tool
  // actually honors, so the three layers can't silently drift apart again the way they
  // did here (the tool waited past a 60s abort it never knew about).
  timeoutSec: 58,
  // EI-18803497769946984: the handler shells out to `tsc` and blocks for as long as
  // that takes (observed up to 141s) without ever reading `ctx.tx`. Holding the
  // ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s) and surfaces as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    project: z.string().min(1).max(400)
      .describe('tsconfig path, or a directory containing one — repo-root-relative or absolute (e.g. "packages/operator-core" or "apps/operator/tsconfig.json"). REQUIRED and deliberately un-defaulted: this repo has no root tsconfig.json, so any default would be the exact silent no-op this tool exists to refuse.'),
    files: z.array(z.string().min(1)).max(50).optional()
      .describe('Return only diagnostics in these files (matched by path suffix). The server-side form of `| grep -E "myfile"` — the whole project is still checked, so counts stay honest; `errorCount` is the filtered count and `totalErrorCount` the project-wide one.'),
    maxErrors: z.number().int().min(1).max(500).optional()
      .describe(`Cap the returned errors list (default ${DEFAULT_MAX_ERRORS}). Counts and byFile stay complete; errorsTruncated flags the cut.`),
    timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
      .describe(
        `Hard budget for the compile. Default ${DEFAULT_TIMEOUT_MS}ms, but a FOREGROUND run is clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms — below the ~55s MCP transport cap — so an over-long compile returns an actionable timeout instead of an opaque transport error. A project that needs longer (packages/operator-core is ~104s) must run detached via capability:inspect { run_in_background: true }.`,
      ),
    incremental: z.boolean().optional()
      .describe('Allow tsc to use a warm tsconfig.tsbuildinfo. Default false — EI-487: an incremental run UNDER-reports errors in files the cache has not reindexed, which read as green for days. Only set true when you want a fast re-check and already know the tree is warm.'),
    scopeToFiles: z.boolean().optional()
      .describe(
        'Compile ONLY `files` + their import graph instead of the whole project, so a run still fits the foreground cap under fleet load. Requires `files`. COST IS YOUR IMPORT GRAPH, NOT THE PROJECT — measured in operator-core: a leaf file (lib/tsc-diagnostics.ts) 2.6s vs a hub file (agent-tools/build/typecheck.ts) 63s, because a hub transitively pulls in most of the project. Great for a leaf, no help for a hub — a hub can still exceed the cap and time out. ⚠ NARROWER GUARANTEE: it cannot see errors your change caused in files that do NOT import yours (the classic case: adding a required field to a shared interface breaks distant fixtures). A clean scoped run means "these files and what they import compile", NOT "my change is safe" — for that verdict use the project-wide run or `npm run lint:tsc -- --files=...`.',
      ),
  }),
  async handler(args, ctx) {
    // EI-1754 (same defect as testing:run): `inferWorkspaceRoot()` walks up from
    // `process.cwd()`, and the :3070 operator runs FROM the release checkout — so
    // this tool typechecked the RELEASE tree, not the tree the agent just edited,
    // and reported it clean. Use the same projectDir → PAPERCUSP_INTEGRATION_ROOT
    // → cwd resolver every capability tool uses.
    const root = resolveAgentWorkspaceRoot(ctx);
    const started = Date.now();

    // Pre-flight the project so the refusal can be specific and name alternatives.
    // tsc's own verdict (below) stays authoritative — this only catches the case
    // early and with a better message.
    const resolved = resolveProjectPath(root, args.project);
    if (!resolved) {
      return {
        data: {
          ok: false,
          error: 'project_not_found',
          project: args.project,
          searchedFrom: root,
          message:
            `No tsconfig at "${args.project}". Nothing would have been typechecked — ` +
            'this is the failure mode the tool refuses rather than reporting zero errors.' +
            (existsSync(resolve(root, 'tsconfig.base.json')) && /^\.?$|^tsconfig\.json$/.test(args.project)
              ? ' The repo root has only tsconfig.base.json (a shared base, not a project), which is why `-p .` and `-p tsconfig.json` check nothing here.'
              : ''),
          availableProjects: suggestProjects(root, args.project),
        },
      };
    }

    // Clamp BELOW the ~55s MCP transport cap so this handler always wins the race and can
    // return the structured timeout below, instead of the transport killing the call and
    // surfacing an opaque `CONNECTION_CLOSED 127.0.0.1:6432` (EI-18776865728050036).
    const timeoutMs = clampForegroundTimeoutMs(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    // EI-19297428004790873: scoped mode swaps the project for a throwaway config over just
    // `files` + their import graph. Refuse the two ways it could silently check NOTHING —
    // same ethos as the project_not_found and tsc_failed_to_run guards: this tool never
    // reports a zero it did not earn.
    let scoped: ReturnType<typeof buildScopedTsconfig> | null = null;
    if (args.scopeToFiles) {
      if (!args.files?.length) {
        return {
          data: {
            ok: false,
            error: 'scope_requires_files',
            message:
              'scopeToFiles:true needs `files` — with no files the generated config would compile an EMPTY program and exit 0, i.e. report a clean zero having checked nothing.',
          },
        };
      }
      scoped = buildScopedTsconfig(root, resolved, args.files);
      if (!scoped.resolvedFiles.length) {
        scoped.cleanup();
        return {
          data: {
            ok: false,
            error: 'scope_files_not_found',
            project: relative(root, resolved),
            missing: scoped.missing,
            searchedFrom: root,
            message:
              'None of the requested `files` exist on disk, so the scoped program would be empty and tsc would exit 0 — a clean zero that checked nothing. Paths are resolved against the repo root (or pass absolute); note this differs from the non-scoped `files` filter, which matches by path SUFFIX.',
          },
        };
      }
    }

    const tscArgs = ['--noEmit', '--pretty', 'false', '-p', scoped ? scoped.configPath : resolved];
    if (args.incremental !== true) tscArgs.push('--incremental', 'false');

    let outcome: TscOutcome;
    try {
      outcome = await runTsc(tscArgs, root, timeoutMs);
    } finally {
      scoped?.cleanup();
    }
    const durationMs = Date.now() - started;

    if (outcome.timedOut) {
      return {
        data: {
          ok: false,
          error: 'timeout',
          project: relative(root, resolved),
          timeoutMs,
          durationMs,
          // The whole point of the clamp: a timeout must hand back a WORKING next step, not a
          // dead end. The repo's operator-core baseline gate is the reachable full-project
          // fallback; keep the hint on that canonical entrypoint rather than suggesting a
          // detached tool that is unavailable from every su session.
          hint:
            `hit the ${(timeoutMs / 1000).toFixed(0)}s foreground cap (held below the ~55s MCP transport limit so you get this instead of an opaque CONNECTION_CLOSED). ` +
            `CHEAPEST NEXT STEP (one call): re-run scoped to your own files — ` +
            `build:typecheck { project: '${relative(root, resolved) || '.'}', files: ['<your changed files>'], scopeToFiles: true }. ` +
            `That compiles only those files + their import graph; cost tracks YOUR import graph, not the project (measured: leaf 2.6s, hub 63s), so it fixes this for a leaf file but a hub can still time out. ` +
            `It also does NOT see errors your change caused in files that do not import yours. ` +
            `For the full project-wide answer, run the repo's operator-core baseline gate instead: ` +
            `npm run lint:tsc -- --files=path/to/changed.ts,path/to/another.ts. ` +
            `This uses the configured heap and per-file baseline, while the explicit file list ` +
            `avoids attributing a peer's dirty working-tree edits to you. ` +
            `Do NOT fall back to a hand-rolled \`npx tsc\`: \`-p .\` checks ZERO files here, and piping a real run through \`head\`/\`grep\` truncates PATH-ORDERED output, so your file can be silently absent and read as clean.`,
          output: outcome.output.slice(-2000),
        },
      };
    }

    const diagnostics = parseTscDiagnostics(outcome.output);

    // A run that produced no diagnostics AND did not exit 0 never really ran —
    // never let that read as "clean". Same guard the baseline gate applies.
    if (diagnostics.length === 0 && outcome.code !== 0) {
      return {
        data: {
          ok: false,
          error: 'tsc_failed_to_run',
          project: relative(root, resolved),
          exitCode: outcome.code,
          durationMs,
          message: 'tsc exited non-zero with no parseable diagnostics — a toolchain failure, NOT a clean run.',
          output: outcome.output.slice(-2000),
        },
      };
    }

    // tsc's own word on "I checked nothing" — catches TS18003 (a real tsconfig
    // whose include/files match no inputs), which no path check can predict.
    const noInput = noInputDiagnostic(diagnostics);
    if (noInput) {
      return {
        data: {
          ok: false,
          error: 'nothing_typechecked',
          project: relative(root, resolved),
          code: noInput.code,
          durationMs,
          message: `${noInput.code}: ${noInput.message} — zero files were typechecked, so this is NOT a clean result.`,
          availableProjects: suggestProjects(root, args.project),
        },
      };
    }

    const errors = errorsOnly(diagnostics);
    const byFile = summariseByFile(errors);
    // In scoped mode `files` defined the PROGRAM, so it must not also narrow the OUTPUT:
    // the scoped program deliberately includes the import graph, and an error your change
    // caused in a file you import is exactly what you need to see. Re-applying the suffix
    // filter here would hide it and hand back a clean-looking zero — the same false-green
    // this mode exists to eliminate.
    const shown = args.files && !args.scopeToFiles ? filterToFiles(errors, args.files) : errors;
    const maxErrors = args.maxErrors ?? DEFAULT_MAX_ERRORS;
    const reported = parseFoundSummary(outcome.output);

    return {
      data: {
        ok: errors.length === 0 && outcome.code === 0,
        project: relative(root, resolved),
        errorCount: shown.length,
        // A scoped PASS is a weaker claim than a project-wide one, so it must never be
        // reported in the same shape. These fields travel with the result so a reader
        // (or a successor reading a checkpoint that quotes it) cannot mistake
        // "this file's import graph compiles" for "my change is safe".
        ...(scoped
          ? {
              scopedToFiles: scoped.resolvedFiles.map((f) => relative(root, f)),
              ...(scoped.missing.length ? { scopeMissing: scoped.missing } : {}),
              // Split the count so a HUB file stays navigable: its import graph can drag in
              // most of the project along with that project's pre-existing error backlog, and
              // without this you cannot tell "my file is broken" from "something I import
              // already was". Errors in the graph are still REPORTED (hiding them is how the
              // hand-rolled fallback lied) — this just says which ones are yours.
              errorsInRequestedFiles: filterToFiles(errors, args.files ?? []).length,
              scopeCaveat:
                'SCOPED RUN — only these files and their import graph were compiled. Errors your change caused in files that do not import these are NOT covered (e.g. adding a required field to a shared interface breaks distant fixtures). This is not the gate verdict.',
            }
          : {}),
        ...(args.files && !args.scopeToFiles ? { totalErrorCount: errors.length, filteredTo: args.files } : {}),
        errors: shown.slice(0, maxErrors),
        errorsTruncated: shown.length > maxErrors,
        byFile: byFile.slice(0, 30),
        filesWithErrors: byFile.length,
        syntaxBroken: syntaxBrokenFiles(errors),
        durationMs,
        exitCode: outcome.code,
        // Cross-check against tsc's own tally: a mismatch means the diagnostic
        // grammar drifted (a compiler upgrade), and the caller is told rather
        // than handed a silently wrong number.
        ...(reported !== null && reported !== errors.length
          ? { parseWarning: `tsc reported ${reported} errors but ${errors.length} were parsed — the diagnostic format may have changed; treat counts as approximate.` }
          : {}),
      },
    };
  },
});
