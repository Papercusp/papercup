/**
 * turn-end-tracking — system-owned turn-end sweeps
 * (deterministic-context-carry-2026-07-14 P-015, plan D-003: tracking becomes
 * system-owned/deterministic wherever possible).
 *
 * Two sweeps, both riding the P-012 turn-end seam (journal:record-turn — the
 * one server-side moment that fires at every turn end across every CLI):
 *
 *  1. AUTO-CHECKPOINT ON STALE HELD-WI — a held work-item whose checkpoint is
 *     missing or old is the classic silent-halt precursor: the holder dies /
 *     compacts and the successor cold-starts. The system writes a MECHANICAL
 *     checkpoint block composed deterministically from what it already tracks
 *     (the turn's journal note + the P-013 tool-call log tail) — clearly
 *     marked, holder-session-level, never overwriting agent-authored prose
 *     (the block is appended; only a PREVIOUS mechanical block is replaced).
 *
 *  2. UNREGISTERED-ARTIFACT DETECTION — a deliverable written to a scratch
 *     path (report, analysis, export) that is never registered via
 *     artifacts:save is invisible to every other agent and dies with the
 *     sandbox. Detected from the turn's file-write ledger vs the
 *     harness_text_artifacts registrations in the same window; recorded as a
 *     journal tripwire (kind 'unregistered-artifact').
 *
 * PURE logic here (unit-tested without PG); the IO wiring lives in
 * agent-tools/journal/record-turn.ts. Warn/record-only — enforcement is P-016.
 */

/** A held checkpoint older than this (or absent) is STALE at turn end. */
export const STALE_CHECKPOINT_MS = 45 * 60 * 1000;

/** Marker opening a mechanical (system-written) checkpoint block. The ⟦…⟧
 *  bracket family is already the machine-text convention (⟦journal⟧,
 *  ⟦turn-origin⟧) — unmistakable, never typed by hand. */
export const MECHANICAL_CHECKPOINT_MARKER = '⟦auto-checkpoint mechanical';

/** Separator between agent-authored prose and the appended mechanical block. */
const MECHANICAL_SEP = '\n\n---\n';

export interface HeldCheckpointState {
  checkpoint: string | null;
  /** Epoch ms of the checkpoint's last write; null/undefined when unknown
   *  (matches CarryBriefHeldItem's optional meta). */
  checkpointUpdatedAtMs?: number | null;
}

/**
 * Stale = no checkpoint at all, or one older than the threshold. An EXISTING
 * checkpoint with UNKNOWN write time is NOT stale — this sweep only acts when
 * it can prove the gap (warn-only discipline; a wrong overwrite is worse than
 * a missed nudge).
 */
export function isStaleHeldCheckpoint(
  item: HeldCheckpointState,
  nowMs: number,
  thresholdMs: number = STALE_CHECKPOINT_MS,
): boolean {
  if (item.checkpoint === null || item.checkpoint.trim() === '') return true;
  if (item.checkpointUpdatedAtMs === null || item.checkpointUpdatedAtMs === undefined) return false;
  return nowMs - item.checkpointUpdatedAtMs > thresholdMs;
}

export interface MechanicalCheckpointInput {
  /** When the block was composed (ISO). */
  atIso: string;
  /** The turn's journal note, when one was recorded. */
  journalNote?: string | null;
  /** The P-013 tool-call log tail for the window (renderToolCallLog output). */
  toolLog?: string | null;
  /** The recording session, for traceability. */
  sessionId?: string | null;
}

const JOURNAL_NOTE_CAP = 400;

/**
 * Compose the mechanical block. Honest about its own nature: it is a snapshot
 * of the HOLDER's session activity, not verified per-item state — strictly
 * better than a null checkpoint for a cold successor, never presented as
 * agent-authored.
 */
export function composeMechanicalCheckpoint(input: MechanicalCheckpointInput): string {
  const lines = [
    `${MECHANICAL_CHECKPOINT_MARKER} @${input.atIso}⟧ system turn-end snapshot — the holder's agent-written ` +
      `checkpoint was missing/stale (P-015). Holder-session-level, not item-verified.`,
  ];
  if (input.sessionId) lines.push(`session: ${input.sessionId}`);
  const note = (input.journalNote ?? '').replace(/\s+/g, ' ').trim();
  if (note) lines.push(`latest journal: ${note.slice(0, JOURNAL_NOTE_CAP)}`);
  const log = (input.toolLog ?? '').trim();
  if (log) lines.push('tool-log tail:', log);
  return lines.join('\n');
}

/**
 * Merge the mechanical block into an existing checkpoint: agent-authored prose
 * is PRESERVED verbatim; a previous mechanical block (always the tail — this
 * function only ever appends one at the end) is replaced, so repeated sweeps
 * never stack blocks.
 */
export function mergeMechanicalCheckpoint(existing: string | null | undefined, block: string): string {
  const prior = (existing ?? '').trimEnd();
  if (!prior) return block;
  const markerAt = prior.indexOf(MECHANICAL_CHECKPOINT_MARKER);
  const agentPart = (markerAt >= 0 ? prior.slice(0, markerAt) : prior)
    .replace(/(\n\s*---\s*)+$/, '')
    .trimEnd();
  return agentPart ? `${agentPart}${MECHANICAL_SEP}${block}` : block;
}

/* ------------------------------------------------------------------ */
/* Unregistered-artifact detection                                     */
/* ------------------------------------------------------------------ */

/** Scratch/temp roots — a deliverable landing here dies with the sandbox
 *  unless registered. Repo-tree writes are NOT artifacts (artifacts:save's own
 *  guidance: source code belongs in the repo, not the artifact store). */
const SCRATCH_PATH_RE = /^\/tmp\/|\/scratchpad\/|\/\.papercusp\/scratch\/|\/scratch\//;

/** Deliverable-shaped extensions: human-readable reports/exports. Code,
 *  JSONL plumbing, logs, and lockfiles are deliberately excluded — the lint
 *  must stay high-precision or agents learn to ignore it. */
const DELIVERABLE_EXT_RE = /\.(?:md|html?|csv|txt|pdf)$/i;

/** Obvious plumbing under scratch that is never a deliverable. */
const PLUMBING_RE = /\/(?:tasks|node_modules|\.git)\/|result-door-\d+/;

export function isDeliverableWrite(filePath: string): boolean {
  const p = filePath.trim();
  if (!p) return false;
  if (!SCRATCH_PATH_RE.test(p)) return false;
  if (PLUMBING_RE.test(p)) return false;
  return DELIVERABLE_EXT_RE.test(p);
}

export function basenameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase();
}

const MAX_UNREGISTERED = 5;

/**
 * Deliverable-shaped file writes with no artifacts:save registration in the
 * same window. Matching is by BASENAME on purpose: artifacts register under a
 * harness-relative rel_path that never equals the sandbox's absolute write
 * path, and a false negative (same basename registered for different content)
 * is fine for a warn-only sweep.
 */
export function detectUnregisteredArtifacts(
  writtenFiles: string[],
  registeredRelPaths: string[],
): string[] {
  const registered = new Set(registeredRelPaths.map(basenameOf));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of writtenFiles) {
    if (!isDeliverableWrite(f)) continue;
    const base = basenameOf(f);
    if (seen.has(base) || registered.has(base)) continue;
    seen.add(base);
    out.push(f);
    if (out.length >= MAX_UNREGISTERED) break;
  }
  return out;
}

/** The journal-tripwire payload for an unregistered-deliverable turn. */
export interface UnregisteredArtifactTripwire {
  kind: 'unregistered-artifact';
  /** Scratch-path deliverables written this turn with no registration. */
  files: string[];
  note: string;
}

export const UNREGISTERED_ARTIFACT_NOTE =
  'Deliverable(s) written to a scratch path with no artifacts:save registration this turn — scratch dies with ' +
  'the sandbox and nothing else can find the file. Register it: artifacts:save { rel_path, content } ' +
  '(PG-canonical, readable by every agent via artifacts:load). deterministic-context-carry P-015.';

export function unregisteredArtifactTripwire(
  writtenFiles: string[],
  registeredRelPaths: string[],
): UnregisteredArtifactTripwire | null {
  const files = detectUnregisteredArtifacts(writtenFiles, registeredRelPaths);
  if (files.length === 0) return null;
  return { kind: 'unregistered-artifact', files, note: UNREGISTERED_ARTIFACT_NOTE };
}
