/**
 * Per-turn journal (deterministic-context-carry-2026-07-14 P-012, plan D-003).
 *
 * One 1–3-sentence note per completed agent TURN, written by the ACTING agent
 * (never a separate reader-LLM): the agent ends its final message with a line
 *
 *   ⟦journal⟧ <what landed / where I am / what's next>
 *
 * and the collection layer extracts it at turn end. Collection is
 * client-neutral (predecessor agent-managed-compaction D-002 control tiers):
 * the Claude/Codex cc/ Stop hook and the OMP in-process turn_end port each
 * ping `journal:record-turn` with the session id + transcript path, and the
 * SERVER does the identical extraction here — one extractor, thin pings.
 * When the agent wrote no marker line the MECHANICAL FALLBACK is the first
 * line of the last assistant message, flagged so the reader knows nobody
 * wrote it on purpose.
 *
 * The note is a CLAIM; the tool ledger (harness_shared.agent_activity) is
 * TRUTH. `detectClaimLedgerMismatch` is the minimal P-012 tripwire for the
 * canonical dishonesty shape — the note says "tests pass" while the same
 * turn's ledger recorded a failure ("note says pass, ledger says exit 1").
 * Journals are never graded (ambient-semantic-push D-008 anti-Goodhart);
 * the diff audits honesty instead. P-029 broadens the diff.
 */
import { open, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { FILE_ADAPTERS, jsonlAtDepth, type ParsedTurn } from './search/session-ingest';

export const JOURNAL_MARKER = '⟦journal⟧';
/** An agent-authored note is bounded so a runaway "journal" can't become a
 *  context payload — 1–3 sentences, not a report. */
export const JOURNAL_NOTE_MAX_CHARS = 600;
export const MECHANICAL_NOTE_MAX_CHARS = 300;

export interface ExtractedJournal {
  note: string;
  /** 'agent' = a ⟦journal⟧ line the acting agent wrote; 'mechanical' = the
   *  first-line fallback (always flagged). */
  source: 'agent' | 'mechanical';
  flagged: boolean;
}

/** Extract the journal note from a turn's FINAL assistant message text. */
export function extractJournalFromAssistantText(text: string): ExtractedJournal | null {
  const lines = text.split('\n');
  // The LAST marker line wins (an agent quoting the convention earlier in the
  // message must not shadow its actual trailing journal line).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith(JOURNAL_MARKER)) continue;
    const note = trimmed.slice(JOURNAL_MARKER.length).trim().slice(0, JOURNAL_NOTE_MAX_CHARS);
    if (note) return { note, source: 'agent', flagged: false };
  }
  for (const line of lines) {
    // Strip markdown heading/bullet/quote lead-ins so the fallback reads as a
    // sentence, not markup.
    const cleaned = line.trim().replace(/^(?:#{1,6}|[-*>]|\d+\.)\s+/, '').trim();
    if (!cleaned) continue;
    return { note: cleaned.slice(0, MECHANICAL_NOTE_MAX_CHARS), source: 'mechanical', flagged: true };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Claim-vs-ledger tripwire                                            */
/* ------------------------------------------------------------------ */

/** The slice of an agent_activity row the tripwire reads. */
export interface LedgerEntry {
  toolName?: string | null;
  status?: string | null;
  summary?: string | null;
}

export interface JournalTripwire {
  kind: 'claim-ledger-mismatch';
  /** The success claim matched in the note. */
  claim: string;
  /** The ledger rows contradicting it (capped). */
  evidence: Array<{ toolName: string | null; status: string | null; summary: string | null }>;
}

/** "tests pass" / "build green" / "typecheck clean" shaped claims. */
const SUCCESS_CLAIM_RE =
  /\b(?:all\s+)?(?:\d+\s+)?(?:tests?|suites?|builds?|lints?|typechecks?|checks?|gates?|ci)\b[^.!?\n]{0,60}?\b(?:pass(?:ed|ing|es)?|green|succeed(?:ed|s|ing)?|clean|ok)\b/i;
/** Reversed phrasing: "passing tests", "green build". */
const SUCCESS_CLAIM_REV_RE = /\b(?:passing|green)\s+(?:tests?|builds?|suites?|ci)\b/i;
/** A note that ALSO discloses failure is honest — never tripwire disclosure. */
const HONEST_FAILURE_RE =
  /\b(?:fail(?:s|ed|ing|ure)?|red|broken|flaky|regress(?:ed|ion)?|error(?:s|ed)?|exit\s*(?:code\s*)?[1-9])\b/i;
/** Ledger-side failure text when `status` wasn't stamped: a non-zero exit or
 *  an explicit test failure. Deliberately narrow — `status === 'error'` is the
 *  primary signal; this regex only catches the canonical Bash shapes. */
const LEDGER_FAILURE_TEXT_RE =
  /\bexit(?:ed)?\s*(?:code[:\s]*)?[1-9]\d*\b|\bFAILED\b|\btests?\s+fail(?:ed|ing|s)?\b/i;

/** Tools whose ledger outcome can ATTEST a tests/build claim — command
 *  executions. A Read/Edit succeeding says nothing about the test suite. */
const EXECUTION_TOOL_RE = /^(bash|shell|exec|run|local_shell|capability:bash)/i;

function isExecutionEntry(e: LedgerEntry): boolean {
  if (e.toolName && EXECUTION_TOOL_RE.test(e.toolName)) return true;
  // The activity hooks summarize commands as "$ <cmd>".
  return typeof e.summary === 'string' && e.summary.trimStart().startsWith('$');
}

function isFailureEntry(e: LedgerEntry): boolean {
  return (
    e.status === 'error' ||
    (typeof e.summary === 'string' && LEDGER_FAILURE_TEXT_RE.test(e.summary))
  );
}

/**
 * The minimal P-012 honesty diff: a success claim in the note vs the turn's
 * tool ledger (`ledger` NEWEST FIRST — the store's DESC order). The verdict
 * follows the MOST RECENT command execution: a turn that iterated
 * fail → fix → re-run-green ends on an ok run and stays clean; a turn that
 * ends on a failing run while the note claims success trips. Returns null
 * when the note makes no success claim, when it honestly discloses failure
 * alongside, or when the window holds no contradicting execution.
 */
export function detectClaimLedgerMismatch(
  note: string,
  ledger: LedgerEntry[],
): JournalTripwire | null {
  const claim = note.match(SUCCESS_CLAIM_RE) ?? note.match(SUCCESS_CLAIM_REV_RE);
  if (!claim) return null;
  if (HONEST_FAILURE_RE.test(note)) return null;
  const latest = ledger.find((e) => isExecutionEntry(e) && (e.status === 'ok' || isFailureEntry(e)));
  if (!latest || !isFailureEntry(latest)) return null;
  const evidence = ledger
    .filter((e) => isExecutionEntry(e) && isFailureEntry(e))
    .slice(0, 3)
    .map((e) => ({
      toolName: e.toolName ?? null,
      status: e.status ?? null,
      summary: e.summary ? e.summary.slice(0, 300) : null,
    }));
  return { kind: 'claim-ledger-mismatch', claim: claim[0].slice(0, 200), evidence };
}

/* ------------------------------------------------------------------ */
/* Transcript access (bounded tail read via the ingest adapters)       */
/* ------------------------------------------------------------------ */

/** How much file tail the last-assistant-message scan reads. Claude lines can
 *  be huge (tool results), but the final TEXT line of a turn sits at the very
 *  end of the JSONL — 256 KB of tail is orders of magnitude of headroom. */
const TAIL_READ_BYTES = 256 * 1024;

export type JournalSourceKind = 'claude' | 'omp' | 'codex';

/** Read the LAST assistant text turn from a transcript file (bounded tail
 *  read; parses with the same adapter session-ingest indexes with). */
export async function readLastAssistantTurn(
  filePath: string,
  sourceKind: JournalSourceKind,
): Promise<ParsedTurn | null> {
  const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind);
  if (!adapter) return null;
  const st = await stat(filePath);
  const start = Math.max(0, st.size - TAIL_READ_BYTES);
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    // A mid-file start lands mid-line — the first fragment is unparseable.
    if (start > 0) lines = lines.slice(1);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      const turn = adapter.parseLine(line);
      if (turn?.speaker === 'assistant') return turn;
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Root spec shape shared with session-ingest (structural — RootSpec is not
 *  exported from there). */
export interface JournalRootSpec {
  root: string;
  dirDepth: number;
  descend?: (dirName: string, level: number) => boolean;
}

/**
 * Resolve the transcript file for a session, refusing paths outside the known
 * transcript roots (the tool is reachable over MCP — it must never become an
 * arbitrary-file reader). A caller-supplied `candidatePath` is realpath'd and
 * prefix-checked against the adapter roots; without one, the roots are walked
 * (bounded, fixed-shape — same discipline as the ingest sweep) for a filename
 * carrying the session id.
 */
export async function resolveTranscriptPath(
  sourceKind: JournalSourceKind,
  sessionId: string,
  candidatePath?: string,
  rootsOverride?: JournalRootSpec[],
): Promise<string | null> {
  const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === sourceKind);
  if (!adapter) return null;
  const roots: JournalRootSpec[] = rootsOverride ?? adapter.roots();

  const realRoots: string[] = [];
  for (const spec of roots) {
    try {
      realRoots.push(await realpath(spec.root));
    } catch {
      // absent root (this box never ran that client) — skip
    }
  }

  if (candidatePath) {
    try {
      const real = await realpath(candidatePath);
      if (realRoots.some((r) => real.startsWith(r + '/'))) return real;
    } catch {
      // missing/unreadable — fall through to the walk
    }
  }

  if (!sessionId) return null;
  for (const spec of roots) {
    const files = await jsonlAtDepth(spec.root, spec.dirDepth, spec.descend);
    // Every adapter's filename carries the session id (claude: <sid>.jsonl;
    // omp: <ts>_<sid>.jsonl; codex: rollout-<ts>-<sid>.jsonl).
    const named = files.filter((f) => basename(f).includes(sessionId));
    for (const f of named) {
      if (adapter.meta(f).sessionId === sessionId) return f;
    }
  }
  return null;
}
