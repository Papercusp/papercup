/**
 * cell-transcription-detector.ts — P-017 (c) of unified-agent-state-plane-2026-07-27.
 *
 * "This value has a cell — read it."
 *
 * D-016 records three behaviours as UNCOVERED, one of them: *read a cell instead of
 * transcribing a value*, whose available tier is "DETECTOR + make the right path the
 * lazy path". D-047 row 4 assigns it tier 1+3: orient FOLDS the cell (so reading is
 * cheaper than transcribing), and this detector catches what still slips through.
 *
 * It is a DETECTOR, never a gate. It never refuses a call, never mutates a payload,
 * and never fails a send — it appends an advisory. A gate here would be wrong: the
 * agent may have an entirely legitimate reason to quote a sha (a postmortem, a
 * historical citation), and refusing those would make the tool unusable.
 *
 * ── PRECISION IS THE WHOLE DESIGN, NOT A TUNING KNOB ────────────────────────
 *
 * The repo already paid for this lesson (EI-10949, work_items/complete.ts): a
 * duplicate-detection nudge keyed on the bare phrase /dup(licate)? of/ fired on a
 * completion describing a duplicated TYPE INTERFACE. The conclusion recorded there
 * is the one that governs this file:
 *
 *   "A false positive here is not free … this warning shares a channel with real
 *    ones, and a heuristic that misfires on ordinary prose teaches agents to skim
 *    past the channel entirely — including the time it is right."
 *
 * A bare `[0-9a-f]{7,40}` over agent prose would fire on hashes, ids, hex colours,
 * and half the nouns in a stack trace. So a hit REQUIRES TWO things:
 *
 *   1. a VALUE that matches a cell-backed shape, and
 *   2. a STATE-CLAIM CONTEXT within a small window of it.
 *
 * "see commit abc1234 for the rationale" is a citation — no hit. ":3070 is serving
 * abc1234" is a transcribed cell value — hit. The second is the failure this exists
 * to catch: a value that was TRUE when copied and silently rots in the message.
 *
 * ── WHY THE PATTERN TABLE LIVES HERE AND NOT ON CellSpec ───────────────────
 *
 * The obvious alternative is a `valuePatterns` field on CellSpec so a cell declares
 * its own detectable shapes. Deliberately not done: D-038's contract is ratified at
 * six axes (plus P-019's visibility/federation), and widening it for one detector's
 * convenience would make every future cell author answer a question that has nothing
 * to do with whether their cell is well-formed.
 *
 * The cost is real and is named rather than hidden: **a newly registered cell is NOT
 * automatically detected** — it must be added here. The guard against silent drift is
 * the other direction, which is the one that actually rots: `cell-transcription-detector.test.ts`
 * asserts every `cell` named below IS registered, so a pattern pointing at a cell that
 * was renamed or never shipped fails the suite instead of silently never matching.
 */

/** One detectable transcription: a value shape plus the context that makes it a CLAIM. */
interface TranscriptionPattern {
  /** The registered cell that answers this authoritatively. */
  cell: string;
  /** The field of that cell the value corresponds to. */
  field: string;
  /** Human phrase for the advisory. */
  what: string;
  /** The value shape. MUST be global (`g`) — callers rely on lastIndex scanning. */
  value: RegExp;
  /** Required state-claim context within CONTEXT_WINDOW chars of the value. */
  context: RegExp;
}

/**
 * How far either side of a matched value we look for a state-claim context word.
 * Deliberately tight: a sha and the word "deployed" 400 chars apart are usually two
 * unrelated sentences, and widening this trades precision for recall in exactly the
 * direction EI-10949 warns against.
 */
export const CONTEXT_WINDOW = 60;

/**
 * A source checkout's HEAD is not a pipeline position. Keep this anchored to the
 * value's left edge so an unrelated word such as "release" later in the same
 * sentence cannot turn a source citation into a deployment claim.
 */
const SOURCE_HEAD_VALUE_PREFIX =
  /\b(?:current|local|source|working(?:\s+tree)?)\s+(?:git\s+)?head(?:\s+(?:sha|commit))?\s*(?:is|=|:)?\s*$/i;

/**
 * If a source HEAD value is explicitly described as deployed/serving/live, it is
 * still a real pipeline claim and must remain detectable. A bare source HEAD next
 * to separate pipeline prose is only a citation and should stay quiet.
 */
const EXPLICIT_PIPELINE_STATE_AFTER_SOURCE_HEAD =
  /^\s*(?:is|was|now|currently)\s+(?:(?:(?:the|a)\s+)?(?:deploy(?:ed|ing|ment)?|serving|serves|live|release[d]?|candidate|gate|green[- ]?checkpoint|staging|main|running|shipped)\b|at\s+:(?:3070|3170)\b)/i;

function isUnlinkedSourceHeadCitation(haystack: string, valueStart: number, valueLength: number): boolean {
  const before = haystack.slice(Math.max(0, valueStart - CONTEXT_WINDOW), valueStart);
  if (!SOURCE_HEAD_VALUE_PREFIX.test(before)) return false;

  const afterStart = valueStart + valueLength;
  const after = haystack.slice(afterStart, Math.min(haystack.length, afterStart + CONTEXT_WINDOW));
  return !EXPLICIT_PIPELINE_STATE_AFTER_SOURCE_HEAD.test(after);
}

/**
 * ⚠ Every `cell` here must be REGISTERED — asserted by the test suite.
 *
 * Both patterns currently point at `git.pipelinePosition`, which genuinely answers
 * both: its shape is
 * `{ positions, positionsUnknown[], stages[], serving, changeInCandidate, gitSync, sweepExposure, summary }`.
 * P-007 splits out finer-grained cells (`git.mainBehindStaging`, `deploy.3070.sha`);
 * when those register, re-point these `cell`/`field` values at them — the advisory
 * text is generated from these fields, so it follows automatically.
 */
const PATTERNS: readonly TranscriptionPattern[] = [
  {
    cell: 'git.pipelinePosition',
    field: 'positions.deployed / serving.startedSinceCodeChange',
    what: 'a commit sha stated as the deployed/serving/gate position',
    // 7-40 hex, REQUIRING at least one a-f letter: a pure-digit run like "1234567" is
    // a number far more often than a sha, and admitting it is a large false-positive
    // surface for no recall worth having.
    //
    // ⚠ The lookaround is load-bearing, and a plain `\b` is NOT enough — this was a
    // real false positive caught by the suite, not a hypothetical. `\b` treats `-` as a
    // boundary, so every AGENT ID matched: `su-8d9a671c-ccda-4aa9-b4f4-8f0d1c7a4804`
    // offers `8d9a671c` and `8f0d1c7a4804` as "shas", and ids travel in coord messages
    // beside words like "live" constantly — it would have fired on a large share of
    // real traffic, which is exactly the EI-10949 channel-poisoning failure.
    //
    // So the run must not ABUT an alphanumeric, a hyphen, or a '#': that excludes uuid
    // segments (both interior and leading, via the trailing lookahead), hyphenated
    // identifiers, and hex colours, while leaving a standalone sha untouched.
    value: /(?<![0-9A-Za-z#-])(?=[0-9a-f]{7,40}(?![0-9A-Za-z-]))[0-9a-f]*[a-f][0-9a-f]*(?![0-9A-Za-z-])/gi,
    context:
      /\b(deploy(ed|ing|ment)?|serving|serves|live|release[d]?|candidate|gate|green[- ]?checkpoint|staging|main|:3070|:3170|running|shipped)\b/i,
  },
  {
    cell: 'git.pipelinePosition',
    field: 'positions / gitSync',
    what: 'a branch behind/ahead count stated as current pipeline state',
    value: /\b\d{1,4}\s+commits?\b|\bbehind\s+by\s+\d{1,4}\b/gi,
    context: /\b(behind|ahead|main|staging|origin|unpushed|not\s+pushed|sync)\b/i,
  },
] as const;

export interface CellTranscription {
  /** The registered cell that answers this authoritatively. */
  cell: string;
  /** The field of that cell. */
  field: string;
  /** The exact text matched. */
  value: string;
  /** What kind of transcription this is, for the advisory. */
  what: string;
}

/** Case/whitespace-insensitive key so the same sha claimed twice reports once. */
function dedupeKey(hit: CellTranscription): string {
  return `${hit.cell}::${hit.value.toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * PURE. Find values in `text` that a registered cell answers authoritatively.
 *
 * Returns [] for anything unparseable, empty, or oversized — a detector that throws
 * inside a `coord:send` would turn an advisory into an outage, which is the one
 * failure mode a tier-3 mechanism must never have.
 */
export function detectCellTranscriptions(text: unknown): CellTranscription[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Bound the work: a 100KB message body is not worth a full scan, and the scan is
  // on the hot path of every send.
  const haystack = text.length > 20_000 ? text.slice(0, 20_000) : text;

  const out: CellTranscription[] = [];
  const seen = new Set<string>();

  for (const p of PATTERNS) {
    // Fresh regex per scan: a module-level /g regex carries lastIndex between calls,
    // so sharing one across invocations makes results depend on call ORDER — a
    // genuinely nasty intermittent this avoids by construction.
    const re = new RegExp(p.value.source, p.value.flags.includes('g') ? p.value.flags : `${p.value.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
      // Zero-length match guard — without this a pattern that can match empty spins forever.
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const start = Math.max(0, m.index - CONTEXT_WINDOW);
      const end = Math.min(haystack.length, m.index + m[0].length + CONTEXT_WINDOW);
      const window = haystack.slice(start, end);
      if (!p.context.test(window)) continue; // a citation, not a claim

      // A broad context window is intentional for ordinary pipeline prose, but it
      // must not connect a source `current HEAD <sha>` to a separate nearby
      // "release"/"staging" sentence. Only an explicit state phrase attached to
      // that HEAD value keeps it classified as a deployment claim.
      if (
        p.field === 'positions.deployed / serving.startedSinceCodeChange' &&
        isUnlinkedSourceHeadCitation(haystack, m.index, m[0].length)
      ) {
        continue;
      }

      const hit: CellTranscription = { cell: p.cell, field: p.field, value: m[0], what: p.what };
      const key = dedupeKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

/**
 * Render the advisory. Names the CELL and the tool that reads it, because "this value
 * has a cell" is useless without the call that replaces the transcription — the same
 * reason D-016 prefers making the right path the lazy path over exhorting people onto it.
 */
export function formatCellTranscriptionHint(hits: CellTranscription[]): string | null {
  if (hits.length === 0) return null;
  const listed = hits
    .slice(0, 3)
    .map((h) => `"${h.value}" (${h.what} — cell \`${h.cell}\`, field ${h.field})`)
    .join('; ');
  const more = hits.length > 3 ? ` …and ${hits.length - 3} more` : '';
  return (
    `this text states ${hits.length} value(s) that a registered CELL answers authoritatively: ${listed}${more}. ` +
    'A transcribed value was true when you copied it and rots silently afterwards — the reader cannot tell a ' +
    'stale one from a fresh one. Prefer naming the cell so the reader resolves it live (state:read / the orient ' +
    'fold). If you are deliberately quoting HISTORICAL state, say so in the text — this is an advisory, nothing ' +
    'was blocked or changed.'
  );
}

/** Convenience: detect + format in one call. Returns null when there is nothing to say. */
export function cellTranscriptionHint(text: unknown): string | null {
  return formatCellTranscriptionHint(detectCellTranscriptions(text));
}
