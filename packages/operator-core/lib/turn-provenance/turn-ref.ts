/**
 * turn-ref.ts — durable, verifiable references to specific turns
 * (deterministic-context-carry-2026-07-14 P-014).
 *
 * The live turn-provenance ledger (./turn-provenance.ts) is short-TTL by design
 * — it answers "was THIS prompt just injected?" at prompt-submit. A directive
 * carried on a carry surface ("the owner said X") outlives that window, so it
 * needs a DURABLE anchor: a turn ref
 *
 *   [turn:<session-prefix>@<iso-ts>]
 *
 * naming the recorded transcript turn the directive came from. Verification is
 * then mechanical: load the turn from the writer's own transcript and classify
 * it owner-vs-agent from what was RECORDED — the ⟦turn-origin:…⟧ envelope every
 * enrolled injector prefixes survives verbatim in the transcript, so an
 * injected turn is identifiable forever, while a clean turn with no envelope
 * and no machine banner is the affirmative owner shape (same D-002 default as
 * the live classifier). Manual [owner:…] tags are RETIRED as evidence: they
 * assert, a turn ref PROVES. The carry-surface stamper
 * (../carry-surface-provenance-stamp.ts) drives this on every write.
 */

import { open } from 'node:fs/promises';
import { resolveSelfSession } from '../search/self-session';
import { parseEnvelope } from './turn-provenance';

/* ------------------------------------------------------------------ */
/* Ref format                                                          */
/* ------------------------------------------------------------------ */

/** How much of the native session id a ref carries — enough to disambiguate
 *  the sessions one owner realistically touches, short enough to hand-copy. */
const SESSION_PREFIX_CHARS = 8;

export interface TurnRef {
  /** First SESSION_PREFIX_CHARS of the native session id. */
  sessionPrefix: string;
  /** The recorded turn's ISO timestamp (exact, or truncated to seconds). */
  ts: string;
  /** The literal matched text (for echoing back in verdicts). */
  raw: string;
}

export function formatTurnRef(sessionId: string, tsIso: string): string {
  return `[turn:${sessionId.slice(0, SESSION_PREFIX_CHARS)}@${tsIso}]`;
}

/** Global by design — a carry note can cite several turns. */
const TURN_REF_RE = /\[turn:([0-9a-f]{4,36})@([0-9T:.+Z-]{10,40})\]/gi;

export function parseTurnRefs(text: string | null | undefined): TurnRef[] {
  if (!text) return [];
  const out: TurnRef[] = [];
  for (const m of text.matchAll(TURN_REF_RE)) {
    out.push({ sessionPrefix: m[1].toLowerCase(), ts: m[2], raw: m[0] });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Recorded-turn classification (owner-vs-agent from the transcript)   */
/* ------------------------------------------------------------------ */

export type RecordedTurnVerdict =
  | 'owner-typed'
  | 'agent-injected'
  | 'machine-surface'
  | 'synthetic';

export interface RecordedTurnClass {
  verdict: RecordedTurnVerdict;
  /** The envelope's origin when agent-injected (e.g. 'wake-pump'). */
  origin: string | null;
}

/** Harness-synthetic user entries that are NOT owner words. Superset of the
 *  relay-provenance list — keep additions here so both consumers share them. */
const SYNTHETIC_MARKERS = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
];

/** CLI-internal machine surfaces (same shapes as the live classifier +
 *  the native auto-compaction continuation, which is unenrollable). */
const MACHINE_SURFACE_RE = /\[\s*SYSTEM NOTIFICATION\b[^\]]*\bNOT USER INPUT\b[^\]]*\]/i;
const COMPACTION_CONTINUATION_RE =
  /^\s*This session is being continued from a previous conversation/;

/**
 * Classify a RECORDED user turn's text owner-vs-agent. Mirrors the live
 * classifier's decision shape (turn-provenance.ts `classify`) but works on
 * what the transcript kept: the envelope text (durable) instead of the
 * short-TTL nonce ledger. An envelope at turn start is decisive — every
 * enrolled injector writes it, and the owner never types one.
 */
export function classifyRecordedTurn(text: string): RecordedTurnClass {
  const env = parseEnvelope(text);
  if (env) return { verdict: 'agent-injected', origin: env.origin };
  const head = text.slice(0, 200);
  if (SYNTHETIC_MARKERS.some((m) => head.includes(m))) {
    return { verdict: 'synthetic', origin: null };
  }
  if (MACHINE_SURFACE_RE.test(text) || COMPACTION_CONTINUATION_RE.test(text)) {
    return { verdict: 'machine-surface', origin: null };
  }
  return { verdict: 'owner-typed', origin: null };
}

/* ------------------------------------------------------------------ */
/* Transcript reads                                                    */
/* ------------------------------------------------------------------ */

/** A user turn parsed from a Claude-shaped session JSONL. */
export interface RecordedUserTurn {
  ts: string;
  text: string;
}

/** Ref verification scans this much transcript tail (refs usually point at
 *  recent turns; older ones fall back to sessions:search by hand). */
const SCAN_BYTES = 4 * 1024 * 1024;
/** The current-turn stamp only needs the very tail. */
const TAIL_BYTES = 512 * 1024;

async function readTail(filePath: string, bytes: number): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Parse ALL user turns (with timestamps) out of raw JSONL — including
 *  machine-injected ones; classification happens per turn, not by dropping. */
export function parseUserTurns(jsonl: string): RecordedUserTurn[] {
  const out: RecordedUserTurn[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn first line of a tail read
    }
    if (o.type !== 'user' || o.isMeta === true) continue;
    const m = (o.message ?? {}) as Record<string, unknown>;
    const c = m.content;
    let text: string;
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      const texts = c
        .filter(
          (b): b is { type: string; text: string } =>
            !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
        )
        .map((b) => b.text);
      if (!texts.length) continue; // tool_result-only plumbing
      text = texts.join('\n');
    } else {
      continue;
    }
    if (!text.trim()) continue;
    out.push({ ts: typeof o.timestamp === 'string' ? o.timestamp : '', text });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Verification + the current-turn stamp                               */
/* ------------------------------------------------------------------ */

export interface TurnRefVerdict {
  ref: string;
  found: boolean;
  /** Classification of the referenced turn when found. */
  verdict: RecordedTurnVerdict | null;
  origin: string | null;
  /** Head of the referenced turn's text (so the reader sees WHAT was said). */
  snippet: string | null;
}

export interface VerifyTurnRefsOptions {
  /** Explicit transcript (tests / non-self sessions); else resolved from ownerId. */
  filePath?: string;
  sessionId?: string;
  scanBytes?: number;
}

const SNIPPET_CHARS = 160;

/** Second-resolution prefix match: an exact ts match, or either side is a
 *  prefix of the other down to seconds (refs may carry truncated timestamps). */
function tsMatches(refTs: string, turnTs: string): boolean {
  if (!refTs || !turnTs) return false;
  return refTs === turnTs || turnTs.startsWith(refTs) || refTs.startsWith(turnTs.slice(0, 19));
}

/**
 * Verify each ref against the caller's own transcript. Fail-soft: an
 * unresolvable transcript returns every ref as found:false (never throws) —
 * the stamp degrades to "unverifiable", it does not block the write.
 */
export async function verifyTurnRefs(
  ownerId: string,
  refs: TurnRef[],
  opts: VerifyTurnRefsOptions = {},
): Promise<TurnRefVerdict[]> {
  if (refs.length === 0) return [];
  const miss = (r: TurnRef): TurnRefVerdict => ({
    ref: r.raw,
    found: false,
    verdict: null,
    origin: null,
    snippet: null,
  });
  let filePath = opts.filePath;
  let sessionId = opts.sessionId;
  if (!filePath) {
    const self = await resolveSelfSession(ownerId).catch(() => null);
    if (!self) return refs.map(miss);
    filePath = self.filePath;
    sessionId = sessionId ?? self.sessionId;
  }
  let turns: RecordedUserTurn[];
  try {
    turns = parseUserTurns(await readTail(filePath, opts.scanBytes ?? SCAN_BYTES));
  } catch {
    return refs.map(miss);
  }
  const sidLower = (sessionId ?? '').toLowerCase();
  return refs.map((r) => {
    // A ref into a DIFFERENT session is out of reach here — report unverified
    // rather than matching a same-timestamp turn from the wrong session.
    if (sidLower && !sidLower.startsWith(r.sessionPrefix)) return miss(r);
    const turn = turns.find((t) => tsMatches(r.ts, t.ts));
    if (!turn) return miss(r);
    const cls = classifyRecordedTurn(turn.text);
    return {
      ref: r.raw,
      found: true,
      verdict: cls.verdict,
      origin: cls.origin,
      snippet: turn.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
    };
  });
}

export interface CurrentTurnStamp {
  /** A ready-to-copy ref to the current (latest recorded) user turn. */
  ref: string;
  verdict: RecordedTurnVerdict;
  origin: string | null;
}

/**
 * The system-side origin stamp for "the turn this write happened in": the
 * latest recorded user turn of the caller's own transcript, classified. This
 * is what replaces trusting a hand-written [owner:…] tag — the WRITE records
 * what kind of turn drove it. Fail-soft: null when the transcript is
 * unreachable (the write proceeds unstamped).
 */
export async function resolveCurrentTurnStamp(ownerId: string): Promise<CurrentTurnStamp | null> {
  const self = await resolveSelfSession(ownerId).catch(() => null);
  if (!self) return null;
  let turns: RecordedUserTurn[];
  try {
    turns = parseUserTurns(await readTail(self.filePath, TAIL_BYTES));
  } catch {
    return null;
  }
  // Latest turn that is a real prompt (skip synthetic plumbing so a local
  // command echo doesn't mask the actual driving turn).
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const cls = classifyRecordedTurn(turns[i].text);
    if (cls.verdict === 'synthetic') continue;
    return {
      ref: formatTurnRef(self.sessionId, turns[i].ts),
      verdict: cls.verdict,
      origin: cls.origin,
    };
  }
  return null;
}
