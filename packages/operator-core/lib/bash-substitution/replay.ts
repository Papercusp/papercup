/**
 * The OUTPUT-DIFF REPLAY harness (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-021).
 *
 * THE METHOD, in one sentence: take a real corpus command, REWRITE it to the tool
 * call, execute BOTH sides, and diff the ANSWERS — so a row earns auto-substitution
 * (P-022) by demonstration rather than by argument.
 *
 * ── Why this exists alongside `equivalence.ts` ───────────────────────────────
 * The equivalence harness asks "can the tool EXPRESS this command?" and answers it
 * from a hand-written capability envelope. That is the right question for an
 * ADVISORY: the agent still reads the result and notices if it looks wrong.
 *
 * It is NOT sufficient for auto-substitution, where the hook rewrites the command
 * and the agent never sees the original. There the question is "does the rewrite
 * return the SAME ANSWER?", and an envelope cannot answer it — an envelope models
 * what a tool's ARGUMENTS accept, not what its OUTPUT contains. The gap is not
 * hypothetical: this harness's first run found `head FILE` (no count) rewriting to
 * a 2000-line read where bash returns 10, on a pair whose recorded verdict is
 * `equivalent` and honestly so. Expressibility was never wrong; it was answering a
 * different question.
 *
 * ── The three ways an output-diff harness lies, and what stops each ──────────
 * A replay harness that reports "clean" is claiming something very strong, so most
 * of this file is about the ways that claim can be false while the code looks fine.
 *
 * 1. BOTH SIDES FAILED, which a naive differ scores as agreement. The corpus is
 *    months of real commands against paths that mostly no longer exist, so this is
 *    the DEFAULT outcome of a careless implementation, not an edge case — a harness
 *    could report every row clean while having compared nothing at all. Hence
 *    {@link deriveCaseVerdict}: a shared failure is `inconclusive`, never `match`,
 *    and so is a comparison of two empty answers.
 *
 * 2. THE NORMALIZER ATE THE DIFFERENCE. The two sides cannot be compared as bytes
 *    (a tool returns a framed, line-numbered payload; bash returns a raw stream),
 *    so something must strip the framing — and whoever writes that step controls
 *    the verdict. A normalizer that "tidies" output by sorting, folding case, or
 *    collapsing whitespace can hide exactly the regressions P-024 warns about (a
 *    lost tsc error location, a dropped failing-test name). So the permitted
 *    operations are a CLOSED SET (see {@link AnswerEnvelope}), they are DECLARED
 *    per pair rather than inferred, and {@link assertReplayEnvelope} refuses an
 *    unanchored line-prefix pattern outright — an unanchored strip can delete
 *    matching text from the MIDDLE of a line, which is content loss disguised as
 *    normalization.
 *
 * 3. IT NEVER RAN. A pair with no `rewrite`, a command the safety gate refused, a
 *    sample of zero — each yields a set of cases with no failures in it, which is
 *    not the same as a set of passes. {@link deriveReplayVerdict} therefore treats
 *    `refused` and `inconclusive` as blocking `replay-clean`, by exactly the D-008
 *    argument the equivalence harness already makes: the PATTERN is the unit of
 *    enforcement, so partial coverage of it is not coverage.
 *
 * ── Why replay runs against a FIXTURE, not the live tree ─────────────────────
 * The corpus command supplies the SHAPE; its file operand is retargeted onto a
 * generated fixture with known content. Replaying verbatim would be
 * non-deterministic (the tree changes under it), unsafe (the corpus contains
 * commands with side effects), and — the reason that actually decides it —
 * useless, because most corpus paths are gone, which lands every case in trap (1).
 */

import { execFile } from 'node:child_process';
import type {
  AnswerEnvelope,
  ReplayToolCall,
  SampledCommand,
  SubstitutionPair,
} from './types';

/** How one replayed command turned out. */
export type ReplayCaseVerdict =
  /** Both sides answered, and the answers are identical. The only good outcome. */
  | 'match'
  /** Both sides ran and the answers are NOT identical — or one answered and one did not. */
  | 'differs'
  /** Nothing was actually compared (both failed, or both answers were empty). */
  | 'inconclusive'
  /** The harness declined to run this case (unsafe command, or no rewrite). */
  | 'refused';

/** The pair-level verdict — the gate P-022 reads. */
export type ReplayVerdict =
  /** Every case ran and every case matched. Eligible for auto-substitution. */
  | 'replay-clean'
  /** At least one case produced a different answer. Never auto-substitute. */
  | 'replay-differs'
  /** Nothing differed, but the coverage is incomplete — not the same as clean. */
  | 'replay-inconclusive'
  /** This pair cannot be replayed at all (no `rewrite` declared). */
  | 'replay-unavailable';

/** One replayed command and what it showed. */
export interface ReplayCase {
  /** The original corpus atom, before retargeting. */
  sourceAtom: string;
  /** The command actually executed (operand retargeted onto the fixture). */
  replayedAtom: string;
  /** The tool call the rewrite produced, if it produced one. */
  toolCall?: ReplayToolCall;
  verdict: ReplayCaseVerdict;
  /** Why, for every verdict except `match`. Always populated when not a match. */
  reason?: string;
  /** 1-based index of the first differing answer line, when `differs`. */
  firstDivergentLine?: number;
  /** The two normalized answers, capped for storage. Present when both sides ran. */
  bashAnswer?: string[];
  toolAnswer?: string[];
}

/** The replay result for one pair. */
export interface PairReplay {
  pairId: string;
  toolName: string;
  verdict: ReplayVerdict;
  /** Why the verdict is not `replay-clean`. Empty string when it is. */
  verdictReason: string;
  cases: ReplayCase[];
  matched: number;
  differed: number;
  inconclusive: number;
  refused: number;
}

/** Raw result of running one side. */
export interface SideResult {
  /** The side produced an answer at all (bash exit 0 / the tool did not error). */
  ok: boolean;
  /** The raw text, pre-normalization. */
  text: string;
  /** Populated when `ok` is false — surfaced in the case `reason`. */
  failure?: string;
}

/**
 * The two executors, injected rather than imported.
 *
 * Dependency-inverted so the unit tests can drive the harness's own logic with
 * scripted sides — but note that a harness proven ONLY against scripted sides is
 * proving its own fake. `replay.test.ts` therefore also runs the REAL
 * `capability:read` handler against real files, which is what caught the
 * `head FILE` divergence: no invented fixture would have contained it, because
 * inventing the fixture means already knowing the answer.
 */
export interface ReplayExecutors {
  runBash(command: string, cwd: string): Promise<SideResult>;
  runTool(call: ReplayToolCall): Promise<SideResult>;
}

export interface ReplayOptions {
  /** Absolute path of the fixture file every case is retargeted onto. */
  fixturePath: string;
  /** Working directory for the bash side. */
  cwd: string;
  /** Cap on cases replayed — each spawns a shell, and a corpus sample can be large. */
  maxCases?: number;
}

/** Default cap: enough shapes to be evidence, few enough to stay a fast test. */
export const DEFAULT_MAX_REPLAY_CASES = 40;

/** Cap on stored answer lines per case — enough to diagnose, small enough for jsonb. */
const MAX_STORED_ANSWER_LINES = 40;

// ─────────────────────────────────────────────────────────────────────────────
// The safety gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verbs whose no-side-effect forms this harness will replay.
 *
 * An allowlist rather than a denylist, because the failure directions are not
 * symmetric: a verb wrongly omitted costs a case we could have tested, a verb
 * wrongly admitted runs an unreviewed command from the corpus on a real box.
 */
const REPLAYABLE_VERBS = new Set(['sed', 'cat', 'head', 'tail', 'wc', 'grep', 'cut', 'sort', 'uniq']);

/**
 * Shell metacharacters that take a command somewhere this harness cannot vouch
 * for: chaining, substitution, redirection, backgrounding, globbing.
 *
 * `|` is included deliberately even though pipe filters are the population D-053
 * is about. A pipe means the atom's answer depends on a PRODUCER this pair does
 * not model, so replaying it would be scoring the wrong thing — the projection
 * stage (P-020) is how that class gets served, not this gate.
 */
const UNSAFE_SHELL = /[;&|`$><*]|\$\(|\|\|/;

/**
 * May this command be replayed as written?
 *
 * Fail-closed: anything not positively recognised is refused. A refusal is a
 * normal, expected outcome that costs a test case — it is never an error, and it
 * never silently becomes a pass (see {@link deriveReplayVerdict}).
 */
export function isReplaySafe(atom: string): { safe: boolean; reason?: string } {
  const trimmed = atom.trim();
  if (trimmed === '') return { safe: false, reason: 'empty command' };

  const unsafe = UNSAFE_SHELL.exec(trimmed);
  if (unsafe) {
    return {
      safe: false,
      reason:
        `contains shell metacharacter '${unsafe[0]}' — chaining, substitution, redirection and ` +
        'pipes take the answer outside what this pair models',
    };
  }

  const verb = trimmed.split(/\s+/)[0];
  if (!REPLAYABLE_VERBS.has(verb)) {
    return { safe: false, reason: `verb '${verb}' is not on the replay allowlist` };
  }

  // `tail -f` never terminates; replaying it would hang the harness rather than
  // fail it, which is the worst failure mode a test can have.
  if (/(?:^|\s)(?:-f|--follow)(?:\s|$)/.test(trimmed)) {
    return { safe: false, reason: 'follow mode (-f) does not terminate' };
  }

  return { safe: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// The normalizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse an envelope that could destroy content instead of framing.
 *
 * Two rules, both learned rather than assumed:
 *
 *  - `stripLinePrefix` must be ANCHORED (`^`). Unanchored, `replace` finds its
 *    match anywhere in the line, so a prefix pattern like `\d+\t` would delete a
 *    tab-separated field from the MIDDLE of a data line. The result still looks
 *    like a tidy answer, which is what makes it dangerous.
 *  - No stateful flags (`g`/`y`). A `lastIndex`-carrying regex reused across
 *    lines matches on some calls and not others, so the same input normalizes
 *    differently depending on what preceded it. This is the WI-5998 lesson from
 *    the registry patterns, in a second place where it bites.
 */
export function assertReplayEnvelope(envelope: AnswerEnvelope, pairId: string): void {
  const stateful = (re: RegExp, field: string) => {
    if (re.flags.includes('g') || re.flags.includes('y')) {
      throw new Error(
        `[replay] pair ${pairId} envelope.${field} carries a stateful flag ('${re.flags}'). ` +
          'A g/y regex keeps lastIndex between calls, so the same line normalizes differently ' +
          'depending on what was normalized before it.',
      );
    }
  };

  if (envelope.stripLeadingLines) stateful(envelope.stripLeadingLines, 'stripLeadingLines');
  if (envelope.stripTrailing) stateful(envelope.stripTrailing, 'stripTrailing');
  if (envelope.stripLinePrefix) {
    stateful(envelope.stripLinePrefix, 'stripLinePrefix');
    if (!envelope.stripLinePrefix.source.startsWith('^')) {
      throw new Error(
        `[replay] pair ${pairId} envelope.stripLinePrefix (/${envelope.stripLinePrefix.source}/) is not ` +
          'anchored at ^. An unanchored prefix strip deletes matching text from the middle of a line, ' +
          'which is content loss that looks like normalization.',
      );
    }
  }
}

/**
 * Reduce one side's raw output to the ANSWER: the ordered lines both sides are
 * claiming to have produced.
 *
 * The permitted operations are exactly these, and the list is closed:
 *   1. drop leading lines matching a declared pattern (the tool's header),
 *   2. drop a declared trailing block (the tool's footer),
 *   3. drop a declared ANCHORED per-line prefix (the tool's line numbers),
 *   4. drop ONE trailing empty line, on BOTH sides symmetrically.
 *
 * (4) is the only operation not declared per pair, and it is safe precisely
 * because it is symmetric: bash's stream ends with a newline and the tool's
 * joined payload does not, so without it every case would differ by one phantom
 * empty line and the harness would be unable to report anything else.
 *
 * Not permitted, and deliberately absent: sorting, deduplication, case folding,
 * whitespace collapsing, blank-line removal, trimming individual lines. Each of
 * those can turn a real difference into a match.
 */
export function normalizeAnswer(text: string, envelope?: AnswerEnvelope): string[] {
  let body = text;
  if (envelope?.stripTrailing) body = body.replace(envelope.stripTrailing, '');

  let lines = body.split('\n');

  if (envelope?.stripLeadingLines) {
    const header = envelope.stripLeadingLines;
    while (lines.length > 0 && header.test(lines[0])) lines.shift();
  }

  if (envelope?.stripLinePrefix) {
    const prefix = envelope.stripLinePrefix;
    lines = lines.map((line) => line.replace(prefix, ''));
  }

  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-case rule. Derived from the two sides' results, never asserted.
 *
 * The load-bearing clause is the first one: two failures are NOT agreement.
 * Everything else here is ordinary diffing; that clause is what stops the
 * harness reporting a clean sweep it never earned.
 */
export function deriveCaseVerdict(input: {
  bash: SideResult;
  tool: SideResult;
  bashAnswer: string[];
  toolAnswer: string[];
}): { verdict: ReplayCaseVerdict; reason?: string; firstDivergentLine?: number } {
  const { bash, tool, bashAnswer, toolAnswer } = input;

  if (!bash.ok && !tool.ok) {
    return {
      verdict: 'inconclusive',
      reason:
        `both sides failed (bash: ${bash.failure ?? 'unknown'}; tool: ${tool.failure ?? 'unknown'}) — ` +
        'a shared failure is not agreement',
    };
  }
  if (!bash.ok) {
    return { verdict: 'differs', reason: `bash failed but the tool answered (${bash.failure ?? 'unknown'})` };
  }
  if (!tool.ok) {
    return { verdict: 'differs', reason: `the tool failed but bash answered (${tool.failure ?? 'unknown'})` };
  }

  if (bashAnswer.length === 0 && toolAnswer.length === 0) {
    return {
      verdict: 'inconclusive',
      reason: 'both answers are empty — nothing was compared',
    };
  }

  const divergentAt = firstDivergence(bashAnswer, toolAnswer);
  if (divergentAt === null) return { verdict: 'match' };

  const bashLine = bashAnswer[divergentAt];
  const toolLine = toolAnswer[divergentAt];
  return {
    verdict: 'differs',
    firstDivergentLine: divergentAt + 1,
    reason:
      `line ${divergentAt + 1} of ${bashAnswer.length} (bash) vs ${toolAnswer.length} (tool): ` +
      `bash ${describeLine(bashLine)} / tool ${describeLine(toolLine)}`,
  };
}

/** Index of the first differing element, or null when the answers are identical. */
export function firstDivergence(a: string[], b: string[]): number | null {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? null : shared;
}

function describeLine(line: string | undefined): string {
  if (line === undefined) return '<no such line>';
  const clipped = line.length > 60 ? `${line.slice(0, 60)}…` : line;
  return JSON.stringify(clipped);
}

/**
 * The pair-level rule.
 *
 * `replay-clean` requires that every case RAN and every case MATCHED — refusals
 * and inconclusives block it. That is the D-008 argument applied to a second
 * question: the pattern is the unit of enforcement, so a pattern proven on the
 * half of its population that happened to be replayable is not proven. The
 * remedy is the same one D-008 prescribes — narrow the pattern until the
 * untestable residue falls outside it, or widen the harness — never lower the bar.
 */
export function deriveReplayVerdict(cases: ReplayCase[]): { verdict: ReplayVerdict; reason: string } {
  if (cases.length === 0) {
    return { verdict: 'replay-unavailable', reason: 'no cases were replayed' };
  }

  const differed = cases.filter((c) => c.verdict === 'differs');
  const inconclusive = cases.filter((c) => c.verdict === 'inconclusive');
  const refused = cases.filter((c) => c.verdict === 'refused');
  const matched = cases.filter((c) => c.verdict === 'match');

  // A difference dominates everything: it is positive evidence of a wrong answer,
  // where the other non-match outcomes are only absence of evidence.
  if (differed.length > 0) {
    return {
      verdict: 'replay-differs',
      reason: `${differed.length} of ${cases.length} case(s) returned a different answer; first: ${differed[0].reason ?? 'unknown'}`,
    };
  }

  if (refused.length === cases.length) {
    const noRewrite = refused.every((c) => c.reason?.includes('no rewrite'));
    return {
      verdict: noRewrite ? 'replay-unavailable' : 'replay-inconclusive',
      reason: noRewrite
        ? 'the pair declares no rewrite(), so no case could be executed'
        : `every case was refused; first: ${refused[0].reason ?? 'unknown'}`,
    };
  }

  if (inconclusive.length > 0 || refused.length > 0) {
    return {
      verdict: 'replay-inconclusive',
      reason:
        `${matched.length} matched, but ${inconclusive.length} inconclusive and ${refused.length} refused ` +
        'case(s) were never compared — partial coverage of a pattern is not coverage of it (D-008)',
    };
  }

  return { verdict: 'replay-clean', reason: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retargeting + the runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Point a corpus command at the fixture instead of its original operand.
 *
 * The path to replace comes from the pair's own `rewrite` (its `file_path`
 * argument), NOT from a second parser here. Re-parsing the atom to find the
 * operand would create a copy of the pair's parsing logic that can disagree with
 * it, and a retarget that picks a different token than the rewrite did would
 * quietly compare two different files.
 */
export function retargetAtom(atom: string, fromPath: string, toPath: string): string {
  if (fromPath === '') return atom;
  return atom.split(fromPath).join(toPath);
}

/** Replay one command. Exported for the mutation tests, which drive it directly. */
export async function replayCase(
  pair: SubstitutionPair,
  atom: string,
  executors: ReplayExecutors,
  options: ReplayOptions,
): Promise<ReplayCase> {
  const base: Pick<ReplayCase, 'sourceAtom' | 'replayedAtom'> = { sourceAtom: atom, replayedAtom: atom };

  if (!pair.rewrite) {
    return { ...base, verdict: 'refused', reason: 'no rewrite() declared on this pair' };
  }

  const safety = isReplaySafe(atom);
  if (!safety.safe) {
    return { ...base, verdict: 'refused', reason: `unsafe to replay: ${safety.reason}` };
  }

  const original = pair.rewrite(atom);
  if (!original) {
    return { ...base, verdict: 'refused', reason: 'rewrite() declined this atom (returned null)' };
  }

  const originalPath = typeof original.args.file_path === 'string' ? original.args.file_path : '';
  const replayedAtom = retargetAtom(atom, originalPath, options.fixturePath);

  // Re-run the rewrite on the RETARGETED command rather than patching the args:
  // the rewrite is the thing under test, so the args must be what it produces for
  // the command that is actually executed, not a hand-edited copy of them.
  const toolCall = pair.rewrite(replayedAtom);
  if (!toolCall) {
    return {
      ...base,
      replayedAtom,
      verdict: 'refused',
      reason: 'rewrite() declined the retargeted command — the fixture path changed how it parses',
    };
  }

  const [bash, tool] = await Promise.all([
    executors.runBash(replayedAtom, options.cwd),
    executors.runTool(toolCall),
  ]);

  const envelope = pair.replayEnvelope;
  if (envelope) assertReplayEnvelope(envelope, pair.id);

  // Only the TOOL side carries framing. Normalizing bash through the same envelope
  // would strip real content: a file line that happens to look like a header is
  // content, not framing.
  const bashAnswer = normalizeAnswer(bash.text);
  const toolAnswer = normalizeAnswer(tool.text, envelope);

  const derived = deriveCaseVerdict({ bash, tool, bashAnswer, toolAnswer });

  return {
    ...base,
    replayedAtom,
    toolCall,
    verdict: derived.verdict,
    reason: derived.reason,
    firstDivergentLine: derived.firstDivergentLine,
    bashAnswer: bashAnswer.slice(0, MAX_STORED_ANSWER_LINES),
    toolAnswer: toolAnswer.slice(0, MAX_STORED_ANSWER_LINES),
  };
}

/**
 * Replay every corpus command a pair claims, and derive the pair's verdict.
 *
 * Deduplicates by command SHAPE after retargeting: the corpus holds the same
 * `tail -n 50 <path>` against hundreds of different paths, and once the path is
 * the fixture they are one test, run once. Without this the cap would be spent
 * re-proving a single shape.
 */
export async function replayPair(
  pair: SubstitutionPair,
  corpus: SampledCommand[],
  executors: ReplayExecutors,
  options: ReplayOptions,
): Promise<PairReplay> {
  const max = options.maxCases ?? DEFAULT_MAX_REPLAY_CASES;
  const cases: ReplayCase[] = [];
  const seenShapes = new Set<string>();

  for (const entry of corpus) {
    if (cases.length >= max) break;

    const result = await replayCase(pair, entry.atom, executors, options);

    // Dedupe on the EXECUTED command, so distinct-path/same-shape atoms collapse.
    // Refusals are keyed by reason instead: they never reached a replayed form, and
    // collapsing them all under one key would hide a second, different refusal.
    const shape = result.verdict === 'refused' ? `refused:${result.reason}` : result.replayedAtom;
    if (seenShapes.has(shape)) continue;
    seenShapes.add(shape);

    cases.push(result);
  }

  const { verdict, reason } = deriveReplayVerdict(cases);

  return {
    pairId: pair.id,
    toolName: pair.toolName,
    verdict,
    verdictReason: reason,
    cases,
    matched: cases.filter((c) => c.verdict === 'match').length,
    differed: cases.filter((c) => c.verdict === 'differs').length,
    inconclusive: cases.filter((c) => c.verdict === 'inconclusive').length,
    refused: cases.filter((c) => c.verdict === 'refused').length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The default bash executor
// ─────────────────────────────────────────────────────────────────────────────

/** Timeout for one replayed command. Generous for a file read, short enough to fail a hang. */
const BASH_TIMEOUT_MS = 10_000;

/**
 * Run the original command, for real, in the fixture directory.
 *
 * This DOES hand a string to `bash -c`, which the projection stage (D-054) is
 * forbidden from doing — and the difference is the point rather than an
 * exception. There, a shell string would put command injection inside the layer
 * whose job is to be safer than bash. Here, executing the operator's own bash
 * verbatim IS the measurement: a replay that ran a reconstructed argv would be
 * comparing the tool against this harness's idea of the command rather than
 * against the command. The exposure is bounded instead by {@link isReplaySafe},
 * which admits nine read-only verbs and refuses every metacharacter that could
 * reach anything else.
 */
export function createBashExecutor(): ReplayExecutors['runBash'] {
  return (command, cwd) =>
    new Promise<SideResult>((resolvePromise) => {
      execFile(
        '/bin/bash',
        ['-c', command],
        { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            resolvePromise({
              ok: false,
              text: String(stdout ?? ''),
              failure: `exit ${(error as NodeJS.ErrnoException & { code?: number }).code ?? '?'}: ${String(stderr).trim() || error.message}`,
            });
            return;
          }
          resolvePromise({ ok: true, text: String(stdout) });
        },
      );
    });
}
