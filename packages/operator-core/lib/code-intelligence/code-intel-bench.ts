/**
 * P-010 — the code-intelligence bakeoff runner.
 *
 * Grades a backend against the FROZEN acceptance corpus and measures what the
 * selection decision actually rests on.
 *
 * ## Why this file carries its own probe map
 *
 * `ACCEPTANCE_CORPUS` carries `expectedSites` — the ANSWER — but no cursor
 * PROBE, and it is frozen at `CORPUS_BASELINE_COMMIT`. A cursor-driven backend
 * (LSP `textDocument/definition` et al) needs a *question*: a file, a line and
 * a character to point at. Adding those to the corpus would mutate a frozen
 * fixture and quietly couple the ground truth to one backend's calling
 * convention. So the probes live here, keyed by corpus case id, and the corpus
 * stays the independent answer key.
 *
 * ## Why `character` is derived, never hardcoded
 *
 * A stored character offset is a number with no self-check: reformat the line
 * and it silently points at the wrong token, and the backend obligingly
 * answers about whatever is there. So a probe stores the literal `symbol` and
 * we derive the offset with `indexOf` at run time. If the symbol is no longer
 * on that line the probe THROWS — the same self-verifying discipline
 * `PinnedSite.symbolOnLine` uses in the corpus itself. A drifted probe must
 * fail loudly, never grade as a wrong answer by the backend.
 *
 * ## Why cold-start is measured to CORRECT, not to first response
 *
 * A language server answers before it has finished indexing. The first reply
 * to a definition query on a cold server is routinely an empty result that is
 * *structurally* valid, and a benchmark that stops the clock there reports a
 * cold start several seconds faster than the one an agent actually
 * experiences. `timeToCorrectMs` therefore polls until the answer GRADES
 * correct (or the deadline expires), which is the number the routing policy
 * needs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_RESOURCE_BUDGET,
  isMutatingToolName,
  isTrustworthyEmpty,
  type CodeIntelAnswer,
  type CodeIntelBackend,
  type CodeIntelIntent,
  type SymbolSite,
} from './contracts.ts';
import { ACCEPTANCE_CORPUS, corpusCase, type CorpusCase } from './acceptance-corpus.ts';
import { lspClientInventory, lspQuery, shutdownAllLspClients } from './lsp-adapter.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Probes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A cursor question for one corpus case.
 *
 * `file` is repo-relative; `line1` is ONE-indexed as a human states it. The
 * `character` offset is deliberately absent — see the file header.
 */
export interface BenchProbe {
  /** Corpus case this probe asks about. */
  readonly caseId: string;
  /** Repo-relative path of the file the cursor sits in. */
  readonly file: string;
  /** ONE-indexed line the symbol occurs on. */
  readonly line1: number;
  /** Literal text that must appear on `line1`; the cursor is placed inside it. */
  readonly symbol: string;
  /** Why the cursor is HERE and not at the declaration — the case's whole point. */
  readonly rationale: string;
}

/**
 * The corpus cases a cursor-driven backend can be asked about, with the site
 * to ask FROM. Verified against the working tree by `code-intel-bench.test.ts`,
 * which fails if any probe has drifted.
 */
export const BENCH_PROBES: readonly BenchProbe[] = Object.freeze([
  {
    caseId: 'definition-cross-package-bare-specifier',
    file: 'libs/generic/search/src/leg-health.ts',
    line1: 41,
    symbol: 'pinModuleState',
    rationale:
      'Ask from the IMPORT site, where the specifier is the bare workspace name. ' +
      'Resolving it requires following the npm-workspace symlink — precisely what ' +
      'a text-matching backend cannot do.',
  },
  {
    caseId: 'references-through-barrel-reexport',
    file: 'libs/generic/dock-workbench/src/panel-registry.ts',
    line1: 30,
    symbol: 'PanelRegistry',
    rationale:
      'Ask at the declaration; the answer must still include the barrel index that ' +
      're-exports it, which a backend that stops at direct importers will miss.',
  },
  {
    caseId: 'shadowed-symbol-no-cross-contamination',
    file: 'packages/operator-core/lib/pty-bridge.ts',
    line1: 166,
    symbol: 'managedSetInterval',
    rationale:
      'Ask from a real USE site. The single correct definition must come back and ' +
      'the same-named `vi.mock` factory in a test file must NOT — this case is ' +
      'graded exact-set precisely so that extra is a failure, not a bonus.',
  },
  {
    caseId: 'rust-trait-implementations',
    file: 'papercusp-desktop/src-tauri/src/endpoint_ipc.rs',
    line1: 284,
    symbol: 'IpcStream',
    rationale:
      'Ask at the enum declaration; the answer must enumerate the trait impls. ' +
      'This is the one corpus case that exercises a non-TypeScript server.',
  },
]);

/** A cursor resolved against the working tree, ready to hand to a backend. */
export interface ResolvedCursor {
  /** ABSOLUTE path — what the LSP adapter expects. */
  readonly file: string;
  readonly line1: number;
  /** Zero-indexed offset, derived so drift cannot pass silently. */
  readonly character: number;
  readonly rootPath: string;
  /** The full source line, retained so a failure report can show it. */
  readonly lineText: string;
}

/**
 * Resolve a probe's cursor against the working tree.
 *
 * THROWS if the file is short or the symbol has moved off the line. That is
 * deliberate: a drifted probe is a broken *question*, and letting it through
 * would score the backend wrong for our bookkeeping error — the exact
 * false-signal this corpus exists to prevent.
 */
export function resolveProbeCursor(probe: BenchProbe, repoRoot: string): ResolvedCursor {
  const abs = join(repoRoot, probe.file);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const lineText = lines[probe.line1 - 1];

  if (lineText === undefined) {
    throw new Error(
      `bench probe drift: ${probe.file} has ${lines.length} lines but probe ` +
        `${probe.caseId} points at line ${probe.line1}`,
    );
  }

  const at = lineText.indexOf(probe.symbol);
  if (at < 0) {
    throw new Error(
      `bench probe drift: ${probe.file}:${probe.line1} no longer contains ` +
        `'${probe.symbol}' (probe ${probe.caseId}). Line reads: ${lineText.trim()}`,
    );
  }

  // Aim at the MIDDLE of the token, not its first character. A cursor sitting
  // exactly on the boundary is ambiguous to some servers (it can read as the
  // end of the preceding token); the middle is unambiguously inside.
  return {
    file: abs,
    line1: probe.line1,
    character: at + Math.floor(probe.symbol.length / 2),
    rootPath: repoRoot,
    lineText,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grading
// ─────────────────────────────────────────────────────────────────────────────

export interface GradeResult {
  readonly correct: boolean;
  /** Expected sites the backend did not return. */
  readonly missing: readonly string[];
  /** Sites the backend returned that the corpus does not sanction (exact-set only). */
  readonly extra: readonly string[];
  /** Human-readable verdict, suitable for a Decision body. */
  readonly reason: string;
}

const siteKey = (path: string, line1: number | null): string => `${path}:${line1 ?? '?'}`;

/**
 * Grade a backend's sites against the frozen corpus entry.
 *
 * `property` cases are NOT gradeable here — they assert a behaviour of the
 * runner, not a site set — so they return `correct: false` with a reason that
 * says so rather than a misleading pass.
 */
export function gradeSites(kase: CorpusCase, sites: readonly SymbolSite[]): GradeResult {
  if (kase.gradeMode === 'property') {
    return {
      correct: false,
      missing: [],
      extra: [],
      reason: `case '${kase.id}' is gradeMode:'property' — not a site-set comparison`,
    };
  }

  const got = new Set(sites.map((s) => siteKey(s.path, s.line1)));
  const want = kase.expectedSites.map((s) => siteKey(s.path, s.line1));

  const missing = want.filter((k) => !got.has(k));
  const extra =
    kase.gradeMode === 'exact-set' ? [...got].filter((k) => !want.includes(k)) : [];

  const correct = missing.length === 0 && extra.length === 0;
  const reason = correct
    ? `all ${want.length} expected site(s) present` +
      (kase.gradeMode === 'exact-set' ? ' and no extras' : '')
    : [
        missing.length ? `missing ${missing.join(', ')}` : '',
        extra.length ? `unsanctioned extra ${extra.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ');

  return { correct, missing, extra, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement
// ─────────────────────────────────────────────────────────────────────────────

export interface BenchMeasurement {
  readonly caseId: string;
  readonly intent: CodeIntelIntent;
  readonly backend: CodeIntelBackend;
  /** True when this query paid a language-server cold start. */
  readonly serverWasCold: boolean;
  /** Wall time until the answer GRADED correct; null if it never did. */
  readonly timeToCorrectMs: number | null;
  /** Latency of a second, warm query for the same cursor. */
  readonly warmQueryMs: number | null;
  /** How many polls it took — >1 proves first-response was not yet correct. */
  readonly attempts: number;
  readonly correct: boolean;
  /** A false-empty is the disqualifying failure, tracked separately from wrong. */
  readonly trustworthyEmpty: boolean;
  readonly grade: GradeResult;
  readonly error: string | null;
  /**
   * What the backend actually returned, as `path:line` keys. `must-contain`
   * grading does not compute extras, so without this a failure reports only
   * what is MISSING and gives no way to see what came back instead — which is
   * usually the whole diagnosis.
   */
  readonly returnedSites: readonly string[];
  /**
   * Set when the backend first answered HEALTHY-and-EMPTY and only later
   * produced sites — the elapsed ms between the two. A non-null value is
   * PROOF of a false-empty: the backend affirmatively claimed health while
   * having nothing, which `isTrustworthyEmpty` accepts. This is the exact
   * failure the acceptance corpus exists to catch, so it is measured rather
   * than inferred.
   */
  readonly emptyThenFilledMs: number | null;
  /**
   * True when the leg budget ran out before this probe was tried. Recorded
   * EXPLICITLY rather than omitted: a probe that never ran must never be
   * mistaken for one that ran and passed, and a short report is otherwise
   * indistinguishable from a clean one.
   */
  readonly notAttempted: boolean;
}

/** What a backend costs while resident, against the shared budget. */
export interface ResourceSample {
  readonly childProcCount: number;
  readonly totalRssMb: number;
  readonly withinChildProcBudget: boolean;
  readonly withinRssBudget: boolean;
  readonly perClient: ReadonlyArray<{
    readonly language: string;
    readonly pid: number | null;
    readonly rssMb: number | null;
    readonly coldStartMs: number;
  }>;
}

function rssMbForPid(pid: number | null): number | null {
  if (pid === null) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return m ? Math.round((Number(m[1]) / 1024) * 10) / 10 : null;
  } catch {
    // The process exited between inventory and sampling. Report absence, never 0 —
    // a fabricated zero would read as "costs nothing".
    return null;
  }
}

/** Sample what the LSP adapter's resident servers currently cost. */
export function sampleLspResources(): ResourceSample {
  const perClient = lspClientInventory().map((c) => ({
    language: c.language as string,
    pid: c.pid,
    rssMb: rssMbForPid(c.pid),
    coldStartMs: c.coldStartMs,
  }));

  const totalRssMb =
    Math.round(perClient.reduce((sum, c) => sum + (c.rssMb ?? 0), 0) * 10) / 10;

  return {
    childProcCount: perClient.length,
    totalRssMb,
    withinChildProcBudget: perClient.length <= DEFAULT_RESOURCE_BUDGET.childProcMax,
    withinRssBudget: totalRssMb <= DEFAULT_RESOURCE_BUDGET.rssMbMax,
    perClient,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LspLegOptions {
  readonly repoRoot: string;
  /** Shut every server down first so the first query per language is a true cold start. */
  readonly cold?: boolean;
  /**
   * Ceiling for ONE probe's poll-to-correct loop. Generous on purpose: a short
   * deadline records a TIMEOUT as a WRONG ANSWER, which is a lie about the backend.
   */
  readonly deadlineMs?: number;
  /**
   * Ceiling for the WHOLE leg. Without this, `deadlineMs` multiplies by the probe
   * count and a single slow probe starves the rest, so the harness times out and
   * NO report is produced — the worst outcome, because it yields no data at all.
   * With it, a slow probe is bounded and the remaining probes are reported as
   * not-attempted, which is a partial result rather than a lost run.
   */
  readonly legBudgetMs?: number;
  readonly pollMs?: number;
  /** Restrict to these corpus case ids (default: every probe). */
  readonly only?: readonly string[];
}

export interface LspLegReport {
  readonly backend: CodeIntelBackend;
  readonly measurements: readonly BenchMeasurement[];
  readonly resources: ResourceSample;
  /** Corpus cases whose intent the adapter does not serve — a capability GAP, not a wrong answer. */
  readonly declinedIntents: readonly { caseId: string; intent: CodeIntelIntent; error: string }[];
}

/**
 * Run the in-operator LSP adapter across the probe set.
 *
 * Ordering matters: probes are grouped by file extension so each language
 * server pays exactly one cold start, and only the first probe for a language
 * is flagged `serverWasCold`. Reporting a warm query as a cold start would
 * flatter the backend by an order of magnitude.
 */
export async function runLspAdapterLeg(opts: LspLegOptions): Promise<LspLegReport> {
  const {
    repoRoot,
    cold = true,
    deadlineMs = 120_000,
    legBudgetMs = 600_000,
    pollMs = 250,
    only,
  } = opts;

  if (cold) await shutdownAllLspClients();

  const probes = BENCH_PROBES.filter((p) => !only || only.includes(p.caseId));
  const measurements: BenchMeasurement[] = [];
  const declinedIntents: { caseId: string; intent: CodeIntelIntent; error: string }[] = [];
  const languagesStarted = new Set<string>();
  const legStarted = Date.now();

  for (const probe of probes) {
    const kase = corpusCase(probe.caseId);
    if (!kase) throw new Error(`bench probe references unknown corpus case '${probe.caseId}'`);

    const cursor = resolveProbeCursor(probe, repoRoot);
    const ext = probe.file.slice(probe.file.lastIndexOf('.'));
    const serverWasCold = !languagesStarted.has(ext);

    // Bound this probe by whichever runs out first: its own deadline, or what
    // is left of the whole leg.
    const remaining = legBudgetMs - (Date.now() - legStarted);
    if (remaining <= 0) {
      measurements.push({
        caseId: kase.id,
        intent: kase.intent,
        backend: 'lsp-adapter',
        serverWasCold: false,
        timeToCorrectMs: null,
        warmQueryMs: null,
        attempts: 0,
        correct: false,
        trustworthyEmpty: true, // never queried, so it made no empty claim at all
        grade: { correct: false, missing: [], extra: [], reason: 'not attempted' },
        error: `leg budget of ${legBudgetMs}ms exhausted before this probe ran`,
        returnedSites: [],
        emptyThenFilledMs: null,
        notAttempted: true,
      });
      continue;
    }
    const probeDeadline = Math.min(deadlineMs, remaining);
    languagesStarted.add(ext);

    const started = Date.now();
    let attempts = 0;
    let firstHealthyEmptyAt: number | null = null;
    let last: CodeIntelAnswer | null = null;
    let grade: GradeResult = { correct: false, missing: [], extra: [], reason: 'never queried' };

    // Poll until CORRECT, not until answered — see the file header.
    while (Date.now() - started < probeDeadline) {
      attempts += 1;
      last = await lspQuery(kase.intent, cursor);
      grade = gradeSites(kase, last.sites);
      if (grade.correct) break;
      // An unserved intent will never become correct by waiting.
      if (last.error && /not served/.test(last.error)) break;
      // A HEALTHY answer WITH SITES is the server's FINAL word, right or wrong.
      // Polling past it cannot change the result — it only spins to the
      // deadline and then reports a TIMEOUT, which misattributes a correctness
      // failure as a latency failure. (Measured: this turned an 8s wrong answer
      // into a 420s fake hang, and sent me looking at the box and the language
      // server instead of at the answer I already had.)
      if (last.freshness.health === 'healthy' && last.sites.length > 0) break;

      // ...but a HEALTHY EMPTY is the single most dangerous answer in this
      // system, and it must NOT be taken as final. It is byte-identical to
      // "still loading": awaitProjectReady concludes the project is ready as
      // soon as no progress token is pending, which a server that has not yet
      // CREATED its token satisfies vacuously. So we keep asking. If sites
      // appear later, the earlier "healthy empty" was a LIE — and that is a
      // finding about the backend, not about this probe. `emptyThenFilledMs`
      // records it so the lie is measured rather than merely suspected.
      if (last.freshness.health === 'healthy' && firstHealthyEmptyAt === null) {
        firstHealthyEmptyAt = Date.now();
      }
      await sleep(pollMs);
    }

    const timeToCorrectMs = grade.correct ? Date.now() - started : null;

    if (last?.error && /not served/.test(last.error)) {
      declinedIntents.push({ caseId: kase.id, intent: kase.intent, error: last.error });
    }

    // Warm re-query for the steady-state number the policy actually budgets.
    let warmQueryMs: number | null = null;
    if (grade.correct) {
      const t = Date.now();
      await lspQuery(kase.intent, cursor);
      warmQueryMs = Date.now() - t;
    }

    measurements.push({
      caseId: kase.id,
      intent: kase.intent,
      backend: 'lsp-adapter',
      serverWasCold,
      timeToCorrectMs,
      warmQueryMs,
      attempts,
      correct: grade.correct,
      trustworthyEmpty: last ? isTrustworthyEmpty(last) : false,
      grade,
      error: last?.error ?? null,
      returnedSites: (last?.sites ?? []).map((s) => `${s.path}:${s.line1 ?? '?'}`),
      emptyThenFilledMs:
        firstHealthyEmptyAt !== null && (last?.sites.length ?? 0) > 0
          ? Date.now() - firstHealthyEmptyAt
          : null,
      notAttempted: false,
    });
  }

  return {
    backend: 'lsp-adapter',
    measurements,
    resources: sampleLspResources(),
    declinedIntents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparator surface audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tool surface of `mcp-language-server`, read from the PINNED source at
 * tag v0.1.1 (`internal/tools/`, `tools.go`) rather than recalled.
 *
 * `writesToDisk` is not inferred from the name — it records whether the
 * handler reaches `utilities.ApplyWorkspaceEdit`, which is what actually puts
 * bytes on disk. Naming the mechanism is the point: a backend is disqualified
 * from this READ plane by what it can do, never by what it is called.
 */
export const MCP_LANGUAGE_SERVER_TOOL_SURFACE: readonly {
  readonly name: string;
  readonly writesToDisk: boolean;
  readonly evidence: string;
}[] = Object.freeze([
  {
    name: 'edit_file',
    writesToDisk: true,
    evidence: 'internal/tools/edit_file.go:81 → utilities.ApplyWorkspaceEdit',
  },
  { name: 'definition', writesToDisk: false, evidence: 'tools.go:98 — symbolName lookup' },
  { name: 'references', writesToDisk: false, evidence: 'tools.go:122 — symbolName lookup' },
  { name: 'diagnostics', writesToDisk: false, evidence: 'tools.go:146 — filePath read' },
  { name: 'hover', writesToDisk: false, evidence: 'tools.go:253 — filePath/line/column read' },
  {
    name: 'rename_symbol',
    writesToDisk: true,
    evidence: 'internal/tools/rename-symbol.go:116 → utilities.ApplyWorkspaceEdit',
  },
]);

/** Intents a cursor/symbol backend must serve to answer the ground-truth corpus. */
export const CORPUS_GROUND_TRUTH_INTENTS: readonly CodeIntelIntent[] = Object.freeze(
  [...new Set(ACCEPTANCE_CORPUS.filter((c) => c.gradeMode !== 'property').map((c) => c.intent))],
);

export interface SurfaceAudit {
  /** Tools that put bytes on disk — each one breaks the read-plane invariant. */
  readonly mutatingTools: readonly string[];
  /** Disk-writers our own name-based guard fails to flag. The gap that matters. */
  readonly mutatingButUnflagged: readonly string[];
  /** Ground-truth intents this surface cannot express at all. */
  readonly unservableIntents: readonly CodeIntelIntent[];
  readonly readPlaneSafe: boolean;
}

/**
 * Audit a backend's tool surface against the read-plane invariant.
 *
 * Two independent questions, deliberately not collapsed:
 *   1. does it mutate?           — disqualifying on its own
 *   2. can it express our intents? — determines whether a number is even obtainable
 *
 * `mutatingButUnflagged` measures OUR guard, not theirs: a disk-writing tool
 * whose name `isMutatingToolName` waves through is a hole in our defence that a
 * test over invented names can never find.
 */
export function auditToolSurface(
  surface: readonly { name: string; writesToDisk: boolean }[],
  servedIntents: readonly CodeIntelIntent[],
  requiredIntents: readonly CodeIntelIntent[] = CORPUS_GROUND_TRUTH_INTENTS,
): SurfaceAudit {
  const mutatingTools = surface.filter((t) => t.writesToDisk).map((t) => t.name);
  const mutatingButUnflagged = mutatingTools.filter((n) => !isMutatingToolName(n));
  const unservableIntents = requiredIntents.filter((i) => !servedIntents.includes(i));

  return {
    mutatingTools,
    mutatingButUnflagged,
    unservableIntents,
    readPlaneSafe: mutatingTools.length === 0,
  };
}

/** Intents `mcp-language-server` v0.1.1 can express, mapped from its tool names. */
export const MCP_LANGUAGE_SERVER_SERVED_INTENTS: readonly CodeIntelIntent[] = Object.freeze([
  'definition',
  'references',
  'diagnostics',
]);

/** Render a leg report as a compact table for a Decision body. */
export function formatLegReport(report: LspLegReport): string {
  const rows = report.measurements.map((m) =>
    [
      m.notAttempted ? 'SKIP' : m.correct ? 'PASS' : 'FAIL',
      m.caseId,
      m.intent,
      m.serverWasCold ? 'cold-start' : 'warm-start',
      `toCorrect=${m.timeToCorrectMs === null ? 'NEVER' : `${m.timeToCorrectMs}ms`}`,
      `warm=${m.warmQueryMs === null ? 'n/a' : `${m.warmQueryMs}ms`}`,
      `attempts=${m.attempts}`,
      m.emptyThenFilledMs !== null
        ? `⚠ FALSE-EMPTY: claimed healthy+empty, filled ${m.emptyThenFilledMs}ms later`
        : '',
      m.correct ? '' : `(${m.grade.reason})`,
      !m.correct && !m.notAttempted
        ? `returned=[${m.returnedSites.join(', ') || 'nothing'}]`
        : '',
      m.error && !m.notAttempted ? `err=${m.error}` : '',
    ]
      .filter(Boolean)
      .join('  '),
  );
  const r = report.resources;
  rows.push(
    `resources: ${r.childProcCount} server proc(s), ${r.totalRssMb}MB RSS ` +
      `(budget ${DEFAULT_RESOURCE_BUDGET.childProcMax} proc / ${DEFAULT_RESOURCE_BUDGET.rssMbMax}MB) ` +
      `procBudget=${r.withinChildProcBudget ? 'OK' : 'EXCEEDED'}`,
  );
  for (const d of report.declinedIntents) {
    rows.push(`declined: ${d.caseId} (${d.intent}) — ${d.error}`);
  }
  return rows.join('\n');
}
