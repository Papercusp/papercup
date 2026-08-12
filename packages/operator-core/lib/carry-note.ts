/**
 * carry-note — the ONE shared "note to my next self" substrate + shape
 * (su-cold-auto-mode-2026-07-03 Phase 1 / P-001; D-004 — the linchpin +
 * precondition for cold-auto).
 *
 * Converges the THREE per-role carry mechanisms that already do this job into a
 * single durable PG store (`harness_shared.carry_notes`, mig 472) and one
 * structured shape:
 *   - the Queen carry-journal  (pot:declare-wake { remember } → setHiveCarryNote)
 *   - the bee checkpoint        (work_items:checkpoint → setWorkItemCheckpoint)
 *   - the su loop carry-note     (the SU AUTO loop's cold-wake anchor, P-002)
 *
 * A COLD wake (fresh-context reset or a recycle — Phase 2) reads its carry-note to
 * reconstruct working state instead of re-reading a grown transcript. Cold-start
 * is only as safe as what this captures, so the substrate lands FIRST and the
 * mechanism (Phase 2) builds on it.
 *
 * SEMANTICS (the shared D-003 contract, formerly duplicated in setHiveCarryNote +
 * setWorkItemCheckpoint): `note` is the current full state — any length (TEXT, no
 * cap), REPLACE-on-write; a blank/omitted/null note CLEARS `note` (the reader
 * re-derives from its floor — graceful degradation). Every non-blank write APPENDS
 * a capped entry to a bounded `journal` ring so the reasoning TRAJECTORY survives
 * a clear (the Queen carry-JOURNAL behavior, generalized to all three). A row with
 * a null note AND an empty journal is deleted. Durable PG, inspectable. LOCAL
 * working state — never federated.
 *
 * SCOPE: a stable, role-discriminated string key so the one store keys every
 * carrier — use the {@link hiveScope} / {@link workItemScope} / {@link loopScope}
 * constructors. Keyed (workspace_id, scope); the workspace_id column carries
 * workspace isolation.
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { resolveConcreteWorkspaceId } from './workspace-registry';
import { notifyAgentOrdersChanged } from './agent-orders-notify';

/**
 * First 12 hex chars of sha256(text) — short enough to eyeball, long enough that an
 * accidental collision between two DIFFERENT carry-note bodies is not a real concern.
 * Shared home for the hash BOTH carry-note-backed checkpoint tools (work_items:checkpoint,
 * loop:checkpoint) use so a caller can eyeball-confirm a write without a second read.
 */
export function shortCarryHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

// ── Scope keys (the convergence axis) ────────────────────────────────────────

/** The Queen's per-workspace carry-note. The workspace_id column disambiguates,
 *  so no workspace suffix is needed. */
export function hiveScope(): string {
  return 'hive';
}

/** A bee's work-item-scoped checkpoint — lives on the item so an evicted bee's
 *  successor inherits it (bee-context-efficiency D-002). */
export function workItemScope(harness: string, workItemId: string): string {
  return `workitem:${harness}:${workItemId}`;
}

/** An su AUTO loop's carry-note, keyed by the owner id the loop wakes (stable
 *  across a fresh-context RESET and a RECYCLE — PAPERCUSP_SID is preserved, P-004). */
export function loopScope(harness: string, ownerId: string): string {
  return `loop:${harness}:${ownerId}`;
}

// ── The structured shape — a "note to my next self" ──────────────────────────

/** An owner-gated / pending-decision COMMITMENT carried as a row, never prose
 *  (compaction-continuity-hardening-2026-07-07 P-006). Prose asks dissolve at a
 *  context boundary; a wall row survives it mechanically — rendered into every
 *  wake and every carry brief until explicitly cleared. */
export interface WallEntry {
  /** Stable identity, independent of wording (P-013) — see {@link carryRowKey}. */
  id?: string;
  /** The pending action / decision, stated concretely ("3 zombie PIDs await owner OK to kill"). */
  claim: string;
  /** A concrete re-check command a successor runs to test whether the wall still stands. */
  recheck?: string;
  /** Epoch ms the wall was first recorded — preserved across rewrites of the same claim. */
  sinceMs?: number;
}

/** A carried CLAIM about external state + the probe that falsifies it
 *  (cold-carry-system-hardening-2026-07-19 P-001/P-010) — the non-owner analog of a
 *  {@link WallEntry}. Root incident: a cold-carried instruction ("expect the hash to
 *  ROLL, count under the new hash") was executed to the letter into a wrong soak
 *  anchor because the note carried the conclusion WITHOUT its verification probe,
 *  while the walls (claim+recheck rows) never misled all night. A check row makes
 *  the probe travel with the claim — and distinguishes VERIFIED (evidence attached)
 *  from PREDICTED (a hypothesis the successor must re-check before relying on). */
export interface CheckEntry {
  /** Stable identity, independent of wording (P-013) — see {@link carryRowKey}. */
  id?: string;
  /** The claim about external state, stated concretely ("post-restart ticks stamp hash b01b01…"). */
  claim: string;
  /** A concrete probe a successor runs to falsify/confirm the claim before relying on it. */
  recheck?: string;
  /** Evidence pointer for a VERIFIED claim — what was observed, where ("tick 1944 @02:38Z, pg read").
   *  Absent ⇒ the claim renders as PREDICTED. */
  verified?: string;
  /** Epoch ms the check was first recorded — preserved across rewrites of the same claim. */
  sinceMs?: number;
}

/** FACTS, not a self-grade (D-004). All fields optional; a plain string is equally
 *  valid (the store is free TEXT). {@link renderCarryNote} produces the canonical
 *  template a cold successor knows how to read. */
export interface CarryNoteFields {
  /** what-I-did — the concrete progress this session/wake made. */
  did?: string;
  /** what's-left — the remaining work, in order. */
  left?: string;
  /** key-insight — the non-obvious thing a cold successor would waste time re-deriving. */
  insight?: string;
  /** next-action — the single concrete next step to take on the next wake. */
  next?: string;
  /** carried CHECKS — external-state claims as {claim, recheck} rows (P-001);
   *  rendered as a `## Checks` section of parseable one-line rows. */
  checks?: CheckEntry[];
  /** open WALLS — owner-gated commitments as rows (P-006); rendered as a `## Walls`
   *  section of parseable one-line rows, carried until explicitly cleared. */
  walls?: WallEntry[];
}

type CarryNoteTextKey = 'did' | 'left' | 'insight' | 'next';

const CARRY_NOTE_SECTIONS: ReadonlyArray<{ key: CarryNoteTextKey; heading: string }> = [
  { key: 'did', heading: 'Did' },
  { key: 'left', heading: 'Left' },
  { key: 'insight', heading: 'Key insight' },
  { key: 'next', heading: 'Next action' },
];

/** The walls section heading (P-006). Rendered LAST so the four narrative sections
 *  keep their positions for existing parsers/extractors. */
export const CARRY_NOTE_WALLS_HEADING = 'Walls';

/** Bound on carried wall rows — a wall set past this is a triage problem, not a note. */
export const CARRY_NOTE_MAX_WALLS = 12;

/** The checks section heading (P-001). Rendered after the narrative sections,
 *  before Walls (walls stay last — the established anchor position). */
export const CARRY_NOTE_CHECKS_HEADING = 'Checks';

/** Bound on carried check rows — same triage rationale as walls. */
export const CARRY_NOTE_MAX_CHECKS = 12;

/**
 * SOFT caps on a carried row's sub-fields (WI-7264). These bound what gets
 * re-injected into EVERY future wake, so they stay tight — but they are enforced by
 * TRUNCATION, not rejection. The schema keeps a much looser hard `.max()` as a
 * sanity backstop; overage between the two is repaired and REPORTED.
 *
 * Why: a zod `.max()` rejects the WHOLE CALL, and these rows travel attached to a
 * ~6KB note. Measured over 6 days of real transcripts, one sub-field a few chars
 * over its cap discarded the entire accompanying note 53 times, costing 364,735
 * argument chars — paid twice, because the agent then rewrote and re-sent the note.
 * Truncating the offending field keeps the re-injection bound exactly where it was
 * while removing the double-write, and is the same repair-don't-refuse choice
 * already made by this file's JSON-string coercion and by
 * `rescueTaggedCarryNoteBlob` (whose comment notes a refusal left a cold wake with
 * no note at all).
 *
 * Truncation is never SILENT: the caller is told what was trimmed. The failure this
 * must not re-create is EI-18723223344390510, where a nested row quietly dropped
 * fields and destroyed a verified check's evidence with no signal.
 */
export const CARRY_ROW_SOFT_CAPS = { claim: 500, recheck: 300, verified: 300 } as const;

/** Soft cap on each narrative field (`did`/`left`/`insight`/`next`), same contract. */
export const CARRY_TEXT_SOFT_CAP = 8000;

/** Multiple of a soft cap at which the schema genuinely rejects. Past this the payload
 *  is not an overrun note, it is a mistake worth failing loudly. */
export const CARRY_CAP_HARD_MULTIPLE = 4;

/** Marker appended to a truncated field so a reader can SEE the cut in the note. */
export const CARRY_TRUNCATION_MARKER = '…[truncated]';

/** One repair applied to an incoming carry-note write, reported back to the caller. */
export type CarryArgRepair = {
  /** Dotted path of the repaired field, e.g. `checks[2].recheck`. */
  field: string;
  kind: 'truncated' | 'renamed';
  detail: string;
};

/** Truncate `v` to `cap`, recording a repair. Returns `v` untouched when within cap. */
export function truncateCarryField(v: string, cap: number, field: string, repairs: CarryArgRepair[]): string {
  if (v.length <= cap) return v;
  repairs.push({
    field,
    kind: 'truncated',
    detail: `${v.length} chars trimmed to ${cap} (${v.length - cap} over) — write it shorter to keep the full text`,
  });
  return v.slice(0, Math.max(0, cap - CARRY_TRUNCATION_MARKER.length)) + CARRY_TRUNCATION_MARKER;
}

/**
 * Repair one incoming `checks`/`walls` row IN THE ARGUMENT SHAPE, before validation.
 *
 * Handles the common wrong shapes agents reach for: `{claim, recheck, status,
 * evidence}` instead of `{claim, recheck, verified}`, and the documented-looking
 * `{claim, probe, verified}` alias where `probe` is intended to mean `recheck`.
 * Measured across 6 days of transcripts, `evidence` (57×) and `status` (40×) were
 * by far the top rejected undeclared keys; the probe alias is handled here too so
 * a caller's concrete falsification command is not discarded at the schema boundary.
 *
 * `verified` semantics are preserved exactly: it is an EVIDENCE STRING whose mere
 * presence renders the row VERIFIED, and whose absence renders it PREDICTED. So a
 * row carrying real evidence maps to that evidence; a row whose `status` says it was
 * NOT verified maps to no `verified` at all, rather than inventing one.
 */
export function coerceCarryRowShape(row: unknown, path: string, repairs: CarryArgRepair[]): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const r = { ...(row as Record<string, unknown>) };
  const hasStatus = 'status' in r;
  const hasEvidence = 'evidence' in r;
  const hasProbe = 'probe' in r;
  if (!hasStatus && !hasEvidence && !hasProbe && typeof r.verified !== 'boolean') return row;

  if (hasProbe) {
    // `recheck` is the canonical field, but `probe` is the natural/documented
    // synonym callers use for the command that tests a carried claim. Preserve
    // an explicitly supplied canonical value when both are present, while always
    // removing the undeclared alias before strict schema validation.
    const probe = r.probe;
    const hadRecheck = 'recheck' in r;
    delete r.probe;
    if (!hadRecheck) r.recheck = probe;
    repairs.push({
      field: `${path}.probe`,
      kind: 'renamed',
      detail:
        'the documented `probe` key is accepted as an alias for `recheck`; ' +
        (hadRecheck ? 'the canonical recheck value was kept' : 'the probe value was mapped to recheck'),
    });
  }

  const evidence = typeof r.evidence === 'string' ? r.evidence.trim() : '';
  const status = typeof r.status === 'string' ? r.status.trim() : '';
  // Only these read as an affirmative verification; anything else (predicted,
  // pending, unknown, false, …) must stay PREDICTED rather than be upgraded.
  const statusVerified = /^(verified|true|pass(ed)?|confirmed|done|ok|✓)$/i.test(status);
  const booleanVerified = typeof r.verified === 'boolean' ? r.verified : undefined;

  if (booleanVerified !== undefined) {
    // A boolean was never storable — it is the flag-vs-evidence confusion. `true`
    // keeps real evidence that came with it; `false` is simply PREDICTED, even if a
    // contradictory/stray evidence field is also present. The explicit boolean is
    // the caller's verdict, so a malformed companion field must not override it.
    const was = r.verified;
    delete r.verified;
    if (was && evidence) r.verified = evidence;
    repairs.push({
      field: `${path}.verified`,
      kind: 'renamed',
      detail: `boolean ${was} is not storable — \`verified\` is the evidence STRING itself; ${
        r.verified ? 'used the accompanying evidence' : 'row kept as PREDICTED'
      }`,
    });
  }

  if (hasEvidence || hasStatus) {
    delete r.status;
    delete r.evidence;
    // When a boolean was supplied, it is authoritative: only `true` with a real
    // evidence string above can become VERIFIED. Without the boolean compatibility
    // shape, retain the older lossless `{status, evidence}` repair.
    if (r.verified === undefined && booleanVerified === undefined) {
      if (evidence) r.verified = evidence;
      else if (statusVerified) r.verified = status;
    }
    repairs.push({
      field: path,
      kind: 'renamed',
      detail: `{${[hasStatus && 'status', hasEvidence && 'evidence'].filter(Boolean).join(', ')}} is not this tool's row shape — mapped to \`verified\` (${
        r.verified === undefined ? 'kept as PREDICTED' : 'evidence preserved'
      }); pass {claim, recheck, verified} directly next time`,
    });
  }
  return r;
}

/** Fixed legend rendered under the `## Checks` heading so a cold successor reads the
 *  rows correctly with zero prior knowledge. Starts with `_` so line-parsers skip it. */
export const CARRY_NOTE_CHECKS_LEGEND =
  '_✓ = VERIFIED (evidence attached) · ? = PREDICTED — run the re-check before relying on it_';

/** Max length of a row `id`. Long enough to be descriptive (`gate-green-at-tip`),
 *  short enough that the rendered `[#…]` prefix never dominates the row. */
export const CARRY_ROW_ID_MAX = 40;

/** The charset an `id` round-trips through {@link renderCheckLine} / {@link parseCheckLine}
 *  intact: no whitespace and no `]`, so the `[#…]` anchor can never swallow claim text. */
const CARRY_ROW_ID_ALLOWED = /[^A-Za-z0-9._:-]+/g;

/** Sanitize a caller-supplied row id to the round-trippable charset, or null when
 *  nothing survives. Repair-don't-refuse, like every other coercion in this file: an
 *  id with a space becomes `my-id`, never a rejected write that discards the note. */
export function sanitizeCarryRowId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(CARRY_ROW_ID_ALLOWED, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, CARRY_ROW_ID_MAX).toLowerCase();
}

/**
 * The IDENTITY of a carried row (P-013), used for EVERY identity decision — dedup,
 * inheritance of recheck/verified/sinceMs, merge-upsert, and drop-detection.
 *
 * `id` when present, else the trimmed claim text. The two namespaces are TAGGED
 * apart so a row whose claim text happens to equal another row's id can never
 * collide with it.
 *
 * Why an id at all: keying identity on the claim TEXT means re-wording a claim makes
 * it a different row — it loses its inherited evidence and `sinceMs`, and reads to
 * the drop-report as a carried claim that vanished. An id makes identity independent
 * of wording, which is what lets a caller tighten a claim in place.
 */
export function carryRowKey(row: { id?: string; claim?: string }): string {
  const id = sanitizeCarryRowId(row.id);
  return id ? `id:${id}` : `claim:${(row.claim ?? '').trim()}`;
}

/** One wall as a parseable single line: `- [#id] <claim> — re-check: <cmd> (since <ISO>)`.
 *  The `[#…]` prefix, " — re-check: " and trailing " (since …)" markers are the
 *  round-trip anchors. */
export function renderWallLine(w: WallEntry): string {
  const recheck = (w.recheck ?? '').trim();
  const id = sanitizeCarryRowId(w.id);
  const since =
    w.sinceMs != null && Number.isFinite(w.sinceMs) ? ` (since ${new Date(w.sinceMs).toISOString()})` : '';
  return `- ${id ? `[#${id}] ` : ''}${w.claim.trim()}${recheck ? ` — re-check: ${recheck}` : ''}${since}`;
}

/** Parse one walls-section line back into a {@link WallEntry}; null for a
 *  non-row line (blank, prose, malformed). */
export function parseWallLine(line: string): WallEntry | null {
  const m =
    /^-\s+(?:\[#([A-Za-z0-9._:-]{1,40})\]\s+)?(.+?)(?:\s+—\s+re-check:\s+(.+?))?(?:\s+\(since\s+([^)]+)\))?\s*$/.exec(
      line,
    );
  if (!m) return null;
  const claim = (m[2] ?? '').trim();
  if (!claim) return null;
  const out: WallEntry = { claim };
  const id = sanitizeCarryRowId(m[1]);
  if (id) out.id = id;
  const recheck = (m[3] ?? '').trim();
  if (recheck) out.recheck = recheck;
  if (m[4]) {
    const t = Date.parse(m[4]);
    if (Number.isFinite(t)) out.sinceMs = t;
  }
  return out;
}

/** One check as a parseable single line: `- ✓|? <claim> — re-check: <cmd> — evidence: <ptr> (since <ISO>)`.
 *  `✓` = verified (evidence follows), `?` = predicted. The marker, " — re-check: ",
 *  " — evidence: " and trailing " (since …)" are the round-trip anchors. */
export function renderCheckLine(c: CheckEntry): string {
  const recheck = (c.recheck ?? '').trim();
  const verified = (c.verified ?? '').trim();
  const id = sanitizeCarryRowId(c.id);
  const since =
    c.sinceMs != null && Number.isFinite(c.sinceMs) ? ` (since ${new Date(c.sinceMs).toISOString()})` : '';
  return `- ${verified ? '✓' : '?'} ${id ? `[#${id}] ` : ''}${c.claim.trim()}${
    recheck ? ` — re-check: ${recheck}` : ''
  }${verified ? ` — evidence: ${verified}` : ''}${since}`;
}

/** Parse one checks-section line back into a {@link CheckEntry}; null for a
 *  non-row line (blank, the legend, prose, malformed). Review fold #6: the ✓|?
 *  marker is OPTIONAL on parse — an agent hand-writing a row in walls syntax
 *  (`- claim — re-check: cmd`) parses as PREDICTED instead of being silently
 *  dropped on round-trip. */
export function parseCheckLine(line: string): CheckEntry | null {
  const m =
    /^-\s+(?:([✓?])\s+)?(?:\[#([A-Za-z0-9._:-]{1,40})\]\s+)?(.+?)(?:\s+—\s+re-check:\s+(.+?))?(?:\s+—\s+evidence:\s+(.+?))?(?:\s+\(since\s+([^)]+)\))?\s*$/.exec(
      line,
    );
  if (!m) return null;
  const claim = (m[3] ?? '').trim();
  if (!claim) return null;
  const out: CheckEntry = { claim };
  const id = sanitizeCarryRowId(m[2]);
  if (id) out.id = id;
  const recheck = (m[4] ?? '').trim();
  if (recheck) out.recheck = recheck;
  const verified = (m[5] ?? '').trim();
  if (verified) out.verified = verified;
  if (m[6]) {
    const t = Date.parse(m[6]);
    if (Number.isFinite(t)) out.sinceMs = t;
  }
  return out;
}

/** Render structured fields into the canonical carry-note template (the shared
 *  SHAPE). Blank/omitted sections are skipped; returns '' when nothing is set (⇒ a
 *  clear when passed to {@link setCarryNote}). Checks render after the narrative
 *  sections; walls render last as parseable rows. */
export function renderCarryNote(fields: CarryNoteFields): string {
  const sections = CARRY_NOTE_SECTIONS.map(({ key, heading }) => {
    const v = (fields[key] ?? '').trim();
    return v.length > 0 ? `## ${heading}\n${v}` : null;
  }).filter((s): s is string => s !== null);
  const checks = (fields.checks ?? []).filter((c) => (c.claim ?? '').trim().length > 0);
  if (checks.length > 0) {
    sections.push(
      `## ${CARRY_NOTE_CHECKS_HEADING}\n${CARRY_NOTE_CHECKS_LEGEND}\n${checks.map(renderCheckLine).join('\n')}`,
    );
  }
  const walls = (fields.walls ?? []).filter((w) => (w.claim ?? '').trim().length > 0);
  if (walls.length > 0) {
    sections.push(`## ${CARRY_NOTE_WALLS_HEADING}\n${walls.map(renderWallLine).join('\n')}`);
  }
  return sections.join('\n\n');
}

/** Best-effort parse of a canonical carry-note (as produced by {@link renderCarryNote})
 *  back into fields — for inspection / loop:status rendering (P-008). A note with no
 *  recognized `## <Heading>` markers yields {} (the caller keeps the raw text). */
export function parseCarryNote(text: string): CarryNoteFields {
  const fields: CarryNoteFields = {};
  const byHeading = new Map<string, CarryNoteTextKey | 'walls' | 'checks'>(
    CARRY_NOTE_SECTIONS.map((s) => [s.heading.toLowerCase(), s.key] as const),
  );
  byHeading.set(CARRY_NOTE_WALLS_HEADING.toLowerCase(), 'walls');
  byHeading.set(CARRY_NOTE_CHECKS_HEADING.toLowerCase(), 'checks');
  // Split on lines that are exactly a known "## Heading".
  const lines = (text ?? '').split('\n');
  let cur: CarryNoteTextKey | 'walls' | 'checks' | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur === 'walls') {
      const walls = buf.map(parseWallLine).filter((w): w is WallEntry => w !== null);
      if (walls.length) fields.walls = walls;
    } else if (cur === 'checks') {
      const checks = buf.map(parseCheckLine).filter((c): c is CheckEntry => c !== null);
      if (checks.length) fields.checks = checks;
    } else if (cur) {
      const body = buf.join('\n').trim();
      if (body) fields[cur] = body;
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    const key = m ? byHeading.get(m[1].toLowerCase()) : undefined;
    if (key) {
      flush();
      cur = key;
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return fields;
}

// ── Rescue-by-parse of a tag-serialized structured write (EI-18833865002636933) ──
//
// This module never RENDERS an XML tag shape — `renderCarryNote` emits `## Heading`
// sections and nothing else. The vocabulary below exists ONLY to recognize a caller
// mistake seen live: an agent serialized its ENTIRE structured write as one tagged
// string into `did`, so the note reached the next cold wake as a single `## Did`
// section containing literal `</did><left>…<checks>[…]` text — demoting typed `checks`
// rows to inert JSON prose and losing the ✓/? badges that tell a successor which claims
// still need re-probing. The carry-note is a cold wake's ONLY continuity.
//
// We RESCUE rather than reject, following this surface's established precedent for
// "right content, wrong shape" (loop/checkpoint.ts's `checks` z.preprocess parses a
// JSON-string array instead of refusing the write). Refusing would have produced a
// FOURTH consecutive failed checkpoint in the live incident and possibly no note at all.

/** Sibling tags whose CLOSE form, alongside a literal `</did>`, completes the
 *  malformed-write signature. Deliberately strict: notes routinely quote code, JSX and
 *  shell, so a bare `<` — or a lone `</did>` — must never trigger a rewrite. */
const CARRY_NOTE_RESCUE_SIGNATURE = /<\/(?:left|insight|next|checks|walls)>/;

function taggedSection(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  const v = (m?.[1] ?? '').trim();
  return v.length > 0 ? v : undefined;
}

/** Recover row entries from a rescued `<checks>`/`<walls>` block, which an agent may
 *  have written either as a JSON array or as already-rendered rows. Anything else
 *  yields no rows — a malformed block degrades to "no rows", never a failed rescue. */
function taggedRows<T>(raw: string | undefined, parseLine: (line: string) => T | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const rows = parsed.filter(
        (r): r is T =>
          !!r && typeof r === 'object' && typeof (r as { claim?: unknown }).claim === 'string' &&
          (r as { claim: string }).claim.trim().length > 0,
      );
      if (rows.length > 0) return rows;
    }
  } catch {
    /* not JSON — fall through to the rendered-row form */
  }
  return raw.split('\n').map(parseLine).filter((r): r is T => r !== null);
}

/**
 * Recognize a `did` value that is really a whole structured note serialized as one
 * XML-tagged string, and split it back into typed {@link CarryNoteFields}.
 *
 * Returns `null` — meaning "store this verbatim, it is ordinary prose" — unless the
 * FULL signature is present: a literal `</did>` close tag AND at least one sibling
 * close tag. Both halves are required precisely because carry-notes quote code so
 * often; an over-eager matcher would silently mangle honest notes, which is a strictly
 * worse failure than the one being fixed.
 */
export function rescueTaggedCarryNoteBlob(blob: string | null | undefined): CarryNoteFields | null {
  const text = blob ?? '';
  const close = text.indexOf('</did>');
  if (close < 0 || !CARRY_NOTE_RESCUE_SIGNATURE.test(text)) return null;

  const fields: CarryNoteFields = {};
  const did = text.slice(0, close).replace(/^\s*<did>/, '').trim();
  if (did) fields.did = did;
  // NB: tag name ≠ heading name — CARRY_NOTE_SECTIONS maps insight → 'Key insight'
  // and next → 'Next action'. Drive off the KEYS here, never the headings.
  for (const { key } of CARRY_NOTE_SECTIONS) {
    if (key === 'did') continue;
    const v = taggedSection(text, key);
    if (v) fields[key] = v;
  }
  const checks = taggedRows(taggedSection(text, 'checks'), parseCheckLine);
  if (checks.length > 0) fields.checks = checks;
  const walls = taggedRows(taggedSection(text, 'walls'), parseWallLine);
  if (walls.length > 0) fields.walls = walls;
  return fields;
}

/** Shared row-section splitter: strip one `## <heading>` section of parseable rows
 *  out of a note, returning the remaining body + the parsed rows. Non-row lines
 *  inside the section (legend, prose) are dropped with it. */
function splitCarryNoteSection<T>(
  note: string | null | undefined,
  heading: string,
  parseLine: (line: string) => T | null,
): { body: string; rows: T[] } {
  const text = (note ?? '').trim();
  if (!text) return { body: '', rows: [] };
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
  const lines = text.split('\n');
  const bodyLines: string[] = [];
  const rows: T[] = [];
  let inSection = false;
  for (const line of lines) {
    if (headingRe.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) inSection = false; // a later section ends the block
    if (inSection) {
      const r = parseLine(line);
      if (r !== null) rows.push(r);
      continue; // non-row lines inside the section are dropped with it
    }
    bodyLines.push(line);
  }
  return { body: bodyLines.join('\n').trim(), rows };
}

/** Split a note into its walls rows and everything else (the `## Walls` section
 *  removed). The wake renderer needs walls SEPARATE from the truncatable note body
 *  (a wall clipped off the end of a capped note is a dissolved commitment), and the
 *  carry-forward merge needs the body without them. */
export function splitCarryNoteWalls(note: string | null | undefined): { body: string; walls: WallEntry[] } {
  const { body, rows } = splitCarryNoteSection(note, CARRY_NOTE_WALLS_HEADING, parseWallLine);
  return { body, walls: rows };
}

/** Split a note into its checks rows and everything else (the `## Checks` section
 *  removed) — the P-001 analog of {@link splitCarryNoteWalls}. */
export function splitCarryNoteChecks(note: string | null | undefined): { body: string; checks: CheckEntry[] } {
  const { body, rows } = splitCarryNoteSection(note, CARRY_NOTE_CHECKS_HEADING, parseCheckLine);
  return { body, checks: rows };
}

/** Re-attach a walls set to a note body (any existing `## Walls` in `body` is
 *  replaced). An empty walls set yields the bare body; a blank body with walls
 *  yields a walls-only note — commitments survive a careless note clear. */
export function withCarryNoteWalls(body: string, walls: WallEntry[]): string {
  const { body: stripped } = splitCarryNoteWalls(body);
  const kept = walls.filter((w) => (w.claim ?? '').trim().length > 0);
  if (kept.length === 0) return stripped;
  const section = `## ${CARRY_NOTE_WALLS_HEADING}\n${kept.map(renderWallLine).join('\n')}`;
  return stripped ? `${stripped}\n\n${section}` : section;
}

/** Normalize an incoming walls write against the prior set: trim + drop blank
 *  claims, dedup by claim, preserve the ORIGINAL sinceMs for a claim that already
 *  stood (age is evidence — a rewrite must not reset it), stamp `nowMs` on new
 *  ones, cap at {@link CARRY_NOTE_MAX_WALLS}. */
export function normalizeWallEntries(
  entries: ReadonlyArray<{ id?: string; claim: string; recheck?: string; sinceMs?: number }>,
  prior: ReadonlyArray<WallEntry>,
  nowMs: number = Date.now(),
): WallEntry[] {
  const priorByKey = new Map(prior.map((w) => [carryRowKey(w), w] as const));
  const seen = new Set<string>();
  const out: WallEntry[] = [];
  for (const e of entries) {
    const claim = (e.claim ?? '').trim();
    const key = carryRowKey(e);
    if (!claim || seen.has(key)) continue;
    seen.add(key);
    const existing = priorByKey.get(key);
    const id = sanitizeCarryRowId(e.id) ?? existing?.id;
    const recheck = (e.recheck ?? existing?.recheck ?? '').trim();
    out.push({
      ...(id ? { id } : {}),
      claim,
      ...(recheck ? { recheck } : {}),
      sinceMs: e.sinceMs ?? existing?.sinceMs ?? nowMs,
    });
    if (out.length >= CARRY_NOTE_MAX_WALLS) break;
  }
  return out;
}

/** Re-attach a checks set to a note body (any existing `## Checks` in `body` is
 *  replaced; the legend is always re-rendered). An empty checks set yields the bare
 *  body. Note: unlike walls, checks sit BEFORE any `## Walls` section so walls keep
 *  their established last-position anchor. */
export function withCarryNoteChecks(body: string, checks: CheckEntry[]): string {
  const { body: strippedAll, walls } = splitCarryNoteWalls(splitCarryNoteChecks(body).body);
  const kept = checks.filter((c) => (c.claim ?? '').trim().length > 0);
  const parts: string[] = [];
  if (strippedAll) parts.push(strippedAll);
  if (kept.length > 0) {
    parts.push(`## ${CARRY_NOTE_CHECKS_HEADING}\n${CARRY_NOTE_CHECKS_LEGEND}\n${kept.map(renderCheckLine).join('\n')}`);
  }
  if (walls.length > 0) {
    parts.push(`## ${CARRY_NOTE_WALLS_HEADING}\n${walls.map(renderWallLine).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Normalize an incoming checks write against the prior set — same contract as
 *  {@link normalizeWallEntries}: trim + drop blank claims, dedup by claim, preserve
 *  the ORIGINAL sinceMs for a claim that already stood, inherit recheck/verified
 *  from the prior row when omitted (a re-write must not silently drop evidence),
 *  stamp `nowMs` on new ones, cap at {@link CARRY_NOTE_MAX_CHECKS}. */
export function normalizeCheckEntries(
  entries: ReadonlyArray<{ id?: string; claim: string; recheck?: string; verified?: string; sinceMs?: number }>,
  prior: ReadonlyArray<CheckEntry>,
  nowMs: number = Date.now(),
): CheckEntry[] {
  const priorByKey = new Map(prior.map((c) => [carryRowKey(c), c] as const));
  const seen = new Set<string>();
  const out: CheckEntry[] = [];
  for (const e of entries) {
    const claim = (e.claim ?? '').trim();
    const key = carryRowKey(e);
    if (!claim || seen.has(key)) continue;
    seen.add(key);
    const existing = priorByKey.get(key);
    const id = sanitizeCarryRowId(e.id) ?? existing?.id;
    const recheck = (e.recheck ?? existing?.recheck ?? '').trim();
    let verified = (e.verified ?? existing?.verified ?? '').trim();
    // Review fold #5: evidence never goes stale SILENTLY — stamp the verification
    // instant into the evidence text when it is NEWLY supplied (inherited evidence
    // keeps its original stamp), so a ✓ observed 20 wakes ago visibly carries its
    // age instead of rendering with fresh-evidence authority.
    const newlySupplied = Boolean((e.verified ?? '').trim()) && (e.verified ?? '').trim() !== (existing?.verified ?? '').trim();
    if (verified && newlySupplied && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(verified)) {
      verified = `${verified} @${new Date(nowMs).toISOString()}`;
    }
    out.push({
      ...(id ? { id } : {}),
      claim,
      ...(recheck ? { recheck } : {}),
      ...(verified ? { verified } : {}),
      sinceMs: e.sinceMs ?? existing?.sinceMs ?? nowMs,
    });
    if (out.length >= CARRY_NOTE_MAX_CHECKS) break;
  }
  return out;
}

/**
 * WI-6813: the walls+checks merge, extracted PURE so it can run INSIDE
 * {@link setCarryNoteWithPrior}'s locked transaction (via its `transform` seam)
 * instead of as a caller-side read → merge → write. That caller-side shape has a
 * genuine race: between the prior read and the write, a concurrent writer on the
 * same scope can land, and the merge then silently clobbers their rows.
 *
 * Semantics — IDENTICAL for both row kinds, deliberately: an EXPLICIT arg wins
 * outright (its `[]` is the only true clear) → else the raw note's own rendered
 * section wins → else the PRIOR rows carry forward, across rewrites AND across a
 * note clear. A rows-only write likewise carries the prior narrative body forward.
 *
 * ⚠ THE CLEAR BEHAVIOUR IS A DELIBERATE DIVERGENCE from work_items:checkpoint —
 * do not harmonise them. A LOOP's rows SURVIVE a note clear (the note persists as
 * walls/checks-only and renders every wake until explicitly `[]`-ed); WORK-ITEM
 * rows are WIPED on clear, so `work_items:complete`'s terminal cleanup cannot
 * resurrect a checks-only checkpoint on a closed item. Both are intentional and
 * tested on their own side. Copying the work-item rule here would silently drop
 * owner-gated WALLS — precisely the failure walls exist to prevent.
 *
 * EI-19463731740128181: an EXPLICIT list REPLACES — {@link normalizeCheckEntries}
 * and {@link normalizeWallEntries} iterate the INCOMING rows only, using `prior`
 * solely to inherit recheck/verified/sinceMs onto claims that reappear. A carried
 * claim the caller leaves out is therefore DROPPED. That is defensible as semantics
 * (it is the only way to retire a stale row) but it was SILENT here: the reply
 * reported a post-merge COUNT and nothing else, so adding one row to a carried set —
 * the single most natural use of the parameter, and what the `checksLint` advisory
 * actively tells you to do — destroyed the rest behind an `ok: true`. `droppedWalls`
 * / `droppedChecks` make the loss VISIBLE so it is never inferable only by diffing a
 * count you would have had to record beforehand. Mirrors the `checksDropped` report
 * work_items:checkpoint landed for the identical defect (EI-19460631385508515).
 *
 * P-013 (fleet-lead-instrumentation-audit-2026-08-09): making the loss visible was
 * necessary but NOT sufficient — the report lands AFTER the write, so the rows are
 * already gone by the time you read it. Two additions make the loss AVOIDABLE:
 *
 *  1. `mode: 'merge'` — supplied rows upsert onto the carried set; unmentioned rows
 *     survive. The natural "add one row to my carried set" write stops being
 *     destructive. `replace` remains the default (it is the only way to retire a row).
 *  2. A row `id` — identity independent of WORDING (see {@link carryRowKey}). Without
 *     it, tightening a claim's phrasing makes it a NEW row: it loses the evidence and
 *     `sinceMs` it had inherited, and the old wording reads to the drop-report as a
 *     carried claim that vanished. Both were observed live, twice.
 */
export function mergeCarryRows(opts: {
  /** The AUTHORITATIVE prior note. Inside a `transform` this is the locked row's. */
  priorNote: string | null | undefined;
  /** The note this write proposes (rendered structured fields, or the raw string). */
  baseNote: string | null | undefined;
  /** An EXPLICIT walls arg — `[]` clears; `undefined` defers to the note/prior. */
  walls?: ReadonlyArray<{ id?: string; claim: string; recheck?: string; sinceMs?: number }>;
  /** An EXPLICIT checks arg — `[]` clears; `undefined` defers to the note/prior. */
  checks?: ReadonlyArray<{ id?: string; claim: string; recheck?: string; verified?: string; sinceMs?: number }>;
  /** Whether this call writes a narrative at all (structured fields or a raw note). */
  hasNoteWrite: boolean;
  /**
   * P-013 — how a supplied row list combines with the carried set.
   *
   * `'replace'` (DEFAULT, unchanged semantics): the supplied list IS the new set;
   * carried rows it omits are dropped. The only way to retire a stale row, which is
   * why it stays the default.
   *
   * `'merge'`: supplied rows UPSERT onto the carried set by {@link carryRowKey} —
   * carried rows the caller did not mention SURVIVE. Turns "add one row" from a
   * destructive write into an additive one. Under merge a `[]` list is a NO-OP, not
   * a clear: clearing requires `'replace'`, so a clear is always deliberate.
   */
  mode?: 'replace' | 'merge';
  nowMs?: number;
}): {
  note: string;
  narrativeBody: string;
  walls: WallEntry[];
  checks: CheckEntry[];
  /** Prior WALL claims this write did not carry forward (see the EI-19463731740128181
   *  note above). Empty when nothing was lost — including the carry-forward path,
   *  where `undefined` preserves every prior row by construction. */
  droppedWalls: string[];
  /** Prior CHECK claims this write did not carry forward. Same contract as
   *  {@link droppedWalls}. */
  droppedChecks: string[];
  /**
   * P-013 — SUPPLIED rows that did not make it into the stored set, i.e. the row cap
   * cut them. The mirror image of `droppedChecks`/`droppedWalls`, which report rows
   * lost from the PRIOR set and therefore cannot see this: a caller who sends 13 rows
   * into a 12-row cap silently loses the 13th.
   *
   * Pre-existing (the cap always worked this way), but `mode:'merge'` makes it far
   * likelier to fire — carried rows hold their slots, so it is the caller's NEW row
   * that falls off the end. Shipping a merge mode that silently eats new rows would
   * re-create, on the additive path, the very silence the mode exists to remove.
   */
  overflowWalls: string[];
  /** Supplied CHECK claims the row cap cut. Same contract as {@link overflowWalls}. */
  overflowChecks: string[];
} {
  const priorParts = splitCarryNoteWalls(opts.priorNote ?? null);
  const priorCheckParts = splitCarryNoteChecks(priorParts.body);
  const rawParts = splitCarryNoteWalls(opts.baseNote ?? '');
  const rawCheckParts = splitCarryNoteChecks(rawParts.body);
  const merging = opts.mode === 'merge';
  /** What the CALLER actually offered this write, before the merge pre-pass folds the
   *  prior set in — the only list against which "your row did not fit" is decidable. */
  const suppliedWalls = opts.walls ?? (rawParts.walls.length > 0 ? rawParts.walls : undefined);
  const suppliedChecks = opts.checks ?? (rawCheckParts.checks.length > 0 ? rawCheckParts.checks : undefined);
  const walls =
    opts.walls !== undefined
      ? normalizeWallEntries(upsertOntoPrior(opts.walls, priorParts.walls, merging), priorParts.walls, opts.nowMs)
      : rawParts.walls.length > 0
        ? normalizeWallEntries(
            upsertOntoPrior(rawParts.walls, priorParts.walls, merging),
            priorParts.walls,
            opts.nowMs,
          )
        : priorParts.walls;
  const checks =
    opts.checks !== undefined
      ? normalizeCheckEntries(
          upsertOntoPrior(opts.checks, priorCheckParts.checks, merging),
          priorCheckParts.checks,
          opts.nowMs,
        )
      : rawCheckParts.checks.length > 0
        ? normalizeCheckEntries(
            upsertOntoPrior(rawCheckParts.checks, priorCheckParts.checks, merging),
            priorCheckParts.checks,
            opts.nowMs,
          )
        : priorCheckParts.checks;
  const narrativeBody = opts.hasNoteWrite ? rawCheckParts.body : priorCheckParts.body;
  return {
    note: withCarryNoteWalls(withCarryNoteChecks(narrativeBody, checks), walls),
    narrativeBody,
    walls,
    checks,
    droppedWalls: droppedClaims(priorParts.walls, walls),
    droppedChecks: droppedClaims(priorCheckParts.checks, checks),
    overflowWalls: suppliedWalls ? droppedClaims(suppliedWalls, walls) : [],
    overflowChecks: suppliedChecks ? droppedClaims(suppliedChecks, checks) : [],
  };
}

/**
 * P-013 merge pre-pass: expand a supplied row list to include the carried rows it did
 * not mention, so the normalizer downstream is unchanged — it still sees ONE incoming
 * list and applies dedup, inheritance and the cap exactly once.
 *
 * Order is deliberate: an upserted row keeps its PRIOR position and genuinely-new rows
 * append, so a merge does not reshuffle a note the author reads every wake. Under
 * `replace` (or an empty prior) this is the identity function.
 *
 * Note the cap still applies afterwards — a merge that overflows
 * {@link CARRY_NOTE_MAX_CHECKS} loses the overflow, and those rows surface through the
 * ordinary `droppedChecks` report rather than vanishing.
 */
function upsertOntoPrior<T extends { id?: string; claim: string }>(
  supplied: ReadonlyArray<T>,
  prior: ReadonlyArray<{ id?: string; claim: string }>,
  merging: boolean,
): ReadonlyArray<T | { id?: string; claim: string }> {
  if (!merging || prior.length === 0) return supplied;
  const suppliedByKey = new Map(supplied.map((r) => [carryRowKey(r), r] as const));
  const out: Array<T | { id?: string; claim: string }> = [];
  const used = new Set<string>();
  for (const p of prior) {
    const key = carryRowKey(p);
    const replacement = suppliedByKey.get(key);
    if (replacement) used.add(key);
    out.push(replacement ?? p);
  }
  for (const s of supplied) {
    if (!used.has(carryRowKey(s))) out.push(s);
  }
  return out;
}

/** Prior claims absent from the surviving set, compared on the SAME {@link carryRowKey}
 *  the normalizers dedup by — so a row that merely changed its recheck/evidence, was
 *  re-passed with surrounding whitespace, or (P-013) was RE-WORDED under a stable `id`
 *  never reads as dropped. The reported string is still the human-readable claim, since
 *  that is what a caller needs to re-send. Blank prior claims are ignored: they can never
 *  be re-passed (the normalizers skip them), so counting them would report a permanent
 *  phantom loss on every write. */
function droppedClaims(
  prior: ReadonlyArray<{ id?: string; claim: string }>,
  kept: ReadonlyArray<{ id?: string; claim: string }>,
): string[] {
  const keptKeys = new Set(kept.map((r) => carryRowKey(r)));
  return prior
    .filter((r) => (r.claim ?? '').trim().length > 0 && !keptKeys.has(carryRowKey(r)))
    .map((r) => (r.claim ?? '').trim());
}

// ── External-state-claim lint (P-009) ────────────────────────────────────────

const CLAIM_ASSERTION_RE = /\b(MUST|expects?|alarm if|will\s+(?:roll|change|move|land)|anchor(?:ed)?\s+on)\b/i;
const CLAIM_TOKEN_RES: ReadonlyArray<RegExp> = [
  // content-hash / sha-like: ≥8 hex with at least one letter (review fold #4 — this
  // fleet habitually quotes 10-char short-shas; the letter requirement keeps plain
  // numbers like "12345678" from reading as hashes).
  /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,40}\b/gi,
  /\b(?:WI|EI|F)-\d+\b/g, // work-item / insight ids
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g, // ISO timestamps
];

/** Review fold #1: external-state NOUNS. The motivating incident line — "expect the
 *  hash to ROLL, count under the new hash" — carries an assertion verb but NO concrete
 *  token, so a token-only lint skips its own root incident. A noun names the external
 *  state being asserted about; coverage then means a check/wall row mentions the same
 *  noun. */
const CLAIM_NOUN_RE = /\b(hash|sha|generation|watermark|anchor|floor|denominator|tick)\b/gi;

/** Advisory lint (cold-carry-system-hardening-2026-07-19 P-009): find prose lines that
 *  ASSERT external state — assertion verb + a distinctive token (hash, WI/EI id, ISO
 *  instant) OR an external-state noun — where NONE of those appear in any check/wall
 *  row. Such a line is a carried claim with no probe — the exact shape of the
 *  phantom-re-anchor incident ("expect the hash to ROLL" with no tick_at-vs-restart
 *  check). Returns the flagged lines (clipped, max 3); never blocks a write. */
export function lintUncheckedExternalClaims(prose: string, probeText: string): string[] {
  const flagged: string[] = [];
  const probes = probeText.toLowerCase();
  for (const rawLine of (prose ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || !CLAIM_ASSERTION_RE.test(line)) continue;
    const tokens: string[] = [];
    for (const re of CLAIM_TOKEN_RES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) tokens.push(m[0]);
    }
    if (tokens.length === 0) {
      // #1: no concrete token — fall back to external-state nouns.
      CLAIM_NOUN_RE.lastIndex = 0;
      for (const m of line.matchAll(CLAIM_NOUN_RE)) tokens.push(m[0]);
    }
    if (tokens.length === 0) continue;
    const covered = tokens.some((t) => probes.includes(t.toLowerCase()));
    if (!covered) {
      flagged.push(line.length > 160 ? `${line.slice(0, 157)}…` : line);
      if (flagged.length >= 3) break;
    }
  }
  return flagged;
}

// ── The journal ring (lifted verbatim from hive/wake.ts — the Queen's L1a
//    trajectory ring, now the shared default; wake.ts re-exports these) ────────

/** Carry-journal ring bounds (L1a): entries kept, per-note chars, total chars. */
export const CARRY_JOURNAL_MAX_ENTRIES = 15;
export const CARRY_JOURNAL_NOTE_MAX_CHARS = 600;
export const CARRY_JOURNAL_TOTAL_MAX_CHARS = 6_000;

export interface CarryJournalEntry {
  at: number;
  note: string;
}

/** Normalize a `journal` jsonb column read from PG. Depending on the pg client's
 *  type-parser config, a jsonb column comes back either already-parsed (a JS
 *  array) or as the raw JSON text — accept both, and any other shape degrades to
 *  an empty ring rather than spreading a string into characters. */
function normalizeJournal(v: unknown): CarryJournalEntry[] {
  if (!v) return [];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as CarryJournalEntry[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as CarryJournalEntry[]) : [];
}

/**
 * PURE (L1a): append a note to a carry-journal ring, enforcing all three bounds
 * (entry count, per-note chars, total chars — oldest dropped first). A blank note
 * appends nothing (returns the input unchanged).
 */
export function appendCarryJournal(
  journal: ReadonlyArray<CarryJournalEntry> | undefined,
  note: string,
  at: number,
): CarryJournalEntry[] {
  const trimmed = note.trim();
  const cur = [...(journal ?? [])];
  if (!trimmed) return cur;
  cur.push({ at, note: trimmed.slice(0, CARRY_JOURNAL_NOTE_MAX_CHARS) });
  while (cur.length > CARRY_JOURNAL_MAX_ENTRIES) cur.shift();
  let total = cur.reduce((n, e) => n + e.note.length, 0);
  while (total > CARRY_JOURNAL_TOTAL_MAX_CHARS && cur.length > 1) {
    const dropped = cur.shift();
    total -= dropped ? dropped.note.length : 0;
  }
  return cur;
}

// ── The durable store ────────────────────────────────────────────────────────

export interface CarryNoteRef {
  scope: string;
  /** Defaults to the active workspace (the owner install). */
  workspaceId?: string;
}

function resolveRef(ref: CarryNoteRef | string): { ws: string; scope: string } {
  const scope = typeof ref === 'string' ? ref : ref.scope;
  // WI-3648 (same bug class as EI-8824/EI-3409/WI-892): canonicalize through
  // resolveConcreteWorkspaceId, not a bare `?? activeWorkspaceId()`. A bare
  // fallback only fires on null/undefined — it lets a TRUTHY '*' (the
  // unscoped-superuser read-scoping wildcard, e.g. carry-brief.ts's
  // readHeldWorkItems → getWorkItemCheckpoint passing ctx.workspaceId straight
  // through) win outright, so a superuser session's checkpoint READ keyed
  // under the literal workspace_id='*' while EI-8824 already made every WRITE
  // (work_items:checkpoint) resolve to the concrete activeWorkspaceId() — the
  // write/read mismatch silently orphaned the checkpoint (observed live: a
  // 01:47Z write reported ok, but a ~01:49Z post-compaction read returned the
  // stale pre-EI-8824 '*'-keyed row instead). Canonicalizing HERE, in the one
  // shared resolveRef both setCarryNote and getCarryNote funnel through, closes
  // the gap for every current AND future caller — not just the write path.
  const ws = resolveConcreteWorkspaceId(typeof ref === 'string' ? undefined : ref.workspaceId);
  if (!ws) throw new Error('carry-note — no active workspace to scope the carry-note to');
  if (!scope) throw new Error('carry-note — a scope is required');
  return { ws, scope };
}

/**
 * Write (or clear) a carry-note. D-003 semantics: a non-blank string REPLACES
 * `note`; blank/null/undefined CLEARS `note`. Returns the stored note (trimmed)
 * or null when cleared. Read-modify-writes in one transaction.
 *
 * Journaling (default ON — the Queen/loop trajectory ring): a non-blank write
 * APPENDS a capped entry to the `journal` ring so the reasoning trajectory
 * survives a clear (a cleared note keeps its row while the journal is non-empty).
 * Pass `{ journal: false }` for a pure note (the bee checkpoint) — no ring, and a
 * clear DELETES the row (graceful degradation: the next read re-derives from the
 * floor). A scope always uses the same journaling mode.
 */
export async function setCarryNote(
  ref: CarryNoteRef | string,
  note: string | null | undefined,
  opts?: { journal?: boolean },
): Promise<string | null> {
  return (await setCarryNoteWithPrior(ref, note, opts)).stored;
}

/** The prior note's length alongside the write result — EI-9325: the row is
 *  already locked + read (for the journal ring) inside {@link setCarryNoteWithPrior}'s
 *  transaction, so surfacing the PRIOR note's length here is free (no extra
 *  round-trip). Lets a caller warn (never block) on a suspicious shrink — a
 *  replace-on-write dramatically shorter than what was there before usually means
 *  an accidental placeholder/truncated paste, not an intentional rewrite. */
export interface SetCarryNoteResult {
  stored: string | null;
  /** chars in the PRIOR note before this write replaced it (0 if none existed). */
  priorLength: number;
  /** EI-18140632570924965: present when a caller-supplied `guard` blocked this
   *  write — the write did NOT happen (no DELETE/INSERT ran); `stored` echoes the
   *  UNCHANGED prior note instead of the would-be new one. */
  blockedReason?: string;
  /** P-007/D-013: the raw `deps` payload this write REPLACED, so a caller can tell
   *  what the previous note declared without a second read. `null` when the prior
   *  note declared nothing. */
  priorDeps?: unknown;
}

/** Same semantics as {@link setCarryNote}, plus the prior note's length (EI-9325) —
 *  free, since the row is already SELECTed FOR UPDATE to build the journal ring.
 *
 *  EI-18140632570924965: an optional `guard` runs INSIDE the same locked
 *  transaction, given the prior note + its length, and may return a block reason
 *  to abort the write entirely (no DELETE/INSERT) instead of a race-prone
 *  read-then-decide-then-write pattern at the caller. Absent for the overwhelming
 *  common case — every existing caller is unaffected. */
export async function setCarryNoteWithPrior(
  ref: CarryNoteRef | string,
  note: string | null | undefined,
  opts?: {
    journal?: boolean;
    guard?: (priorNote: string | null, priorLength: number) => string | null;
    /**
     * P-007/D-013 declared-dependency freshness stamps for the note being written.
     * Tri-state on purpose:
     *   `undefined` ⇒ PRESERVE whatever the row already declared (so a plain
     *      re-write or an append does not silently drop a declaration and with it
     *      the note's only non-guessed freshness signal);
     *   `null`      ⇒ CLEAR the declaration (explicitly undeclared);
     *   an object   ⇒ REPLACE it.
     * The caller resolves + stamps the tokens; this layer only persists them.
     */
    deps?: unknown;
    /**
     * EI-19298690705878336: MERGE the incoming note against the prior one before it
     * is journaled and stored — the seam that lets a caller carry `## Checks` /
     * `## Walls` rows forward so a plain replace cannot silently drop a claim's
     * verification probe.
     *
     * Why here rather than in the caller: the caller would have to read the note,
     * merge, then write — a read-then-write with a genuine race against a
     * concurrent writer on the same scope. This row is ALREADY `SELECT ... FOR
     * UPDATE`ed a few lines above, so a merge performed here is atomic with the
     * write and costs no extra round-trip.
     *
     * Runs AFTER `guard`, so a blocked write never transforms. Returning
     * null/blank still means CLEAR, exactly as passing a blank `note` does.
     */
    transform?: (priorNote: string | null, note: string | null | undefined) => string | null | undefined;
  },
): Promise<SetCarryNoteResult> {
  const journalEnabled = opts?.journal ?? true;
  const { ws, scope } = resolveRef(ref);
  const { sql } = getOrgPg();
  const now = Date.now();
  const depsSpecified = opts !== undefined && 'deps' in opts;
  return (await sql.begin(async (tx) => {
    const rows = await tx<{ journal: unknown; note: string | null; deps: unknown }[]>`
      SELECT journal, note, deps FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope} FOR UPDATE`;
    const prevJournal = normalizeJournal(rows[0]?.journal);
    const priorNote = rows[0]?.note ?? null;
    const priorDeps = rows[0]?.deps ?? null;
    const priorLength = (priorNote ?? '').length;
    if (opts?.guard) {
      const blockedReason = opts.guard(priorNote, priorLength);
      if (blockedReason) return { stored: priorNote, priorLength, blockedReason, priorDeps };
    }
    // The merge seam (see `transform`). Deliberately AFTER the guard — a blocked
    // write must not transform — and BEFORE journaling, so the ring records what was
    // actually stored rather than the caller's pre-merge draft.
    const effectiveNote = opts?.transform ? opts.transform(priorNote, note) : note;
    const trimmed = (effectiveNote ?? '').trim();
    // journaling ON: append (blank ⇒ unchanged ring); OFF: never keep a ring.
    const journal = journalEnabled ? appendCarryJournal(prevJournal, trimmed, now) : [];
    const noteCol = trimmed.length > 0 ? trimmed : null;
    // Unspecified ⇒ carry the prior declaration forward (see the `deps` opt doc).
    const depsCol = depsSpecified ? (opts?.deps ?? null) : priorDeps;

    if (noteCol === null && journal.length === 0) {
      // Nothing to store (cleared with no surviving journal) — delete the row.
      await tx`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${ws} AND scope = ${scope}`;
      return { stored: null, priorLength, priorDeps };
    }
    // jsonb bound as ${json}::text::jsonb — sql.json() throws on the org pool
    // (agent-insights/postgres-js-jsonb-binding).
    await tx`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts, deps)
      VALUES (${ws}, ${scope}, ${noteCol}, ${JSON.stringify(journal)}::text::jsonb, ${now},
              ${depsCol === null ? null : JSON.stringify(depsCol)}::text::jsonb)
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET note = EXCLUDED.note, journal = EXCLUDED.journal, updated_ts = EXCLUDED.updated_ts,
            deps = EXCLUDED.deps`;
    return { stored: noteCol, priorLength, priorDeps };
  })) as SetCarryNoteResult;
}

/** Read the current carry-note (the full `note` column), or null when none/cleared. */
export async function getCarryNote(ref: CarryNoteRef | string): Promise<string | null> {
  let ws: string, scope: string;
  try {
    ({ ws, scope } = resolveRef(ref));
  } catch {
    return null;
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ note: string | null }[]>`
    SELECT note FROM harness_shared.carry_notes
     WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`;
  const note = (rows[0]?.note ?? '').trim();
  return note.length > 0 ? note : null;
}

/** Read the carry-journal ring, NEWEST FIRST (the Queen brief renderer's input,
 *  generalized). Empty array when none. */
export async function getCarryJournal(ref: CarryNoteRef | string): Promise<CarryJournalEntry[]> {
  let ws: string, scope: string;
  try {
    ({ ws, scope } = resolveRef(ref));
  } catch {
    return [];
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ journal: unknown }[]>`
    SELECT journal FROM harness_shared.carry_notes
     WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`;
  return [...normalizeJournal(rows[0]?.journal)].reverse();
}

// ── su-loop carry-note (P-002) — the SU AUTO loop's cold-wake anchor ──────────
//
// The su loop's slice of the substrate. Keyed by the owner id the loop wakes
// (loopScope), which is STABLE across a fresh-context RESET and a RECYCLE
// (PAPERCUSP_SID preserved — P-004), so a cold wake reads the SAME carry-note the
// warm session left. Journaling ON (like the Queen): the loop's recent trajectory
// (did/left/insight/next across wakes) survives, which a cold successor reads.
//
// The Phase-2 psu-host RESET-CONTEXT (P-004) captures the compaction summary the
// agent ALREADY writes at a clean turn-boundary into this note (no new agent
// behavior, P-002) and re-injects it as the cold session's opening context.

export interface LoopCarryNoteRef {
  harness: string;
  /** The coord ownerId the loop wakes (loop:arm target_owner_id). */
  ownerId: string;
  /** IGNORED for the loop scope since 2026-07-03 (kept for call-site compat): the
   *  loop carry-note is PINNED to the coord workspace — see loopCarryWs(). */
  workspaceId?: string;
}

/**
 * The ONE workspace the loop carry-note lives in — pinned to the coord workspace,
 * because the loop's whole lifecycle (arm → routine fire → wake delivery → cold
 * decision) rides the coord/events subsystem, which is itself pinned to
 * DEFAULT_COORD_WORKSPACE (events/await/store.ts `eventsWs`). Before this pin the
 * PRODUCER (loop:checkpoint, keyed by the MCP caller's ctx.workspaceId, e.g.
 * 'papercusp-workspace') and the CONSUMER (the wake executor, keyed by the
 * delivery row's ws = 'default') addressed DIFFERENT rows for the same scope —
 * the anchor was never found and every cold wake fail-safed to WARM (the
 * 2026-07-03 live-test bug, round 2). The scope string (loop:<harness>:<ownerId>)
 * is globally unique (ownerId is a session uuid), so a single pinned namespace
 * cannot collide across workspaces.
 */
function loopCarryWs(): string {
  return DEFAULT_COORD_WORKSPACE;
}

/** Write (or clear) an su AUTO loop's carry-note. Delegates to the shared
 *  substrate under {@link loopScope}, PINNED to the coord workspace (see
 *  {@link loopCarryWs}) so the producer and the wake-executor consumer address
 *  the same row no matter which host/ctx they run under. */
export async function setLoopCarryNote(
  ref: LoopCarryNoteRef,
  note: string | null | undefined,
): Promise<string | null> {
  const stored = await setCarryNote(
    { scope: loopScope(ref.harness, ref.ownerId), workspaceId: loopCarryWs() },
    note,
  );
  await notifyAgentOrdersChanged(ref.ownerId);
  return stored;
}

/** {@link setLoopCarryNote} with access to the PRIOR note — the write path a caller
 *  needs when its note must be MERGED against what is already stored (the P-006
 *  walls / P-001 checks rows) rather than plainly replacing it.
 *
 *  WI-6813: pass `transform` (with {@link mergeCarryRows}) and the merge runs inside
 *  the row's `SELECT ... FOR UPDATE` transaction — atomic with the write, one fewer
 *  round-trip, and it CANNOT clobber a concurrent writer on the same scope the way a
 *  caller-side read → merge → write can. Pinned to the same coord workspace as
 *  {@link setLoopCarryNote} so producer and wake-executor address the same row. */
export async function setLoopCarryNoteWithPrior(
  ref: LoopCarryNoteRef,
  note: string | null | undefined,
  opts?: Parameters<typeof setCarryNoteWithPrior>[2],
): Promise<SetCarryNoteResult> {
  const result = await setCarryNoteWithPrior(
    { scope: loopScope(ref.harness, ref.ownerId), workspaceId: loopCarryWs() },
    note,
    opts,
  );
  // WI-6974: the loop carry-note (note + walls + checks) is Orders-panel content,
  // and this ref carries the ownerId the panel is keyed by — so the push is exact.
  // A `guard`-BLOCKED write wrote nothing, so it must not push: `blockedReason` is
  // the producer-side signal a carry_notes row trigger could not have seen.
  if (!result.blockedReason) await notifyAgentOrdersChanged(ref.ownerId);
  return result;
}

/** Read an su AUTO loop's current carry-note (the full note), or null when none.
 *  Reads the pinned coord workspace first; on a miss, FALLS BACK to the newest
 *  row for the scope in ANY workspace — a note written by a not-yet-redeployed
 *  host still running the old ctx-workspace keying (host-version skew is real:
 *  the :3070 release, the bg-host and psu sessions restart at different times,
 *  and this exact skew is what broke cold-auto twice on 2026-07-03). */
export async function getLoopCarryNote(ref: LoopCarryNoteRef): Promise<string | null> {
  const scope = loopScope(ref.harness, ref.ownerId);
  const pinned = await getCarryNote({ scope, workspaceId: loopCarryWs() });
  if (pinned != null) return pinned;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ note: string | null }[]>`
      SELECT note FROM harness_shared.carry_notes
       WHERE scope = ${scope} AND note IS NOT NULL
       ORDER BY updated_ts DESC LIMIT 1`;
    const note = (rows[0]?.note ?? '').trim();
    return note.length > 0 ? note : null;
  } catch {
    return null;
  }
}

/** A loop carry-note plus its write instant — the staleness input the wake
 *  renderer needs (compaction-continuity-hardening-2026-07-07 P-002): a note is
 *  only trustworthy relative to WHEN it was written, so the fire path reads both
 *  in one query instead of the note alone. */
export interface LoopCarryNoteWithMeta {
  note: string | null;
  /** Epoch ms of the note's last write (carry_notes.updated_ts), null when no note. */
  updatedAtMs: number | null;
}

/** Read an su AUTO loop's carry-note WITH its write instant. Same pinned-then-
 *  any-workspace precedence as {@link getLoopCarryNote}, collapsed to one query
 *  (the pinned coord-workspace row wins; else the newest row for the scope). */
export async function getLoopCarryNoteWithMeta(ref: LoopCarryNoteRef): Promise<LoopCarryNoteWithMeta> {
  const scope = loopScope(ref.harness, ref.ownerId);
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ note: string | null; updated_ts: string | number | null }[]>`
      SELECT note, updated_ts FROM harness_shared.carry_notes
       WHERE scope = ${scope} AND note IS NOT NULL
       ORDER BY (workspace_id = ${loopCarryWs()}) DESC, updated_ts DESC LIMIT 1`;
    const note = (rows[0]?.note ?? '').trim();
    if (note.length === 0) return { note: null, updatedAtMs: null };
    const ts = rows[0]?.updated_ts == null ? NaN : Number(rows[0].updated_ts);
    return { note, updatedAtMs: Number.isFinite(ts) ? ts : null };
  } catch {
    return { note: null, updatedAtMs: null };
  }
}

/** Read an su AUTO loop's carry-JOURNAL (newest first) — its recent trajectory.
 *  Same pinned-then-any-workspace resolution as {@link getLoopCarryNote}. */
export async function getLoopCarryJournal(ref: LoopCarryNoteRef): Promise<CarryJournalEntry[]> {
  const scope = loopScope(ref.harness, ref.ownerId);
  const pinned = await getCarryJournal({ scope, workspaceId: loopCarryWs() });
  if (pinned.length > 0) return pinned;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ journal: unknown }[]>`
      SELECT journal FROM harness_shared.carry_notes
       WHERE scope = ${scope}
       ORDER BY updated_ts DESC LIMIT 1`;
    return [...normalizeJournal(rows[0]?.journal)].reverse();
  } catch {
    return [];
  }
}
