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
import {
  languageForFile,
  lspClientInventory,
  lspQuery,
  shutdownAllLspClients,
  type LspLanguage,
} from './lsp-adapter.ts';

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
    line1: 169,
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
// Accounted ground-truth divergences
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A corpus site a conforming LSP backend provably CANNOT return, together with
 * the case's own falsifier restated as a machine check.
 *
 * This exists because the acceptance corpus is FROZEN (D-024) and one of its
 * expected-site lists encodes GREP semantics — every line whose text mentions
 * the symbol — where the backend implements REFERENCE semantics. Editing the
 * corpus to match the backend would destroy the baseline; editing the test to
 * expect three-of-four passes would silently absorb the NEXT regression too.
 *
 * So a divergence is ACCOUNTED instead: it must name exactly which sites are
 * unreachable and why, and the case's OWN stated property must still hold. A
 * failure that misses any OTHER site, or that breaks the property, is a real
 * failure and stays one.
 */
export interface KnownDivergence {
  readonly caseId: string;
  /** Expected sites the backend cannot return, as `path:line1` keys. */
  readonly unreachableSites: readonly string[];
  readonly why: string;
  /** The case's `falsifies` text, restated as a check over what came back. */
  readonly property: string;
  readonly propertyHolds: (m: BenchMeasurement) => boolean;
}

export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = Object.freeze([
  Object.freeze({
    caseId: 'references-through-barrel-reexport',
    unreachableSites: ['libs/generic/dock-workbench/src/index.ts:4'],
    why:
      "The barrel line is `export * from './panel-registry'` — a WILDCARD " +
      're-export, which names no symbol. tsserver resolves it for import ' +
      'purposes but never reports it as a reference TO `PanelRegistry`, ' +
      'because textually it is not one. The corpus expects it because a ' +
      'grep for the symbol would surface the file, not because a reference ' +
      'query should. (The case\'s OTHER expected site — the declaration — IS ' +
      'reachable and is now returned; it was missing only because the ' +
      'adapter hardcoded context.includeDeclaration:false, which was a real ' +
      'defect and is fixed.)',
    property:
      'the reference set REACHES CONSUMERS IMPORTING THROUGH THE BARREL — ' +
      'the case exists to catch a backend that stops at the barrel and ' +
      'returns a false-empty set read as proof nothing uses the symbol',
    propertyHolds: (m: BenchMeasurement): boolean =>
      // Non-empty, and reaching at least one file that is neither the
      // declaring module nor the barrel itself — i.e. a real consumer found
      // THROUGH the re-export.
      m.returnedSites.length > 0 &&
      m.returnedSites.some(
        (s: string) =>
          !s.startsWith('libs/generic/dock-workbench/src/panel-registry.ts:') &&
          !s.startsWith('libs/generic/dock-workbench/src/index.ts:'),
      ),
  }),
]);

export interface DivergenceVerdict {
  readonly accounted: boolean;
  readonly reason: string;
}

/**
 * Decide whether a failing measurement is an ACCOUNTED corpus divergence.
 *
 * Deliberately strict on both axes: the missing set must be a SUBSET of the
 * documented unreachable sites (so a newly-missing site is never absorbed),
 * and the case's own property must still hold (so a divergence label can
 * never cover a real regression).
 */
export function classifyDivergence(m: BenchMeasurement): DivergenceVerdict {
  if (m.correct) return { accounted: false, reason: 'measurement is correct' };

  const known = KNOWN_DIVERGENCES.find((d) => d.caseId === m.caseId);
  if (!known) {
    return { accounted: false, reason: `no accounted divergence for '${m.caseId}'` };
  }

  const unexpected = m.grade.missing.filter((k) => !known.unreachableSites.includes(k));
  if (unexpected.length > 0) {
    return {
      accounted: false,
      reason:
        `missing site(s) NOT covered by the accounted divergence: ${unexpected.join(', ')}` +
        ` (accounted: ${known.unreachableSites.join(', ') || 'none'})`,
    };
  }
  if (m.grade.extra.length > 0) {
    return {
      accounted: false,
      reason: `returned unsanctioned extra site(s): ${m.grade.extra.join(', ')}`,
    };
  }
  if (m.error !== null) {
    return { accounted: false, reason: `backend errored: ${m.error}` };
  }
  if (!known.propertyHolds(m)) {
    return {
      accounted: false,
      reason: `the case's own property NO LONGER HOLDS — ${known.property}`,
    };
  }

  return {
    accounted: true,
    reason: `accounted divergence: ${known.why} Property still holds: ${known.property}.`,
  };
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
  /**
   * MEDIAN latency of the warm re-queries — the steady-state number the
   * routing policy budgets. Null if the probe never graded correct.
   *
   * This was a SINGLE sample, and a single sample is not a steady state: the
   * same case measured 6ms on one run and 2183ms on the next, because the
   * first re-query lands while the server is still doing post-answer indexing
   * work. One unlucky sample then reads as the backend's warm latency and
   * fails a budget the backend actually meets.
   */
  readonly warmQueryMs: number | null;
  /** Every warm sample, in order, so the median is auditable rather than asserted. */
  readonly warmQuerySamplesMs: readonly number[];
  /**
   * The SLOWEST warm sample. Reported beside the median and never discarded:
   * the tail is what an agent actually waits through, so a median that meets
   * the budget while the tail does not is a finding, not a pass.
   */
  readonly warmQueryMaxMs: number | null;
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
   * The health the FINAL answer claimed. Recorded because its absence is what
   * forced WI-2142253 to be DEDUCED rather than read: a probe that polled 569
   * times while holding eight sites could only have been non-healthy, since a
   * healthy non-empty answer breaks the loop and a healthy empty one would have
   * set `emptyThenFilledMs`. That chain of reasoning was sound but should never
   * have been necessary — the health was right there and simply not kept.
   */
  readonly answerHealth: string | null;
  /**
   * How many times the returned site set actually CHANGED across the poll loop.
   *
   * This is the falsifier for the convergence cutoff. Polling a degraded
   * non-empty answer is not inherently pointless — the measured cold-open
   * failure returned two real sites while hundreds were still missing — so the
   * question "does waiting ever add sites?" has to be measured, not assumed. A
   * probe that stops on convergence with `siteSetChanges: 0` waited for nothing;
   * one with a high count on a long-stable window says the window is too short.
   */
  readonly siteSetChanges: number;
  /** How long the final site set had been unchanged when polling stopped. */
  readonly sitesStableForMs: number | null;
  /**
   * WHY the poll loop stopped. A `toCorrect=NEVER` row is otherwise ambiguous
   * between "the backend answered wrongly and settled" and "we ran out of time
   * while it was still working" — and those two demand opposite responses.
   */
  readonly pollStoppedOn:
    | 'correct'
    | 'not-served'
    | 'healthy-final'
    | 'converged'
    | 'deadline'
    | 'never-queried';
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
  /**
   * Summed across every resident server. This is the FLEET-relevant number —
   * what one agent session costs the box — but it is NOT what
   * `DEFAULT_RESOURCE_BUDGET.rssMbMax` bounds, so never grade it against that.
   */
  readonly totalRssMb: number;
  /**
   * The largest single resident server. THIS is the number the budget bounds:
   * ResourceBudget is documented "per backend process", and childProcMax is
   * one server per language per workspace — so two languages legitimately
   * mean two processes, and summing them before comparing to a per-process
   * ceiling grades the shared-server design as a budget breach.
   */
  readonly maxClientRssMb: number;
  readonly withinChildProcBudget: boolean;
  readonly withinRssBudget: boolean;
  /** Servers whose own RSS exceeds the per-process ceiling, named. */
  readonly overBudgetClients: ReadonlyArray<{ language: string; rssMb: number }>;
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
  const maxClientRssMb = perClient.reduce((max, c) => Math.max(max, c.rssMb ?? 0), 0);
  const overBudgetClients = perClient
    .filter((c) => (c.rssMb ?? 0) > DEFAULT_RESOURCE_BUDGET.rssMbMax)
    .map((c) => ({ language: c.language, rssMb: c.rssMb as number }));

  return {
    childProcCount: perClient.length,
    totalRssMb,
    maxClientRssMb,
    // PER LANGUAGE, for the same reason the RSS verdict is per process:
    // childProcMax is documented "per workspace", and the registry keys one
    // client per LANGUAGE. Comparing a cross-language count to it reported
    // `procBudget=EXCEEDED` on every two-language run — i.e. it called the
    // shared-server design a breach for doing exactly what it is designed
    // to do. What the budget forbids is a SECOND server for the SAME
    // language, which is what this now measures.
    withinChildProcBudget: [...new Set(perClient.map((c) => c.language))].every(
      (lang) =>
        perClient.filter((c) => c.language === lang).length <=
        DEFAULT_RESOURCE_BUDGET.childProcMax,
    ),
    // Graded PER PROCESS, matching what ResourceBudget documents itself to
    // bound. Summing first compared a two-language total against a
    // one-process ceiling and reported the shared-server design as a breach.
    withinRssBudget: overBudgetClients.length === 0,
    overBudgetClients,
    perClient,
  };
}

/**
 * Per-language RSS exceedances that are MEASURED, ACCOUNTED, and BOUNDED.
 *
 * `DEFAULT_RESOURCE_BUDGET.rssMbMax` is a frozen P-002 contract and is NOT
 * raised here — a budget edited to match the backend it is meant to judge
 * stops being a budget. Instead the one server that breaches it is named, with
 * the measurement and an observed ceiling, so that:
 *
 *   - every report keeps printing `rssBudget=EXCEEDED over=[rust …MB]`,
 *   - the breach is an input to backend selection (P-011) rather than a
 *     silenced assertion,
 *   - and the exceedance is still BOUNDED: growth past `observedCeilingMb`
 *     fails, and so does a NEW language appearing in this set.
 *
 * This is the resource analogue of KNOWN_DIVERGENCES: the honest answer to a
 * failing check is sometimes "this is real, here is its size and why we accept
 * it for now", never "assert less".
 */
export const KNOWN_RSS_EXCEEDANCES: readonly {
  readonly language: string;
  readonly observedMb: number;
  /** Fails if the server grows past this — the exceedance stays bounded. */
  readonly observedCeilingMb: number;
  readonly why: string;
}[] = Object.freeze([
  Object.freeze({
    language: 'rust',
    observedMb: 2826.6,
    observedCeilingMb: 4096,
    why:
      'rust-analyzer holds the whole crate graph in memory by design — for ' +
      'papercusp-desktop/src-tauri that is Tauri plus its full dependency ' +
      'tree. 2826.6MB is 2.8x the 1024MB per-process ceiling and rust-analyzer ' +
      'offers no hard cap, so it CANNOT be bounded to the P-002 budget on this ' +
      'repo. Recorded as a selection input rather than hidden: it is the ' +
      'single largest resource fact about the adapter, and it is paid ONCE per ' +
      'workspace (the registry is module-pinned and keyed by language, so all ' +
      'agents in an operator share this one server) rather than per agent. ' +
      'For comparison the TypeScript server measured 66.6MB on the same run.',
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Cold start
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The language a probe's cursor belongs to.
 *
 * Deliberately delegates to the adapter's own `languageForFile` rather than
 * re-deriving from the extension: the leg keys `serverWasCold` off the raw
 * extension, and a second, private extension→language table here would be free
 * to disagree with the one that actually chose the server. A probe must never
 * be graded against a language it was not answered by.
 */
export function probeLanguage(caseId: string): LspLanguage | null {
  const probe = BENCH_PROBES.find((p) => p.caseId === caseId);
  return probe ? languageForFile(probe.file) : null;
}

/**
 * Cold starts that exceed `coldStartMsMax`, accepted for now and BOUNDED.
 *
 * The same discipline `KNOWN_RSS_EXCEEDANCES` applies to memory: an
 * over-budget backend must be a NAMED, measured exceedance or a failure, and
 * an accepted one must not be free to grow without limit.
 */
export const KNOWN_COLD_START_EXCEEDANCES: readonly {
  readonly language: LspLanguage;
  readonly observedMs: number;
  /** Fails if a cold start grows past this — the exceedance stays bounded. */
  readonly observedCeilingMs: number;
  readonly why: string;
}[] = Object.freeze([
  Object.freeze({
    language: 'rust' as LspLanguage,
    observedMs: 10_760,
    observedCeilingMs: 120_000,
    why:
      'rust-analyzer must run `cargo metadata` and build proc macros for the ' +
      'papercusp-desktop/src-tauri crate graph before it can answer, so its ' +
      'time-to-CORRECT cannot meet the 10s budget on this repo. Graded to ' +
      'correct rather than to the `initialize` handshake (69ms), which is the ' +
      'flattering number an agent never experiences — see the file header. ' +
      'The ceiling is deliberately far above the 10,760ms measured: this ' +
      'number is cache- and load-sensitive (a cold cargo cache is minutes, and ' +
      'this box runs at high fleet load), so the ceiling is a tripwire for an ' +
      'ORDER-OF-MAGNITUDE regression, not a performance target. A tight ' +
      'ceiling here would be a flake generator, and a flaky gate test freezes ' +
      'the whole fleet.',
  }),
  Object.freeze({
    language: 'typescript' as LspLanguage,
    observedMs: 11_483,
    observedCeilingMs: 60_000,
    why:
      'tsserver must load the monorepo project graph — tsconfig resolution, ' +
      'project references, and the transitive import closure of the asking ' +
      'file — before it can answer a cross-package definition, so its ' +
      'time-to-CORRECT does not meet the 10s budget on this repo either. ' +
      'Measured 10,306 / 10,665 / 11,483ms across bakeoff legs v1-v3 ' +
      '(WI-2142287): over budget on 3 of 3, never by more than 15%. ' +
      'This entry exists because the budget is REPO-SCALE, not rust-specific. ' +
      '`coldStartMsMax` was a dead field until P-018 activated it, and the ' +
      'table it feeds was populated from the only language anyone had a ' +
      'number for — leg v1 starved the rust probe entirely (attempts=0), so ' +
      'rust was measured first and got the sole entry. In leg v3 rust came in ' +
      'at 9,762ms, UNDER budget, while this unaccounted probe breached: the ' +
      'one language carrying an accounting entry was the one that met the ' +
      'budget. Nothing regressed — a second language simply became visible. ' +
      'The ceiling is a tripwire for an ORDER-OF-MAGNITUDE regression, not a ' +
      'performance target, and is deliberately TIGHTER than rust’s 120s: ' +
      'rust earns that headroom because a cold cargo cache costs minutes of ' +
      'proc-macro BUILDING, whereas tsserver only ever parses and resolves, ' +
      'so it has no comparable multi-minute cold path to absorb. Do not ' +
      'tighten it toward the observed number — typescript is the STABLE leg ' +
      'here (11% spread vs rust’s 60%), but this box runs at high fleet ' +
      'load and a tight ceiling would be a flake generator on the gate.',
  }),
]);

/**
 * The part of an accounting table `classifyColdStarts` actually reads.
 *
 * Exists so the guard's control can INJECT a table instead of naming a
 * language absent from the real one. `LspLanguage` has exactly two members
 * and both are now accounted (WI-2142287), so "an over-budget language nobody
 * accounted for" is no longer expressible in real data — and a control that
 * depends on the table staying incomplete stops being a control the moment
 * someone completes it. Silently, and precisely when the integration
 * assertion it guards has become decorative.
 */
export type ColdStartAccounting = readonly {
  readonly language: LspLanguage;
  readonly observedCeilingMs: number;
}[];

/** One cold start graded against the budget. */
export interface ColdStartVerdict {
  readonly caseId: string;
  readonly language: LspLanguage | null;
  readonly timeToCorrectMs: number;
  readonly overBudget: boolean;
  /** True when over budget AND named in KNOWN_COLD_START_EXCEEDANCES. */
  readonly accounted: boolean;
  /** The accounting entry's ceiling, when there is one. */
  readonly ceilingMs: number | null;
}

/**
 * Grade every COLD probe's time-to-correct against `coldStartMsMax`.
 *
 * Only measurements that actually paid a cold start and actually reached a
 * correct answer are graded: a probe that never graded correct is a
 * CORRECTNESS failure and is reported as one elsewhere, and folding it in here
 * would misreport it a second time as a latency breach.
 */
export function classifyColdStarts(
  measurements: readonly BenchMeasurement[],
  accounting: ColdStartAccounting = KNOWN_COLD_START_EXCEEDANCES,
): readonly ColdStartVerdict[] {
  const out: ColdStartVerdict[] = [];
  for (const m of measurements) {
    if (!m.serverWasCold || m.notAttempted || m.timeToCorrectMs === null) continue;
    const language = probeLanguage(m.caseId);
    const known = accounting.find((k) => k.language === language);
    const overBudget = m.timeToCorrectMs > DEFAULT_RESOURCE_BUDGET.coldStartMsMax;
    out.push({
      caseId: m.caseId,
      language,
      timeToCorrectMs: m.timeToCorrectMs,
      overBudget,
      accounted: overBudget && known !== undefined,
      ceilingMs: known?.observedCeilingMs ?? null,
    });
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Median of a sample set, or null when there is nothing to reduce.
 *
 * Deliberately the median and not the mean: warm-query latency is
 * right-skewed (an occasional re-index stall is many times the typical
 * query), and a mean lets one such stall misreport the steady state. It is
 * also deliberately not the MIN — that would flatter the backend by
 * reporting its best case as its behaviour.
 */
export function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round((((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) * 10) / 10;
}

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
  /**
   * How long a NON-EMPTY answer's site set must stay unchanged before the poll
   * loop accepts it as the backend's converged result (default 5000ms).
   *
   * This exists because the `healthy && sites.length > 0` break below could not
   * fire for a DEGRADED answer, and there was no other exit but the deadline.
   * Measured (leg v2, WI-2142253): `references-through-barrel-reexport` re-asked
   * the same question 569 times over ~290s — about half the whole leg budget —
   * and ended holding the eight sites it already had on attempt 1. That is the
   * upstream cause of the budget pressure the per-probe reservation only shares
   * out more fairly.
   *
   * EMPTY answers are deliberately NOT subject to this. An empty is
   * byte-identical to "still loading", so elapsed time is the only evidence
   * available about it and cutting the poll short would destroy the very
   * false-empty detection the acceptance corpus exists to perform. Convergence
   * is a claim you may only make about an answer that HAS content.
   */
  readonly stableForMs?: number;
  /**
   * How many warm re-queries to sample per probe before taking the median.
   * Default 5 — enough that one post-answer indexing stall cannot BE the
   * reported steady state, cheap enough that it costs milliseconds on a hot
   * server.
   */
  readonly warmSamples?: number;
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
 * How much of the leg budget one probe may spend, given how many probes still
 * have not had a turn.
 *
 * Extracted and exported so the reservation property is assertable without
 * standing up real language servers: the integration leg it governs takes ~600s,
 * which is far too slow to be the only thing proving a budget rule.
 *
 * The floor is a RESERVATION, not a cap — it is withheld only while a probe is
 * still waiting, so the last probe to run is never charged for it.
 *
 * The unit is the PROBE, not the language, and that distinction is the whole
 * lesson of this function. A first version reserved per LANGUAGE, which removed
 * the language-level ordering bias and left the probe-level one untouched:
 * measured back-to-back on 2026-09-02 against the same 4-probe leg, the
 * per-language rule simply MOVED the starvation from the rust probe to the
 * third TypeScript probe. Exactly one probe reported `attempts=0` either way.
 * Reserve at the level of the thing that can actually be starved.
 */
export function probeBudget(args: {
  readonly legBudgetMs: number;
  readonly elapsedMs: number;
  /** How many probes come AFTER this one in the leg — each is owed a floor. */
  readonly probesAfterThis: number;
  /** Total probes in the leg; sets the size of one probe's floor. */
  readonly legProbeCount: number;
}): {
  readonly remainingMs: number;
  readonly reservedForOthersMs: number;
  readonly perProbeFloorMs: number;
} {
  const { legBudgetMs, elapsedMs, probesAfterThis, legProbeCount } = args;
  const perProbeFloorMs = legBudgetMs / Math.max(1, legProbeCount);
  const reservedForOthersMs = Math.max(0, probesAfterThis) * perProbeFloorMs;
  return {
    remainingMs: legBudgetMs - elapsedMs - reservedForOthersMs,
    reservedForOthersMs,
    perProbeFloorMs,
  };
}

/**
 * Whether the poll loop has learned everything it is going to, and if so WHY.
 * `null` means keep asking.
 *
 * Extracted for the same reason `probeBudget` was — the loop it governs needs
 * real language servers and ~600s to exercise — but also for a reason specific
 * to this decision: the missing case that became WI-2142253 was invisible
 * BECAUSE the conditions were four `break` statements scattered through a
 * sixty-line loop, separated by paragraphs of commentary. Nothing anywhere
 * enumerated them, so "a non-empty answer that is not healthy" was not a case
 * anyone had decided to leave out; it was a case nobody could see wasn't there.
 * Stated as one total function, the gap is a missing branch instead of an
 * absence, and the tests below can enumerate the space.
 */
export function pollStopDecision(args: {
  readonly correct: boolean;
  readonly errorText: string | null;
  readonly health: string;
  readonly siteCount: number;
  /** How long the site set has been unchanged, in ms. */
  readonly siteSetUnchangedForMs: number;
  readonly stableForMs: number;
}): Exclude<BenchMeasurement['pollStoppedOn'], 'deadline' | 'never-queried'> | null {
  const { correct, errorText, health, siteCount, siteSetUnchangedForMs, stableForMs } = args;

  if (correct) return 'correct';
  // An unserved intent will never become correct by waiting.
  if (errorText && /not served/.test(errorText)) return 'not-served';

  // A HEALTHY answer WITH SITES is the server's FINAL word, right or wrong.
  // Polling past it cannot change the result — it only spins to the deadline
  // and then reports a TIMEOUT, which misattributes a correctness failure as a
  // latency failure. (Measured: this turned an 8s wrong answer into a 420s fake
  // hang, and sent me looking at the box and the language server instead of at
  // the answer I already had.)
  if (health === 'healthy' && siteCount > 0) return 'healthy-final';

  // The same reasoning, one step weaker, for the answer that previously had no
  // exit at all: NON-EMPTY, not entitled to call itself healthy, but no longer
  // moving.
  //
  // A degraded non-empty is not final on ARRIVAL — `healthForAnswer` downgrades
  // a non-empty answer whose intent readiness is unproven, and the measured
  // cold-open failure returned two real sites while hundreds were still
  // missing, so sites genuinely do arrive late. But "not final on arrival" is
  // not "worth re-asking forever": once the set has held still for
  // `stableForMs`, further polling is indistinguishable from waiting. The loop
  // was spending a whole probe deadline to learn that — 569 attempts over ~290s,
  // ending with the eight sites it already held on attempt 1 (WI-2142253).
  if (siteCount > 0 && siteSetUnchangedForMs >= stableForMs) return 'converged';

  // Everything else keeps polling — and the case that matters here is the EMPTY
  // answer, which is deliberately excluded from the rule above. An empty never
  // "converges" however long it sits still, because a stalled empty and a
  // still-loading empty are the same bytes. That is the false-empty the
  // acceptance corpus exists to catch, so it keeps its full deadline.
  return null;
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
    stableForMs = 5_000,
    warmSamples = 5,
    only,
  } = opts;

  if (cold) await shutdownAllLspClients();

  const probes = BENCH_PROBES.filter((p) => !only || only.includes(p.caseId));
  const measurements: BenchMeasurement[] = [];
  const declinedIntents: { caseId: string; intent: CodeIntelIntent; error: string }[] = [];
  const languagesStarted = new Set<string>();
  const legStarted = Date.now();

  // Every PROBE in the set is entitled to a FLOOR of the leg budget.
  //
  // Without a floor the budget is first-come-first-served, and the last probe is
  // not merely unlucky — it is structurally unreachable. A probe that never
  // converges polls for its full `deadlineMs`, and the integration leg runs
  // 300_000ms deadlines against a 600_000ms budget, so two such probes consume
  // the entire leg and everything after them reports `attempts=0 (not
  // attempted)`. Raising `legBudgetMs` cannot fix that: it raises what the
  // earlier probes are permitted to consume by exactly as much.
  //
  // MEASURED TWICE, and the second measurement is why this reserves per probe
  // rather than per language (EI-22174876232438025):
  //   leg v1, per-probe budget only  — rust `attempts=0`, never measured at all.
  //   leg v2, per-LANGUAGE floor     — rust measured (PASS, 15,635ms cold), and
  //                                    the third TypeScript probe took its place
  //                                    at `attempts=0`.
  // The language floor fixed the level it was aimed at and left the level below
  // it untouched. A budget that bounds an AGGREGATE converts "slow member" into
  // "later members never ran" at whatever granularity it is applied, so the
  // reservation has to sit on the atomic unit being measured.
  const probeLanguage = (file: string): string => file.slice(file.lastIndexOf('.'));

  for (const [probeIndex, probe] of probes.entries()) {
    const kase = corpusCase(probe.caseId);
    if (!kase) throw new Error(`bench probe references unknown corpus case '${probe.caseId}'`);

    const cursor = resolveProbeCursor(probe, repoRoot);
    const ext = probeLanguage(probe.file);
    const serverWasCold = !languagesStarted.has(ext);

    // Bound this probe by whichever runs out first: its own deadline, or what is
    // left of the leg AFTER honouring the floor still owed to probes that have
    // not run yet.
    //
    // The floor is a RESERVATION, not a cap. It is withheld only while a probe is
    // still waiting for its turn, so the leg stays work-conserving: a probe that
    // finishes early hands its unused share to the next one, and the final probe
    // has nothing withheld from it at all. That keeps the original property — a
    // slow probe yields a partial report rather than a lost run — while removing
    // the ordering bias that made the last probe unreachable.
    const probesAfterThis = probes.length - 1 - probeIndex;
    const {
      remainingMs: remaining,
      reservedForOthersMs: reservedForOthers,
      perProbeFloorMs,
    } = probeBudget({
      legBudgetMs,
      elapsedMs: Date.now() - legStarted,
      probesAfterThis,
      legProbeCount: probes.length,
    });
    if (remaining <= 0) {
      measurements.push({
        caseId: kase.id,
        intent: kase.intent,
        backend: 'lsp-adapter',
        serverWasCold: false,
        timeToCorrectMs: null,
        warmQueryMs: null,
        warmQuerySamplesMs: [],
        warmQueryMaxMs: null,
        attempts: 0,
        correct: false,
        trustworthyEmpty: true, // never queried, so it made no empty claim at all
        grade: { correct: false, missing: [], extra: [], reason: 'not attempted' },
        // Name WHICH of the two causes fired. A probe cut short because later
        // probes still hold their reserved floor has NOT hit an exhausted
        // budget, and reporting it as one would send a reader to raise
        // `legBudgetMs` — the one change that cannot help.
        error:
          reservedForOthers > 0
            ? `this probe's ${Math.round(perProbeFloorMs)}ms share of the ` +
              `${legBudgetMs}ms leg budget is spent; ${Math.round(reservedForOthers)}ms ` +
              `remains reserved for ${probesAfterThis} probe(s) that have not run yet`
            : `leg budget of ${legBudgetMs}ms exhausted before this probe ran`,
        returnedSites: [],
        emptyThenFilledMs: null,
        answerHealth: null,
        siteSetChanges: 0,
        sitesStableForMs: null,
        pollStoppedOn: 'never-queried',
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
    // Convergence tracking. The fingerprint is the SITE SET, not the whole
    // answer: health and freshness metadata churn on their own while the actual
    // result stands still, and it is the result we are waiting on.
    let siteFingerprint: string | null = null;
    let siteSetLastChangedAt = started;
    let siteSetChanges = 0;
    let pollStoppedOn: BenchMeasurement['pollStoppedOn'] = 'deadline';

    // Poll until CORRECT, not until answered — see the file header.
    while (Date.now() - started < probeDeadline) {
      attempts += 1;
      last = await lspQuery(kase.intent, cursor);
      grade = gradeSites(kase, last.sites);

      // Track whether the RESULT is still moving, independently of any break
      // below, so `siteSetChanges` measures the backend rather than the loop's
      // exit path — a probe that stops early must still be able to report how
      // many times the answer actually changed before it did.
      const fingerprint = last.sites.map((s) => `${s.path}:${s.line1 ?? '?'}`).join('|');
      if (fingerprint !== siteFingerprint) {
        if (siteFingerprint !== null) siteSetChanges += 1;
        siteFingerprint = fingerprint;
        siteSetLastChangedAt = Date.now();
      }

      // Every reason to stop lives in one total function — see pollStopDecision.
      const stop = pollStopDecision({
        correct: grade.correct,
        errorText: last.error,
        health: last.freshness.health,
        siteCount: last.sites.length,
        siteSetUnchangedForMs: Date.now() - siteSetLastChangedAt,
        stableForMs,
      });
      if (stop !== null) {
        pollStoppedOn = stop;
        break;
      }

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

    // Warm re-queries for the steady-state number the policy actually budgets.
    // Sampled REPEATEDLY and reduced to a median: one sample lands while the
    // server is still finishing post-answer indexing and is not steady state
    // at all (measured 6ms vs 2183ms for the same case on consecutive runs).
    const warmQuerySamplesMs: number[] = [];
    if (grade.correct) {
      for (let i = 0; i < warmSamples; i += 1) {
        const t = Date.now();
        await lspQuery(kase.intent, cursor);
        warmQuerySamplesMs.push(Date.now() - t);
      }
    }
    const warmQueryMs = median(warmQuerySamplesMs);
    const warmQueryMaxMs = warmQuerySamplesMs.length
      ? Math.max(...warmQuerySamplesMs)
      : null;

    measurements.push({
      caseId: kase.id,
      intent: kase.intent,
      backend: 'lsp-adapter',
      serverWasCold,
      timeToCorrectMs,
      warmQueryMs,
      warmQuerySamplesMs,
      warmQueryMaxMs,
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
      answerHealth: last?.freshness.health ?? null,
      siteSetChanges,
      sitesStableForMs: last === null ? null : Date.now() - siteSetLastChangedAt,
      pollStoppedOn,
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
  const rows = report.measurements.map((m) => {
    const divergence = m.correct ? null : classifyDivergence(m);
    const verdict = m.notAttempted
      ? 'SKIP'
      : m.correct
        ? 'PASS'
        : divergence?.accounted
          ? 'DIVERGE'
          : 'FAIL';
    return [
      verdict,
      m.caseId,
      m.intent,
      m.serverWasCold ? 'cold-start' : 'warm-start',
      `toCorrect=${m.timeToCorrectMs === null ? 'NEVER' : `${m.timeToCorrectMs}ms`}`,
      `warm=${m.warmQueryMs === null ? 'n/a' : `${m.warmQueryMs}ms`}` +
        (m.warmQueryMaxMs !== null && m.warmQuerySamplesMs.length > 1
          ? ` (median of ${m.warmQuerySamplesMs.length}, max=${m.warmQueryMaxMs}ms)`
          : ''),
      `attempts=${m.attempts}`,
      m.emptyThenFilledMs !== null
        ? `⚠ FALSE-EMPTY: claimed healthy+empty, filled ${m.emptyThenFilledMs}ms later`
        : '',
      // WHY the poll stopped, and what the answer claimed while it ran. Printed
      // on every non-PASS row because their absence is what made WI-2142253 a
      // deduction: `toCorrect=NEVER attempts=569` cannot, by itself, distinguish
      // a backend that settled on a wrong answer from one still working when the
      // clock ran out.
      m.correct || m.notAttempted
        ? ''
        : `stoppedOn=${m.pollStoppedOn} health=${m.answerHealth ?? '?'}` +
          ` siteSetChanges=${m.siteSetChanges}` +
          (m.sitesStableForMs !== null ? ` stableFor=${m.sitesStableForMs}ms` : ''),
      m.correct ? '' : `(${m.grade.reason})`,
      divergence?.accounted ? `ACCOUNTED — ${divergence.reason}` : '',
      !m.correct && !m.notAttempted
        ? `returned=[${m.returnedSites.join(', ') || 'nothing'}]`
        : '',
      m.error && !m.notAttempted ? `err=${m.error}` : '',
    ]
      .filter(Boolean)
      .join('  ');
  });
  const r = report.resources;
  rows.push(
    `resources: ${r.childProcCount} server proc(s), ` +
      `largest=${r.maxClientRssMb}MB, total=${r.totalRssMb}MB ` +
      `(budget ${DEFAULT_RESOURCE_BUDGET.childProcMax} proc / ` +
      `${DEFAULT_RESOURCE_BUDGET.rssMbMax}MB PER PROCESS) ` +
      `procBudget=${r.withinChildProcBudget ? 'OK' : 'EXCEEDED'} ` +
      `rssBudget=${r.withinRssBudget ? 'OK' : 'EXCEEDED'}` +
      (r.overBudgetClients.length
        ? ` over=[${r.overBudgetClients.map((c) => `${c.language} ${c.rssMb}MB`).join(', ')}]`
        : ''),
  );
  rows.push(
    `  per-server: ${r.perClient
      .map((c) => `${c.language} ${c.rssMb === null ? 'rss?' : `${c.rssMb}MB`} cold=${c.coldStartMs}ms`)
      .join(' | ')}`,
  );
  for (const d of report.declinedIntents) {
    rows.push(`declined: ${d.caseId} (${d.intent}) — ${d.error}`);
  }
  return rows.join('\n');
}
