/**
 * compaction-usage.ts — best-effort per-session context-size estimator.
 * agent-managed-compaction-2026-07-01 (P-007 / P-009).
 *
 * Resolves a session's transcript from its coord ownerId (via adv_sessions) and
 * estimates current context tokens as transcript-bytes/4 — a cheap, monotonic
 * "how full am I" gauge (fs.stat only, no content read). Runs OFF the per-turn hot
 * path: the compaction-compliance watchdog calls it on a cadence and caches the
 * result on coord_presence.context_tokens; the inbox usage signal reads that cached
 * value. Degrades to null (never throws) when a transcript can't be resolved.
 *
 * v1 targets Claude (interactive AND spawned — adv_sessions maps both). OMP
 * self-compacts natively and Codex has no compaction, so both return null for now
 * (a follow-up can add OMP via OmpSessionUsage).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findSessionTranscript, papercuspSessionClaudeBase, newestTranscriptUnderOwner } from './claude-sessions';

// P-016 fallback resolver — RELOCATED to claude-sessions.ts (2026-07-04, WI-2680) so
// the agents-roster live-thinking pane + stream share the SAME resume-rotation
// robustness. Re-exported here so existing importers (+ compaction-usage.test.ts) are
// unaffected; the estimate fallback below (estimateContextTokensForOwner) still calls it.
export { newestTranscriptUnderOwner };

export interface SessionRef {
  /** Backend: 'claude' | 'omp' | 'codex' | null (unknown → treated as claude). */
  agent: string | null;
  /** The backend session id (Claude UUID / OMP thread / codex rollout). */
  sessionId: string | null;
}

/** The raw JSONL key Claude writes on a compaction-summary entry. Text that
 *  merely MENTIONS the key inside a string is escaped (\"isCompactSummary\"),
 *  so matching the raw byte form is unambiguous (EI-6410). */
const COMPACT_BOUNDARY_MARKER = '"isCompactSummary":true';
/** Bound the backward boundary scan. Not-found within the cap ⇒ ≥cap bytes
 *  since any compaction ⇒ the estimate is over every real limit anyway. */
const BOUNDARY_SCAN_CAP = 8 * 1024 * 1024;
/** Files below this skip the scan entirely: at bytes/4 a stat-only file caps at
 *  ~64k tokens, below every force threshold (the smallest is ~190k on a 200k
 *  window), so the fast path can never false-force. Was 1MB — a sub-1MB
 *  screenshot-carrying transcript could stat-read ~250k and trip a 200k-window
 *  force (WI-3176). */
const BOUNDARY_SCAN_MIN = 256 * 1024;

/** WI-3176 image discount: a screenshot in the transcript JSONL is 100–1000× its
 *  real context cost — a 1920×1080 PNG is ~1.3MB of base64 (→ ~325k "tokens" at
 *  bytes/4) but bills the model ≤~1600 tokens (vision pricing caps at the
 *  downscale bound), AND Claude Code writes the payload TWICE per read (the
 *  content block's `"data":"…"` + the toolUseResult's `"base64":"…"`, the latter
 *  never entering context at all). A screenshot-heavy E2E session read ~1948k on
 *  a real ~300k context and got force-compacted on it. Count each key-anchored
 *  long base64 run as one image at the cap instead. Anchoring on the two JSON
 *  keys (not bare runs) keeps ordinary long alphanumeric content — hex dumps,
 *  minified code — counted at full weight. */
const IMAGE_PAYLOAD_RE = /"(?:data|base64)":"[A-Za-z0-9+/=]{8192,}"/g;
/** Claude's per-image billing cap (≥1568px images are downscaled to ~1600 tok). */
const IMAGE_TOKEN_COST = 1600;

/**
 * tokens ≈ (bytes SINCE THE LAST COMPACTION − base64-image excess) / 4.
 * EI-6410: the transcript JSONL accumulates across compactions, so whole-file/4
 * is monotonic and reads a compacted session at 150–250%+ of its limit forever —
 * false over-limit warnings and compact-loops. WI-3176: base64 image payloads
 * are counted at their real ~1600-token cost, not byte-weight. Small files stay
 * stat-only; larger ones scan a bounded tail for the last compaction-summary
 * entry and count from there.
 */
export function tokensFromFileSize(pathStr: string): number | null {
  try {
    const size = fs.statSync(pathStr).size;
    if (size < BOUNDARY_SCAN_MIN) return Math.floor(size / 4);
    const start = Math.max(0, size - BOUNDARY_SCAN_CAP);
    const fd = fs.openSync(pathStr, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const idx = buf.lastIndexOf(COMPACT_BOUNDARY_MARKER);
      const sinceBytes = idx === -1 ? size : buf.length - idx;
      // Discount image payloads visible in the since-compaction region. latin1
      // keeps string length == byte length (base64 is ASCII; surrounding
      // multibyte content must not skew the byte math). When the marker fell
      // outside the scan cap, only the buffered tail is discountable — the
      // unseen head keeps full weight (estimate stays conservative).
      const visible = buf.toString('latin1', idx === -1 ? 0 : idx);
      let imageExcess = 0;
      for (const m of visible.matchAll(IMAGE_PAYLOAD_RE)) {
        imageExcess += m[0].length - IMAGE_TOKEN_COST * 4;
      }
      return Math.max(0, Math.floor((sinceBytes - imageExcess) / 4));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Estimate a session's current context tokens from a resolved SessionRef.
 * Claude (+ unknown) → transcript bytes/4; OMP/Codex → null in v1.
 */
export async function estimateContextTokens(ref: SessionRef, owner?: string | null): Promise<number | null> {
  if (!ref.sessionId) return null;
  if (ref.agent === 'omp' || ref.agent === 'codex') return null;
  try {
    // Pass the coord `owner` hint: an interactive/spawned session's transcript lives under
    // ~/.papercusp/session-claude/<owner>/projects, so the hint takes findSessionTranscript's
    // FAST PATH (one owner-root readdir) instead of the full 12k-owner-dir sweep. Without it,
    // the compaction watchdog polling many owners on a cadence re-swept every isolation root
    // per call — the fs-churn that bloated the background host to tens of GB.
    const p = await findSessionTranscript(ref.sessionId, { owner: owner ?? null });
    return p ? tokensFromFileSize(p) : null;
  } catch {
    return null;
  }
}

/** Resolve a session's {agent, sessionId} from its coord ownerId via adv_sessions. */
export async function resolveSessionRef(ownerId: string): Promise<SessionRef | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ agent: string | null; session_id: string | null }[]>`
      SELECT agent, session_id
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND session_id IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1
    `;
    if (!rows.length) return null;
    return { agent: rows[0].agent, sessionId: rows[0].session_id };
  } catch {
    return null;
  }
}

/**
 * Best-effort context-token estimate for a session by its coord ownerId.
 *
 * Primary: resolve the recorded session_id → its `<sessionId>.jsonl`. Fallback
 * (P-016): if that misses for a Claude session (stale/rotated session_id), use the
 * newest jsonl under the owner root so a live session is never left with a null
 * estimate — the null that silently hid the per-turn compaction reminder and let the
 * 2026-07-04 cohort drift to 836k. OMP/Codex keep the null-by-design gate (no jsonl
 * transcript). Cohorts whose transcript lives outside the owner root entirely are
 * covered by the mechanical `autoCompactWindow` cap (P-014), not this estimate.
 */
export async function estimateContextTokensForOwner(ownerId: string): Promise<number | null> {
  const ref = await resolveSessionRef(ownerId);
  if (!ref) return null;
  const primary = await estimateContextTokens(ref, ownerId);
  if (primary != null) return primary;
  if (ref.agent === 'omp' || ref.agent === 'codex') return null;
  const alt = newestTranscriptUnderOwner(ownerId);
  return alt ? tokensFromFileSize(alt) : null;
}

/* ── WI-4154: anchored incremental reads — right the first time ─────────────
 *
 * The watchdog-cached estimate (coord_presence.context_tokens + the in-process
 * mirror) went stale ACROSS A COMPACTION BOUNDARY: nothing invalidated it when a
 * compaction landed, so for up to one ~2-min sweep every post-compaction render
 * served the PRE-compaction number — false LOUD/CRITICAL alarms at exactly the
 * compact-decision moment (two sessions burned pointless compactions on 126%/87%
 * readings whose real usage was 14–15%). Owner directive: don't re-verify a
 * possibly-wrong cache — make every rendered value RIGHT THE FIRST TIME.
 *
 * So render paths no longer read a point-in-time token cache. Each owner gets a
 * tiny ANCHOR — {countStart (last compaction-marker offset), imageExcess,
 * settled (last complete-line offset), sizeSeen} — and every read stats the
 * transcript and scans ONLY the bytes appended since the last read, updating the
 * anchor as markers/images stream past. The returned value equals the full
 * tail-scan estimate at the current file size, at per-read cost proportional to
 * the append delta (typically KBs) instead of an 8MB tail scan. A compaction is
 * reflected the moment its summary line hits the transcript — no event, no TTL,
 * no verification pass.
 *
 * Only COMPLETE lines settle into the anchor (JSONL lines are the atomic unit;
 * a marker or base64 image run never spans lines), so a partially-flushed line
 * is counted raw once and re-scanned when its newline lands — never split
 * across scans where a marker/image match could be missed. Anchors are
 * per-process (each :3070 cluster worker / bg-host keeps its own) — purely a
 * cost optimization, never a correctness dependency. */

const NEWLINE = 0x0a;

/** A sync caller (the P-013 result annotator, a sync dispatch hot path) reads at
 *  most this much delta per call; a bigger backlog defers to a background
 *  (re)seed and the caller renders nothing rather than block the event loop. */
const SYNC_DELTA_CAP = 1024 * 1024;

interface TranscriptAnchor {
  path: string;
  /** Absolute offset where token counting starts (last seen marker start, or 0). */
  countStart: number;
  /** Image-payload byte excess accumulated over settled bytes in [countStart, settled). */
  imageExcess: number;
  /** Absolute offset just past the last complete line scanned (settled ≤ sizeSeen). */
  settled: number;
  /** File size at the last read; (settled, sizeSeen] is the raw-counted partial tail. */
  sizeSeen: number;
  at: number;
}

const anchors = new Map<string, TranscriptAnchor>();
/** Background (re)seed dedup for the sync path. */
const seedInFlight = new Set<string>();

function anchorTokens(a: TranscriptAnchor): number {
  return Math.max(0, Math.floor((a.sizeSeen - a.countStart - a.imageExcess) / 4));
}

/** Sum the image discount (WI-3176) over a settled latin1 slice. */
function imageExcessIn(visible: string): number {
  let excess = 0;
  for (const m of visible.matchAll(IMAGE_PAYLOAD_RE)) {
    excess += m[0].length - IMAGE_TOKEN_COST * 4;
  }
  return excess;
}

/** Full (tail-capped) scan → a fresh anchor. Same math as tokensFromFileSize,
 *  but retains WHERE counting starts so later reads can advance incrementally.
 *  Null on any fs error (caller degrades like the estimator does). */
function seedAnchorFromFile(pathStr: string): TranscriptAnchor | null {
  try {
    const size = fs.statSync(pathStr).size;
    const start = Math.max(0, size - BOUNDARY_SCAN_CAP);
    const fd = fs.openSync(pathStr, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lastNl = buf.lastIndexOf(NEWLINE);
      const settledLen = lastNl === -1 ? 0 : lastNl + 1;
      const view = buf.subarray(0, settledLen);
      const idx = view.lastIndexOf(COMPACT_BOUNDARY_MARKER);
      // Marker not in the scanned window ⇒ count from 0 (whole file), exactly
      // like tokensFromFileSize: past the 8MB cap the estimate is over every
      // real limit anyway; discounting only the visible region stays conservative.
      const countStart = idx === -1 ? 0 : start + idx;
      const imageExcess = imageExcessIn(view.toString('latin1', idx === -1 ? 0 : idx));
      return {
        path: pathStr,
        countStart,
        imageExcess,
        settled: start + settledLen,
        sizeSeen: size,
        at: Date.now(),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Advance an anchor over the bytes appended since its last read.
 *  'ok' — anchor is current (tokens readable); 'reseed' — file shrank/rotated or
 *  the backlog exceeds the scan cap (full reseed needed); 'defer' — sync caller
 *  hit its delta cap (a background advance/seed should run). Throws on fs errors
 *  (missing file) — callers treat that as 'reseed'. */
function advanceAnchor(a: TranscriptAnchor, opts: { syncCap?: number } = {}): 'ok' | 'reseed' | 'defer' {
  const size = fs.statSync(a.path).size;
  if (size < a.sizeSeen) return 'reseed';
  if (size === a.sizeSeen) return 'ok';
  const deltaLen = size - a.settled; // re-read the unsettled partial tail + new bytes
  if (deltaLen > BOUNDARY_SCAN_CAP) return 'reseed';
  if (opts.syncCap != null && deltaLen > opts.syncCap) return 'defer';
  const fd = fs.openSync(a.path, 'r');
  try {
    const buf = Buffer.alloc(deltaLen);
    fs.readSync(fd, buf, 0, deltaLen, a.settled);
    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl !== -1) {
      const settledLen = lastNl + 1;
      const view = buf.subarray(0, settledLen);
      const idx = view.lastIndexOf(COMPACT_BOUNDARY_MARKER);
      if (idx !== -1) {
        // A compaction landed in this delta: counting restarts at the marker.
        a.countStart = a.settled + idx;
        a.imageExcess = imageExcessIn(view.toString('latin1', idx));
      } else {
        a.imageExcess += imageExcessIn(view.toString('latin1'));
      }
      a.settled += settledLen;
    }
    a.sizeSeen = size;
    a.at = Date.now();
    return 'ok';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The live per-render read: EXACT current context tokens for an owner, derived
 * from the transcript's state at THIS call (anchored-incremental, so the cost is
 * the append delta, not a tail scan). Resolution/degradation contract matches
 * estimateContextTokensForOwner: OMP/Codex and unresolvable transcripts → null.
 * `reseed: true` forces a fresh full scan (periodic ground-truthing / boundary
 * refresh) instead of trusting the anchor.
 */
export async function currentContextTokensForOwner(
  ownerId: string,
  opts: { reseed?: boolean } = {},
): Promise<number | null> {
  const a = anchors.get(ownerId);
  if (a && !opts.reseed) {
    try {
      if (advanceAnchor(a) === 'ok') return anchorTokens(a);
    } catch {
      /* rotated/unreadable — fall through to reseed */
    }
  }
  const ref = await resolveSessionRef(ownerId);
  if (!ref || ref.agent === 'omp' || ref.agent === 'codex') return null;
  let p: string | null = null;
  if (ref.sessionId) {
    try {
      p = await findSessionTranscript(ref.sessionId, { owner: ownerId });
    } catch {
      p = null;
    }
  }
  // P-016 fallback: stale/rotated session_id → newest jsonl under the owner root.
  if (!p) p = newestTranscriptUnderOwner(ownerId);
  if (!p) return null;
  const seeded = seedAnchorFromFile(p);
  if (!seeded) return null;
  anchors.set(ownerId, seeded);
  return anchorTokens(seeded);
}

/**
 * Sync variant for the P-013 result annotator. Returns the exact current tokens
 * when the anchor can advance within {@link SYNC_DELTA_CAP}; otherwise kicks ONE
 * background (re)seed and returns null — the caller renders NOTHING this call
 * rather than a possibly-stale number, and the next call reads the corrected
 * anchor. (An owner never read in this process before seeds in the background
 * the same way.)
 */
export function currentContextTokensSyncForOwner(ownerId: string): number | null {
  const a = anchors.get(ownerId);
  if (a) {
    try {
      if (advanceAnchor(a, { syncCap: SYNC_DELTA_CAP }) === 'ok') return anchorTokens(a);
    } catch {
      /* rotated/unreadable — background reseed below */
    }
  }
  if (!seedInFlight.has(ownerId)) {
    seedInFlight.add(ownerId);
    void currentContextTokensForOwner(ownerId, { reseed: true })
      .catch(() => null)
      .finally(() => seedInFlight.delete(ownerId));
  }
  return null;
}

/** Test seams: reset anchor state / seed an anchor for a known file directly
 *  (unit tests have no adv_sessions row to resolve an owner through). */
export function resetContextAnchorsForTests(): void {
  anchors.clear();
  seedInFlight.clear();
}
export function seedContextAnchorForTests(ownerId: string, pathStr: string): boolean {
  const seeded = seedAnchorFromFile(pathStr);
  if (!seeded) return false;
  anchors.set(ownerId, seeded);
  return true;
}

/** The context-death signature Claude writes into the transcript when the
 *  request exceeds the model window — the silent fleet-member killer
 *  (context-trimming-tiers P-019: 6 members died on it, 2026-07-01). */
export const CONTEXT_DEATH_MARKER = 'Prompt is too long';

/** How much transcript tail to scan for the death marker. The error lands as
 *  the final entry, but a hook/summary line can trail it — 8KB is plenty. */
const DEATH_TAIL_BYTES = 8_192;

/**
 * P-019 context-death detector: does this owner's transcript TAIL carry the
 * "Prompt is too long" window-overflow error? Best-effort (null transcript /
 * read error → false). fs reads only the tail, never the whole file.
 */
export async function detectContextDeathForOwner(ownerId: string): Promise<boolean> {
  try {
    const ref = await resolveSessionRef(ownerId);
    if (!ref?.sessionId || ref.agent === 'omp' || ref.agent === 'codex') return false;
    const { findSessionTranscript } = await import('./claude-sessions');
    const p = await findSessionTranscript(ref.sessionId, { owner: ownerId });
    if (!p) return false;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - DEATH_TAIL_BYTES);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').includes(CONTEXT_DEATH_MARKER);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Best-effort MODEL SPEC (`<id>[:effort]`, possibly carrying the `[1m]` window
 * marker) for a session owner — the window signal `defaultCompactionLimitForSpec`
 * keys on (context-trimming-tiers P-002/P-006).
 *
 * Source 1: a `--model` in the recorded launch argv (adv_sessions) — the only
 * PER-SESSION truth. Source 2 (fallback when no `--model` was recorded): the
 * session config dir's `settings.json` `model` field. Order matters: that
 * `settings.json` is a SYMLINK back to the shared `~/.claude/settings.json`
 * (interactive-claude-config mirror), so it reports the BOX-DEFAULT model —
 * checking it first handed every `psu --model=sonnet` fleet member the
 * opus[1m] 500k limit on a 200k window, a guaranteed context death
 * (context-trimming-tiers P-031 gap 1, 2026-07-02). argv-first fails safe:
 * a conservative spec on a big window is deliberate leanness; a big spec on a
 * 200k window is fatal. null when neither resolves — callers treat null as the
 * conservative 200k window.
 */
export async function resolveModelSpecForOwner(ownerId: string): Promise<string | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ launch_argv: unknown }[]>`
      SELECT launch_argv
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND launch_argv IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const argv = rows[0]?.launch_argv;
    if (Array.isArray(argv)) {
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (typeof a !== 'string') continue;
        if (a.startsWith('--model=')) {
          const v = a.slice('--model='.length).trim();
          if (v) return v;
        }
        if (a === '--model' && typeof argv[i + 1] === 'string') {
          const v = (argv[i + 1] as string).trim();
          if (v) return v;
        }
      }
    }
  } catch {
    /* best-effort — fall through to settings.json */
  }
  // Guard the path join: owner ids are our own (su-/s-/pus- UUIDs), but never
  // let a hostile id escape the session-claude root.
  if (ownerId && !ownerId.includes('/') && !ownerId.includes('..')) {
    try {
      const { papercuspSessionClaudeBase } = await import('./claude-sessions');
      const path = await import('node:path');
      const p = path.join(papercuspSessionClaudeBase(), ownerId, 'settings.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { model?: unknown };
      if (typeof j.model === 'string' && j.model.trim()) return j.model.trim();
    } catch {
      /* unresolvable */
    }
  }
  return null;
}
