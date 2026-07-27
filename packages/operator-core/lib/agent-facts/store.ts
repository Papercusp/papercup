/**
 * agent-facts store — the generalized STANDING-FACTS ledger
 * (queen-memory-hybrid-2026-07-02 L1b; owner-approved 2026-07-02).
 *
 * A fact is a deterministic, scoped, TTL'd CONCLUSION an agent asserts so it is
 * folded VERBATIM into future briefs/dossiers/orients. It fills the gap none of
 * the other memory surfaces cover:
 *   • mem0 (`memory:*`)        — fuzzy semantic recall; may or may not surface.
 *   • agent-insights docs      — long-form how-it-works runbooks.
 *   • work-item checkpoints    — task-scoped in-flight progress.
 *   • queen carry-journal      — per-wake reasoning trajectory.
 * A fact WILL appear in every relevant fold until it expires or is retracted —
 * "WI-1439 is owner-residue, exclude it" must never depend on embedding
 * similarity (the Queen re-derived exactly that ~6 consecutive wakes,
 * 2026-07-02, before this existed).
 *
 * Scoping (owner amendment D-001: harness/work_item OPTIONAL):
 *   workspace (ref NULL) | role | owner | harness | work_item.
 * Upsert identity: (workspace, scope, coalesce(ref,''), key). Soft-retract.
 * Hygiene: mandatory TTL (default 7d), per-scope cap (LRU-ish: oldest-updated
 * evicted on overflow), expiry sweep on the routines tick.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { InvalidInputError } from '@papercusp/tooldef';
import { activeWorkspaceId } from '../workspace-registry';
// P-008 (b): the unknown vocabulary a failed dependency read records. Imported,
// never re-declared — cell-contract.ts declares itself the canonical home and
// forbids a local copy, and a second enumeration is precisely how a caller's
// branch set silently diverges from the contract it thinks it implements.
import type { CellUnknownCode } from '../cell-contract';

export const FACT_SCOPES = ['workspace', 'role', 'owner', 'harness', 'work_item'] as const;
export type FactScope = (typeof FACT_SCOPES)[number];

/**
 * EI-18681964809855890 (owner-filed 2026-07-26): a fact's EVIDENCE STRENGTH —
 * orthogonal to `scope` (what it's about) the same way `audienceScope` is
 * orthogonal to who receives it. `facts:assert` used to render a peer's single
 * unreplicated run at IDENTICAL authority to a verified, replicated
 * measurement — this is the dimension that was missing. NULL (unset) is the
 * legacy/default shape and renders exactly as before (no badge) —
 * fully backward compatible; only an explicit 'provisional'/'suspected'/
 * 'verified' changes fold rendering + TTL defaulting.
 *   verified    — you (or the platform) confirmed it directly / replicated it.
 *   provisional — a single run / one data point; plausible but unreplicated.
 *   suspected   — a hunch / a peer's hedge relayed second-hand; weakest tier.
 */
export const FACT_CONFIDENCE_LEVELS = ['verified', 'provisional', 'suspected'] as const;
export type FactConfidence = (typeof FACT_CONFIDENCE_LEVELS)[number];

/**
 * P-008 (b) / D-019 DEFECT 1 (migration 690) — the claim MODALITY.
 *
 * ⚠ THIS IS NOT `scope`, AND THAT IS THE WHOLE POINT. `scope`
 * (workspace|role|owner|harness|work_item) says WHO a fact is ABOUT. `kind` says
 * WHAT KIND OF CLAIM it is. D-019 killed the separate assumption ledger P-001
 * proposed on the grounds that "an assumption IS a fact" — but that only becomes
 * mechanically true, rather than a convention nobody can query, once the three
 * modalities are distinguishable:
 *
 *   conclusion — a settled finding. Today's default behaviour, stated.
 *   assumption — provisional; pairs with {@link FactDependency} so it can go
 *                stale on its own declared terms (D-007/D-019).
 *   convention — normative ("we do X here"); P-018's target.
 *
 * Workspace-scope CORRELATES with conventions but is not identical to them (a
 * workspace-scoped conclusion is not a convention), so correlation cannot
 * substitute — which is exactly why D-019 recorded the absence as a DEFECT.
 *
 * NULL = not declared, and it is never rewritten to 'conclusion'. Inventing a
 * modality nobody stated is the same manufactured-certainty failure the nullable
 * `confidence` column already refuses.
 */
export const FACT_KINDS = ['conclusion', 'assumption', 'convention'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

// EI-18681984560352579 / migration 664 (2026-07-26): raised 500 -> 1200. The
// old 500-char cap was silently amputating the OPERATIVE clause of facts
// (which fold VERBATIM as binding context) — observed 3x in one session,
// once removing a discriminator rule's verdict sentence entirely. 1200 is
// generous enough that a tight, front-loaded conclusion essentially never
// truncates, while the clamp-not-reject fallback below (clampFactBody)
// still guarantees a write is never lost outright for genuine overflow.
// Keep in sync with the DB CHECK constraint (agent_facts_body_check, mig 664).
export const FACT_BODY_MAX_CHARS = 1200;
/** P-007: bounded verbatim quote inside a source-provenance stamp (fold-friendly —
 *  mirrors RELAY_RENDER_CHARS; a fold can carry 12+ facts, so quotes stay short). */
export const FACT_PROVENANCE_QUOTE_CHARS = 160;
export const FACT_DEFAULT_TTL_SEC = 7 * 24 * 3600;
/** EI-18681964809855890: a 'provisional' fact (one unreplicated run) defaults
 *  to a much shorter TTL than a plain/'verified' conclusion — "stale
 *  certainty is worse than stale doubt" (the owner's framing). Overridable
 *  via an explicit `ttlSec` like every other default here. */
export const FACT_PROVISIONAL_DEFAULT_TTL_SEC = 24 * 3600;
/** 'suspected' (the weakest tier — a hunch / second-hand hedge) decays faster
 *  still; it should be gone from the fold well before anyone could mistake it
 *  for settled fact. */
export const FACT_SUSPECTED_DEFAULT_TTL_SEC = 6 * 3600;
/** Per-(scope,ref) live-fact cap — oldest-updated evicted past this. */
export const FACTS_PER_SCOPE_CAP = 50;
/** Fold budget: max facts per scope-selector in one fold read. */
export const FACTS_FOLD_LIMIT = 12;

/**
 * P-015 (deterministic-context-carry) dead-end slot key prefix — the canonical
 * home of the convention. A dead-end fact (a tried-and-failed approach, asserted
 * via facts:assert { slot:'dead-end' }) is keyed `dead-end:<slug>` so it is
 * machine-greppable in SQL (`key LIKE 'dead-end:%'`). Defined HERE (not the tool
 * layer) so the WRITE convention (facts/assert.normalizeDeadEndSlot, which
 * re-exports this) and the READ filter ({@link foldDeadEndFacts}, the P-006
 * dead-end matcher live leg's fact source) share one source of truth — a drift
 * between them would silently hide every dead-end fact from the matcher.
 */
export const DEAD_END_KEY_PREFIX = 'dead-end:';

/**
 * owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270) — the WALL
 * fact slot. A standing fact expires on TTL whether or not the condition it
 * describes resolved; when the fact encodes an OWNER-GATED WALL (e.g. "still
 * LIVE = NOT rotated"), that turns a safety signal into a time bomb — absence
 * of the fact becomes indistinguishable from "the wall cleared" (TTL decay
 * always fails toward "clear", the wrong direction for an unremediated risk).
 * `facts:assert { slot:'wall' }` (facts/assert.ts normalizeWallSlot) keys the
 * fact under this prefix — machine-greppable (`key LIKE 'wall:%'`), same
 * convention as {@link DEAD_END_KEY_PREFIX} — and defaults its TTL to
 * {@link WALL_DEFAULT_TTL_SEC} instead of the ordinary 7-day default, so a
 * routine decay window can't silently clear it. {@link listLapsedWallFacts}
 * is the read leg the wall-lapse watchdog sweeps so an eventual lapse is LOUD
 * (an escalation), never silent.
 */
export const WALL_KEY_PREFIX = 'wall:';
/** Default TTL applied to a `slot:'wall'` assert when the caller omits
 *  `ttlSec` — the schema's own max (90d, no schema change needed). Long
 *  enough that ordinary 7d decay never silently clears an unremediated risk;
 *  the wall-lapse watchdog is the loud backstop for when even 90d elapses
 *  without a re-assert or an explicit retract. */
export const WALL_DEFAULT_TTL_SEC = 90 * 24 * 3600;

/**
 * P-007 (coord-authority-hardening): the platform-VERIFIED stamp for a TYPED
 * sourceRef (`msg:<id>` / `wi:<id>`/WI-/EI- / `owner-turn`), captured
 * server-side AT ASSERT TIME (H2-tier reuse — see
 * agent-tools/facts/source-provenance-resolve.ts). Folds render it verbatim
 * with zero extra reads. NULL/absent for free-text sourceRefs + legacy rows.
 */
export interface FactSourceProvenance {
  kind: 'msg' | 'work-item' | 'owner-turn';
  /** Did the ref resolve against the platform's own store at assert time? */
  verified: boolean;
  /** Bounded verbatim quote of the source (msg summary/body, WI title, the
   *  owner's human-turn text) — captured server-side, never caller-supplied. */
  quote?: string;
  /** Compact source label, e.g. `msg <id> (<handle> → <to>, <ts>)` / `WI-4172 [feature/wip]`. */
  label?: string;
  /** When !verified: why (not_found / resolve_error / …) — rendered LOUDLY. */
  error?: string;
  verifiedAt: string;
}

/**
 * P-008 (b), migration 690 — ONE declared dependency of a fact on a CELL, with
 * the anchor that makes "has it changed?" a MECHANICAL question.
 *
 * ── WHY A DIGEST AND NOT A VERSION ───────────────────────────────────────────
 *
 * D-012's hard constraint is "reuse the existing clock, do not mint a version
 * counter" — and a cell HAS no counter to reuse. `CellSpec.changeSignal` is
 * `{ kind:'poll', tool, path }`: a POINTER to a resolver, not a stored value, so
 * there is no row whose `fed_ts` could serve. The value only exists once
 * something dispatches the tool. The only honest anchor is therefore the VALUE
 * ITSELF, digested — and a digest is a better fit than it first looks, because
 * it answers precisely the question D-007 asks ("did what I relied on change?")
 * without caring how the underlying store happens to version itself.
 *
 * ── WHY `unknown` IS A FIRST-CLASS ALTERNATIVE TO `digest` ───────────────────
 *
 * A cell that could not be read AT ASSERT TIME has no digest to record. The
 * tempting shortcut is to drop the dependency, or store an empty digest; both
 * launder a non-observation into an observation, and the second is worse — it
 * would later compare equal to another failed read and report FRESH. So an
 * unreadable dependency stores its enumerated {@link CellUnknownCode} instead,
 * and every later verdict on it is `undeterminable`. The fact still records what
 * it MEANT to rest on, which is the part a reader needs.
 *
 * Exactly one of `digest` / `unknown` is set. `observed` is a bounded rendering
 * kept purely so a human reading the fact can see what the value WAS without
 * resolving a hash against nothing.
 */
export interface FactDependency {
  /** The cell id this fact rests on, e.g. `pipeline.myChange`. */
  cell: string;
  /**
   * The SUBJECT the cell was read about, for a `callerRelativity:'parameter'`
   * cell (`state:read`'s `as`). Absent for global/ambient cells.
   *
   * ⚠ STORED, NOT RE-DERIVED, AND THAT IS LOAD-BEARING. The re-read at staleness
   * time MUST use the same subject the digest was taken under, or the comparison
   * silently answers a different question — "has the pipeline position of file A
   * changed?" checked against file B is not a weaker answer, it is a wrong one,
   * and it would report `changed` on two files that both sat perfectly still.
   */
  subject?: string;
  /** ISO timestamp the cell was read at assert time. */
  observedAt: string;
  /** Stable digest of the observed value. Absent iff `unknown` is set. */
  digest?: string;
  /** Bounded human-readable rendering of the observed value (never compared). */
  observed?: string;
  /** The enumerated reason the cell yielded no value at assert time. Absent iff
   *  `digest` is set. `'absent'` is this layer's own code for "the cell does not
   *  exist for this reader" — a CellRead status, not a CellUnknownCode. */
  unknown?: CellUnknownCode | 'absent';
}

/** P-008 (b) — bound a fact's declared dependency set. A fact rests on a handful
 *  of cells; a declaration long enough to need more than this is not a
 *  dependency list, it is a design document in the wrong field. Enforced in code
 *  rather than by a CHECK so an over-long declaration CLIPS like an over-long
 *  body instead of failing the write (this table's standing P-007 rule). */
export const FACT_MAX_DEPENDENCIES = 12;
/** Bound for {@link FactDependency.observed} — a label, not a payload. */
export const FACT_DEPENDENCY_OBSERVED_CHARS = 120;

export interface AgentFact {
  scope: FactScope;
  scopeRef: string | null;
  key: string;
  body: string;
  sourceRef: string | null;
  /** P-007: fold-delivery audience restriction (v1 grammar `fleet:<slug>`);
   *  null = unrestricted. Orthogonal to `scope` (what the fact is ABOUT). */
  audienceScope: string | null;
  /** P-007: assert-time verification stamp for a typed sourceRef; null otherwise. */
  sourceProvenance: FactSourceProvenance | null;
  /** EI-18681964809855890: evidence-strength; null = unset (legacy/default,
   *  renders unbadged — see {@link renderFactsFold}). */
  confidence: FactConfidence | null;
  /** P-008 (b) / D-019: the claim MODALITY (see {@link FactKind}); null = not
   *  declared (every pre-migration-690 row). Distinct from `scope`. */
  kind: FactKind | null;
  /** P-008 (b): the CELLS this fact rests on, captured at assert time. Empty
   *  array when nothing was declared — an assumption without dependencies is
   *  legal, it simply cannot go stale on its own terms. */
  dependsOn: FactDependency[];
  /** P-008 (b) / D-019 DEFECT 2: the optional TYPED assertion P-011 compares,
   *  e.g. `{ subject: 'cell:gate.greenCheckpoint.verdict', assertion: '…' }`.
   *  `body` remains the prose a human reads; null when none was filed. */
  claim: Record<string, unknown> | null;
  createdBy: string;
  updatedAt: string;
  expiresAt: string;
  /**
   * P-008 (a): this VERSION's immutable row id — the thing a D-003 pointer names
   * (P-009's `assumption_set_id`). Optional because the fold/list reads do not
   * select it; present on an assert result and on every {@link factVersions} row.
   */
  id?: number;
  /** P-008 (a): when this version was replaced; null/absent ⇒ it is CURRENT. */
  supersededAt?: string | null;
  /** P-008 (a): the id of the version this one replaced; null for the first. */
  supersedesId?: number | null;
}

export interface AssertFactInput {
  scope: FactScope;
  /** Required for every scope except 'workspace' (D-001). */
  scopeRef?: string | null;
  /** Stable slug — the upsert/retract target. */
  key: string;
  body: string;
  sourceRef?: string | null;
  /** P-007: restrict fold delivery to an audience (v1: `fleet:<slug>`).
   *  Validated via {@link validateAudienceScope} — reject a typo loudly rather
   *  than silently hiding the fact from every reader. */
  audienceScope?: string | null;
  /** P-007: the assert-time verification stamp (resolved by the tool layer —
   *  the store persists it verbatim). */
  sourceProvenance?: FactSourceProvenance | null;
  /** EI-18681964809855890: evidence-strength (see {@link FactConfidence}).
   *  Omitted/null = unset — legacy shape, unbadged in folds, ordinary TTL. */
  confidence?: FactConfidence | null;
  /** P-008 (b) / D-019: the claim modality. Omitted/null = not declared. */
  kind?: FactKind | null;
  /**
   * P-008 (b): the fact's declared CELL dependencies, ALREADY RESOLVED to
   * digests by the caller — same division of labour as `sourceProvenance`,
   * which the store also persists verbatim. Resolving a cell means dispatching
   * its resolver tool, and a storage module that reaches into the tool
   * dispatcher to do that would invert the dependency (and make every fact
   * write, including the ones inside routines, depend on the whole tool
   * registry). `captureFactDependencies` in agent-tools/facts owns the capture.
   */
  dependsOn?: readonly FactDependency[] | null;
  /** P-008 (b) / D-019 DEFECT 2: the optional typed assertion P-011 compares. */
  claim?: Record<string, unknown> | null;
  createdBy: string;
  ttlSec?: number;
  workspaceId?: string;
  /** F0-2 (federated-scout-gym): OPT-IN federation egress — only shareable
   *  facts ever leave the hive. Default false (privacy default, D-001/D-005). */
  shareable?: boolean;
  /**
   * F1-1 federation identity (mig 461 `harness_slug` — "the Hive home slug;
   * NULL = un-hived local fact"). REQUIRED for a shareable fact to actually
   * federate: the capture routes the outbox row by it AND the peer-side wire
   * validator (`isAgentFactWireRow`) rejects a null harness_slug, so a
   * shareable assert without it is captured-then-dropped. Resolve via
   * {@link resolveFactFederationSlug} (member harness → its hive home).
   */
  potHomeSlug?: string | null;
}

/**
 * EI-18681964809855890: the TTL default a confidence tier implies when the
 * caller omits an explicit `ttlSec` — 'provisional'/'suspected' facts decay
 * far faster than the ordinary 7d default so a hedge can't quietly calcify
 * into settled fact via TTL refresh. Returns undefined for null/undefined/
 * 'verified' (falls through to the caller's own default — FACT_DEFAULT_TTL_SEC
 * in {@link assertFact}, or WALL_DEFAULT_TTL_SEC for a wall slot), preserving
 * exact pre-existing behavior for every caller that never sets confidence.
 * PURE — no IO, unit-tested without PG.
 */
export function defaultTtlSecForConfidence(confidence: FactConfidence | null | undefined): number | undefined {
  if (confidence === 'provisional') return FACT_PROVISIONAL_DEFAULT_TTL_SEC;
  if (confidence === 'suspected') return FACT_SUSPECTED_DEFAULT_TTL_SEC;
  return undefined; // null / undefined / 'verified' — ordinary default applies
}

/**
 * EI-18681964809855890: bare EMPIRICAL-CERTAINTY language in a fact body that
 * carries no `confidence` tag — the write-time nudge for "never write a
 * peer's provisional evidence to a durable surface at higher confidence than
 * they stated it" (the rule the incident violated). Warn-only, mirrors the
 * existing provenanceLint contract (never blocks the write); the tool layer
 * folds this into the response only when it fires. PURE — no IO.
 *
 * Deliberately narrow (a handful of unhedged-certainty words) rather than a
 * general sentiment classifier — false positives on a genuinely verified fact
 * are harmless noise (the caller sees a suggestion, not a block), but a
 * classifier broad enough to catch every phrasing would fire on ordinary
 * prose constantly and train agents to ignore it.
 */
const UNHEDGED_CERTAINTY_RE = /\b(verified|confirmed|confirms|proven|proves)\b/i;

export function certaintyLanguageWithoutConfidence(
  body: string,
  confidence: FactConfidence | null | undefined,
): string | null {
  if (confidence) return null; // an explicit tag of ANY tier already answers the question
  const m = UNHEDGED_CERTAINTY_RE.exec(body);
  if (!m) return null;
  return (
    `confidence_lint: this fact's body asserts certainty ("${m[0]}") but no \`confidence\` was set. ` +
    `EI-18681964809855890: a peer's single unreplicated run rendered at IDENTICAL authority to a verified ` +
    `measurement once cost four agents a false regression chase. Pass confidence:'verified' if you replicated ` +
    `this yourself, 'provisional' for a single/unreplicated data point, or 'suspected' for a hunch / second-hand ` +
    `hedge — never write a peer's provisional evidence at higher confidence than they stated it.`
  );
}

/** Validate scope/ref pairing per D-001. Returns an error string or null. */
export function validateFactScope(scope: string, scopeRef?: string | null): string | null {
  if (!(FACT_SCOPES as readonly string[]).includes(scope)) {
    return `unknown scope '${scope}' — one of ${FACT_SCOPES.join('|')}`;
  }
  const ref = (scopeRef ?? '').trim();
  if (scope === 'workspace' && ref) return "scope 'workspace' carries no scope_ref";
  if (scope !== 'workspace' && !ref) return `scope '${scope}' requires scope_ref`;
  return null;
}

/** P-007 v1 audience grammar: `fleet:<slug>`. Grows by adding alternatives HERE
 *  (one grammar, shared by assert-validation and any future selector renderer). */
const AUDIENCE_SCOPE_RE = /^fleet:[a-z0-9][a-z0-9._-]*$/i;

/**
 * Validate an audienceScope value. Returns an error string or null. STRICT by
 * design: an unknown/typo'd audience is REJECTED at assert rather than stored —
 * a stored-but-unmatchable audience would silently hide the fact from every
 * reader, the worst failure for a deterministic-delivery surface. PURE.
 */
export function validateAudienceScope(audienceScope: string | null | undefined): string | null {
  const a = (audienceScope ?? '').trim();
  if (!a) return null; // absent = unrestricted
  if (!AUDIENCE_SCOPE_RE.test(a)) {
    return `audienceScope '${a}' does not match the v1 grammar 'fleet:<slug>' — an unmatchable audience would hide the fact from everyone`;
  }
  return null;
}

/**
 * P-007: defensive read of a source_provenance jsonb round-trip. Absent /
 * malformed / forged-shape → null, never throws (a bad row can't crash a fold).
 * Accepts BOTH an already-parsed object and raw JSON text — whether a jsonb
 * column arrives parsed depends on the postgres.js client's `types` config
 * (a custom types map suppresses the built-in json parser: the test-helper
 * client returns jsonb as text while getOrgPg returns objects). PURE.
 */
export function parseFactSourceProvenance(raw: unknown): FactSourceProvenance | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.kind !== 'msg' && s.kind !== 'work-item' && s.kind !== 'owner-turn') return null;
  if (typeof s.verified !== 'boolean') return null;
  if (typeof s.verifiedAt !== 'string' || !s.verifiedAt) return null;
  return {
    kind: s.kind,
    verified: s.verified,
    verifiedAt: s.verifiedAt,
    ...(typeof s.quote === 'string' && s.quote ? { quote: s.quote } : {}),
    ...(typeof s.label === 'string' && s.label ? { label: s.label } : {}),
    ...(typeof s.error === 'string' && s.error ? { error: s.error } : {}),
  };
}

/**
 * P-008 (b): defensive read of the `depends_on` jsonb round-trip. Same contract
 * and same reasons as {@link parseFactSourceProvenance}: absent / malformed /
 * wrong-shaped entries are DROPPED rather than thrown on, and both the
 * already-parsed and raw-JSON-text arrivals are accepted (whether a jsonb column
 * arrives parsed depends on the postgres.js client's `types` config — the
 * test-helper client returns text where getOrgPg returns objects, and a parser
 * that handled only one of those would pass its unit tests and fail in
 * production).
 *
 * ⚠ A malformed ENTRY is dropped; it is never coerced into a readable one. An
 * entry with neither `digest` nor `unknown` has no anchor at all, so keeping it
 * would mean reporting a comparison that cannot be made — the exact laundering
 * the `unknown` branch exists to prevent. PURE.
 */
export function parseFactDependencies(raw: unknown): FactDependency[] {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: FactDependency[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const d = entry as Record<string, unknown>;
    const cell = typeof d.cell === 'string' ? d.cell.trim() : '';
    const observedAt = typeof d.observedAt === 'string' ? d.observedAt : '';
    if (!cell || !observedAt) continue;
    const digest = typeof d.digest === 'string' && d.digest ? d.digest : undefined;
    const unknown =
      typeof d.unknown === 'string' && d.unknown ? (d.unknown as FactDependency['unknown']) : undefined;
    // Exactly one anchor. Neither ⇒ nothing to compare; both ⇒ contradictory,
    // and guessing which one to believe is how a wrong verdict gets minted.
    if ((digest === undefined) === (unknown === undefined)) continue;
    out.push({
      cell,
      ...(typeof d.subject === 'string' && d.subject ? { subject: d.subject } : {}),
      observedAt,
      ...(digest ? { digest } : {}),
      ...(unknown ? { unknown } : {}),
      ...(typeof d.observed === 'string' && d.observed
        ? { observed: d.observed.slice(0, FACT_DEPENDENCY_OBSERVED_CHARS) }
        : {}),
    });
    if (out.length >= FACT_MAX_DEPENDENCIES) break;
  }
  return out;
}

/**
 * P-008 (b): normalize a caller's declared dependencies for STORAGE — trim,
 * de-duplicate by cell, drop anchorless entries, clip `observed`, and bound the
 * list. Returns null when nothing survives, so the column stays NULL rather than
 * holding an empty array (a NULL and a `[]` would otherwise be two encodings of
 * "no dependencies", and readers would have to handle both).
 *
 * De-duplication keeps the FIRST occurrence: a caller that names the same cell
 * twice observed it once: the second entry is a duplicate of that observation,
 * not a second measurement, and keeping both would double-count it in every
 * later verdict. PURE.
 */
export function normalizeFactDependencies(
  deps: readonly FactDependency[] | null | undefined,
): FactDependency[] | null {
  if (!deps || deps.length === 0) return null;
  const seen = new Set<string>();
  const out: FactDependency[] = [];
  for (const d of deps) {
    const cell = (d?.cell ?? '').trim();
    if (!cell || seen.has(cell)) continue;
    const hasDigest = typeof d.digest === 'string' && d.digest.length > 0;
    const hasUnknown = typeof d.unknown === 'string' && d.unknown.length > 0;
    if (hasDigest === hasUnknown) continue; // anchorless or contradictory
    seen.add(cell);
    out.push({
      cell,
      ...(d.subject ? { subject: d.subject } : {}),
      observedAt: d.observedAt || new Date().toISOString(),
      ...(hasDigest ? { digest: d.digest } : {}),
      ...(hasUnknown ? { unknown: d.unknown } : {}),
      ...(d.observed ? { observed: d.observed.slice(0, FACT_DEPENDENCY_OBSERVED_CHARS) } : {}),
    });
    if (out.length >= FACT_MAX_DEPENDENCIES) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * P-007: render a fact's source anchor for folds — the provenance-hydrated form
 * when a stamp exists (`<sourceRef> ✓ "<quote>"` / `<sourceRef> ✗unverified (err)`),
 * else the plain sourceRef. '' when the fact has no source at all. PURE.
 */
export function renderFactSrc(f: Pick<AgentFact, 'sourceRef' | 'sourceProvenance'>): string {
  const ref = f.sourceRef ?? '';
  const p = f.sourceProvenance;
  if (!p) return ref;
  if (!p.verified) return `${ref} ✗unverified${p.error ? ` (${p.error})` : ''}`;
  return p.quote ? `${ref} ✓ "${p.quote}"` : `${ref} ✓${p.label ? ` ${p.label}` : ''}`;
}

/**
 * EI-7517 — fill an OMITTED scopeRef from the caller's context for the
 * ref-bearing scopes that have an unambiguous caller-side default, so the
 * common SELF-scoped assert/list/retract does not force the agent to look up
 * and pass its own id. This closes the recurring "scope 'owner' requires
 * scope_ref" structural error: an agent asserting a fact about "just me"
 * naturally omits the ref, and the tool has enough context to infer it.
 *   owner   → the caller's own ownerId ("owner = just you")
 *   harness → the caller's harness slug (when known)
 *   role    → the caller's derived role
 * An EXPLICIT scopeRef always wins. workspace takes no ref; work_item has no
 * caller-context default (an explicit WI id is still required — there is no
 * "current work item" on the ctx). PURE — unit-tested without ctx/PG.
 */
export function resolveFactScopeRef(
  scope: string,
  scopeRef: string | null | undefined,
  defaults: { ownerId?: string | null; harnessSlug?: string | null; role?: string | null },
): string | null | undefined {
  if ((scopeRef ?? '').trim()) return scopeRef; // an explicit ref always wins
  switch (scope) {
    case 'owner':
      return defaults.ownerId ?? scopeRef;
    case 'harness':
      return defaults.harnessSlug ?? scopeRef;
    case 'role':
      return defaults.role ?? scopeRef;
    default:
      return scopeRef; // workspace (ref-less) / work_item (explicit id required)
  }
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

/**
 * F1-4 / WI-1564: resolve the workspace partition a FEDERATED (shareable)
 * fact/elite write must land in. The coordination partition
 * (`DEFAULT_COORD_WORKSPACE` = 'default') and the `'*'` wildcard NEVER federate
 * — a shareable write there is captured by the mig-461/462 triggers then
 * stranded (never routed to a peer, the WI-1564 137-stranded-row class, the
 * writer-side twin of the harness_slug drop D-007 fixed). Returns the workspace
 * when it federates, else `undefined` so the writer refuses LOUDLY instead of
 * silently stranding. Shared by the fact writer ({@link assertFact}) and the
 * gym-elite writer so both strand-or-federate identically — the WI-1564
 * "resolver shared by writer + reader" invariant (mirrors
 * p2p/grant-store.ts `resolveP2pGrantWorkspace`).
 */
export function resolveFederationWorkspace(ws: string | null | undefined): string | undefined {
  const w = ws?.trim();
  return w && w !== '*' && w !== DEFAULT_COORD_WORKSPACE ? w : undefined;
}

/** TRUNCATE an over-cap body, don't reject it (code-run-self-state-adoption-2026-07-03
 *  P-007): the old hard throw cost 7 lost facts in 14d — an agent that wrote a slightly-long
 *  conclusion lost the WHOLE write, the worst outcome for a durable-memory surface (the
 *  limit-failure-rate precedent: content fields truncate). The 500-char discipline
 *  ("conclusions, not documents") stays as the stored shape, not an all-or-nothing gate;
 *  the '…' suffix makes a truncation visible in the fold, and the DB CHECK (mig 444,
 *  char_length ≤ 500) remains the backstop. PURE — unit-tested without PG. */
export function clampFactBody(raw: string): string {
  const body = raw.trim();
  if (body.length <= FACT_BODY_MAX_CHARS) return body;
  // P-004 (cold-carry-system-hardening-2026-07-19): clip at a SENTENCE (else word)
  // boundary instead of mid-sentence. A fact folds VERBATIM as BINDING context, and
  // the observed failure mode (2026-07-19, 5× in one night) was a mid-sentence cut
  // eating exactly the operative clause — the fact then reads as a complete
  // instruction that stops halfway. The ' […]' marker keeps the elision visible
  // (EI-10952); the boundary is only taken when it preserves ≥60% of the cap, so a
  // pathological one-sentence body still degrades to the old hard cut.
  const MARKER = ' […]';
  const head = body.slice(0, FACT_BODY_MAX_CHARS - MARKER.length);
  const minKeep = Math.floor(FACT_BODY_MAX_CHARS * 0.6);
  let sentenceEnd = -1;
  for (let i = head.length - 1; i > 0; i -= 1) {
    const ch = head[i];
    if ((ch === '.' || ch === '!' || ch === '?' || ch === ';') && /\s/.test(head[i + 1] ?? body[head.length] ?? ' ')) {
      sentenceEnd = i;
      break;
    }
  }
  if (sentenceEnd + 1 >= minKeep) return `${head.slice(0, sentenceEnd + 1)}${MARKER}`;
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace >= minKeep) return `${head.slice(0, lastSpace)}${MARKER}`;
  return `${body.slice(0, FACT_BODY_MAX_CHARS - 1)}…`;
}

/** Upsert a fact by identity; refreshes body/TTL/source on re-assert. Enforces
 *  the per-scope cap by evicting the oldest-updated live facts past the cap. */
export async function assertFact(input: AssertFactInput, inject?: Sql): Promise<AgentFact> {
  // EI-7463: these are CALLER-input mistakes (a bad scope/ref pairing, an
  // empty key/body after trim), not server faults — throw InvalidInputError
  // so the dispatcher codes them `invalid_input` (400) instead of the default
  // `handler_error` (500). A `handler_error` inflates facts:assert's telemetry
  // error-rate as a false "tool is broken" signal (the same EI-334 class the
  // schema-validation path already avoids via InvalidInputError).
  const err = validateFactScope(input.scope, input.scopeRef);
  if (err) throw new InvalidInputError(`facts:assert — ${err}`);
  // P-007: a typo'd audience is a caller-input mistake — reject loudly (stored
  // unmatchable = fact hidden from everyone; see validateAudienceScope).
  const audienceErr = validateAudienceScope(input.audienceScope);
  if (audienceErr) throw new InvalidInputError(`facts:assert — ${audienceErr}`);
  const audienceScope = (input.audienceScope ?? '').trim() || null;
  const key = input.key.trim();
  if (!key) throw new InvalidInputError('facts:assert — key required (stable slug)');
  const body = clampFactBody(input.body);
  if (!body) throw new InvalidInputError('facts:assert — body required');
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();
  // F1-4 / WI-1564: a SHAREABLE fact MUST land in a real federating partition.
  // If the resolved workspace is the non-federating coordination/'*' partition,
  // the capture triggers fire but route nowhere, so the fact is captured then
  // stranded (dropped on every peer). Refuse LOUDLY rather than silently strand
  // — a hive-PRIVATE fact (shareable !== true) is unaffected (it never rides the
  // wire, so any partition is fine).
  if (input.shareable === true && !resolveFederationWorkspace(ws)) {
    throw new Error(
      `facts:assert — a shareable fact cannot use the '${ws}' workspace partition ` +
        `(WI-1564): the coordination/'*' partition never federates, so the fact would ` +
        `be captured then stranded on every peer. Assert from a hive-scoped workspace.`,
    );
  }
  const ref = input.scope === 'workspace' ? null : (input.scopeRef ?? '').trim();
  // EI-18681964809855890: an explicit ttlSec always wins; otherwise a
  // provisional/suspected confidence tier shortens the default (see
  // defaultTtlSecForConfidence) before falling back to FACT_DEFAULT_TTL_SEC.
  const ttl =
    input.ttlSec && input.ttlSec > 0
      ? input.ttlSec
      : (defaultTtlSecForConfidence(input.confidence) ?? FACT_DEFAULT_TTL_SEC);
  const confidence = input.confidence ?? null;
  // P-008 (b), migration 690. `dependsOn` arrives ALREADY RESOLVED (see
  // AssertFactInput.dependsOn) — the store's job is to normalize and persist it,
  // not to dispatch cell resolvers. `kind` is validated rather than trusted: the
  // DB CHECK would reject a bad value with an opaque constraint error, and an
  // InvalidInputError names the actual mistake (EI-7463's class — a caller-input
  // error must not surface as a 500 that inflates the tool's error rate).
  if (input.kind != null && !(FACT_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidInputError(
      `facts:assert — unknown kind '${input.kind}' — one of ${FACT_KINDS.join('|')}`,
    );
  }
  const kind = input.kind ?? null;
  const dependsOn = normalizeFactDependencies(input.dependsOn);
  const claim = input.claim && typeof input.claim === 'object' ? input.claim : null;
  // P-008 (a): APPEND-VERSIONING, not upsert-in-place (migration 689).
  //
  // This used to be ON CONFLICT DO UPDATE SET body = EXCLUDED.body — which
  // DESTROYED the prior value, violating D-003's invariant that "a pointed-at
  // record is never mutated; corrections append, and the pointer keeps naming
  // the old one." P-009 stamps a pointer AT a fact record, so an in-place
  // rewrite silently changes what an already-stamped pointer resolves to.
  //
  // One statement, so it is atomic without an explicit transaction: the CTE
  // supersedes the current version (taking its row lock) and the INSERT writes
  // the new one chained to it via `supersedes_id`. The identity index is now
  // PARTIAL (`WHERE superseded_at IS NULL`), so it still guarantees exactly one
  // CURRENT version per identity while leaving the superseded tail free.
  //
  // ⚠ LOCAL PARTITION ONLY (`source_hive IS NULL`), matching the cap-eviction
  // and retract paths below: superseding must never touch another hive's
  // independent observation of the same identity (H6).
  //
  // A `retracted_at` row is superseded like any other, which is what revives the
  // identity — the previous code expressed that as `retracted_at = NULL` on the
  // mutated row, i.e. by erasing the evidence that it had ever been retracted.
  // The retraction now survives, on the version that carried it.
  //
  // ⚠ P-008 (b): `depends_on` deliberately does NOT carry forward from the
  // superseded version the way `harness_slug` does. A federation slug is a
  // stable IDENTITY, so inheriting it is correct; a dependency set is an
  // OBSERVATION ("cell X digested to D at time T"). Inheriting one would stamp
  // the old reading onto a new version asserted later, which is exactly the
  // frozen-snapshot defect D-003 forbids — and it would fail in the confident
  // direction, reporting FRESH because the digest it compares against was never
  // re-observed. A re-assert re-declares its dependencies or has none.
  const rows = await sql<AgentFactRow[]>`
    WITH superseded AS (
      UPDATE harness_shared.agent_facts
         SET superseded_at = now()
       WHERE workspace_id = ${ws} AND scope = ${input.scope}
         AND coalesce(scope_ref, '') = ${ref ?? ''} AND key = ${key}
         AND source_hive IS NULL
         AND superseded_at IS NULL
      RETURNING id, harness_slug
    )
    INSERT INTO harness_shared.agent_facts
      (workspace_id, harness_slug, scope, scope_ref, key, body, source_ref, created_by, expires_at, shareable,
       audience_scope, source_provenance, confidence, supersedes_id, kind, depends_on, claim)
    VALUES
      (${ws},
       -- keep an already-stamped federation identity when a later assert omits
       -- it (never NULL it back out) — carried forward off the superseded row,
       -- since there is no longer an UPDATE branch to COALESCE against.
       COALESCE(${input.potHomeSlug ?? null}, (SELECT harness_slug FROM superseded)),
       ${input.scope}, ${ref}, ${key}, ${body},
       ${input.sourceRef ?? null}, ${input.createdBy},
       now() + make_interval(secs => ${ttl}), ${input.shareable === true},
       ${audienceScope},
       ${input.sourceProvenance ? JSON.stringify(input.sourceProvenance) : null}::text::jsonb,
       ${confidence},
       (SELECT id FROM superseded),
       ${kind},
       ${dependsOn ? JSON.stringify(dependsOn) : null}::text::jsonb,
       ${claim ? JSON.stringify(claim) : null}::text::jsonb)
    RETURNING id, superseded_at::text, supersedes_id,
              scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
              confidence, kind, depends_on, claim, created_by, updated_at::text, expires_at::text`;
  // Cap enforcement — evict oldest-updated live facts past the cap for this
  // (scope, ref). LOCAL partition only (H6): the local writer's cap must never
  // evict foreign-source observations (those are bounded per-source by the
  // substrate rate caps + each sender's own cap).
  // P-008 (a): the cap counts CURRENT versions only. Counting the superseded
  // tail would make the cap a function of how often facts were CORRECTED rather
  // than how many exist — a heavily-revised fact would evict its own neighbours.
  await sql`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE source_hive IS NULL
       AND superseded_at IS NULL
       AND (workspace_id, scope, coalesce(scope_ref,''), key) IN (
       SELECT workspace_id, scope, coalesce(scope_ref,''), key
         FROM harness_shared.agent_facts
        WHERE workspace_id = ${ws} AND scope = ${input.scope}
          AND coalesce(scope_ref,'') = ${ref ?? ''}
          AND source_hive IS NULL
          AND superseded_at IS NULL
          AND retracted_at IS NULL AND expires_at > now()
        ORDER BY updated_at DESC
       OFFSET ${FACTS_PER_SCOPE_CAP})`;
  return rowToFact(rows[0]);
}

/** Soft-retract by identity. Returns whether a live fact was retracted. */
export async function retractFact(
  args: { scope: FactScope; scopeRef?: string | null; key: string; workspaceId?: string },
  inject?: Sql,
): Promise<boolean> {
  const err = validateFactScope(args.scope, args.scopeRef);
  if (err) throw new InvalidInputError(`facts:retract — ${err}`);
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const ref = args.scope === 'workspace' ? '' : (args.scopeRef ?? '').trim();
  // LOCAL partition only (H6): retracting YOUR fact must not retract another
  // source's independent observation of the same identity. Your retraction
  // federates to peers' copies of YOUR partition via the mig-461/462 update
  // capture; foreign partitions retract via the projection's deleteFromPg.
  // P-008 (a): retract the CURRENT version. A retraction is a state change on
  // the live value, not a new version — it does not fork the chain, and the
  // superseded tail must stay untouched or history would be rewritten by it.
  const rows = await sql<{ key: string }[]>`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${args.key.trim()}
       AND source_hive IS NULL
       AND superseded_at IS NULL
       AND retracted_at IS NULL
    RETURNING key`;
  return rows.length > 0;
}

/** One fold selector: a (scope, ref) pair to include. */
export interface FactSelector {
  scope: FactScope;
  scopeRef?: string | null;
}

/**
 * The FOLD read — live (unexpired, unretracted) facts for a set of selectors,
 * newest-updated first, bounded per selector. This is what brief/dossier/orient
 * renderers call. Deterministic: no similarity, no ranking model.
 *
 * P-007 audience filtering (`opts.audiences`) — the RECIPIENT's audience
 * memberships (e.g. `['fleet:p2p-git']`):
 *   • omitted / []  → only unrestricted facts fold (audience_scope IS NULL) —
 *                     the conservative default: a reader whose audience context
 *                     is unknown never receives an audience-scoped fact;
 *   • ['fleet:x']   → unrestricted facts + facts scoped to a listed audience;
 *   • 'all'         → NO audience filter — the explicit-read escape hatch
 *                     (facts:list): an audience-scoped fact must stay listable
 *                     or it becomes unmanageable (you can't retract what you
 *                     can't see). Audience is delivery RELEVANCE, not secrecy.
 */
export async function foldFacts(
  selectors: readonly FactSelector[],
  opts: {
    workspaceId?: string;
    limitPerSelector?: number;
    audiences?: readonly string[] | 'all';
    /** Narrow the fold to keys starting with this prefix (applied IN SQL, before
     *  the per-selector LIMIT, so a slot's facts are never crowded out by
     *  unrelated ones). Used by {@link foldDeadEndFacts}. */
    keyPrefix?: string;
  } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  if (selectors.length === 0) return [];
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limitPerSelector ?? FACTS_FOLD_LIMIT;
  const keyPrefix = (opts.keyPrefix ?? '').trim();
  const audiences =
    opts.audiences === 'all'
      ? 'all'
      : (opts.audiences ?? []).map((a) => a.trim()).filter(Boolean);
  const out: AgentFact[] = [];
  for (const sel of selectors) {
    const ref = sel.scope === 'workspace' ? '' : (sel.scopeRef ?? '').trim();
    if (sel.scope !== 'workspace' && !ref) continue; // an unset optional dimension folds nothing
    const rows = await sql<AgentFactRow[]>`
      SELECT scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
             confidence, kind, depends_on, claim, created_by, updated_at::text, expires_at::text
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${ws} AND scope = ${sel.scope}
         AND coalesce(scope_ref,'') = ${ref}
         -- P-008 (a): CURRENT versions only. A fold that saw the superseded tail
         -- would serve an agent both the corrected value and the value it
         -- corrected, as peers.
         AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND ${keyPrefix ? sql`key LIKE ${keyPrefix + '%'}` : sql`TRUE`}
         AND ${
           audiences === 'all'
             ? sql`TRUE`
             : audiences.length > 0
               ? sql`(audience_scope IS NULL OR audience_scope = ANY(${audiences as string[]}))`
               : sql`audience_scope IS NULL`
         }
       ORDER BY updated_at DESC
       LIMIT ${limit}`;
    out.push(...rows.map(rowToFact));
  }
  return out;
}

/**
 * Fold the in-scope DEAD-END facts (the P-015 slot: keys `dead-end:%`) for a set
 * of selectors — the fact source the P-006 dead-end matcher live leg ticks off.
 * Same scoping + audience semantics as {@link foldFacts}, narrowed to the
 * dead-end slot IN SQL so the per-selector limit is spent only on dead-ends. The
 * default per-selector limit is raised above FACTS_FOLD_LIMIT: this fold isn't a
 * brief budget, it's the matcher's full candidate set for one tick.
 */
export async function foldDeadEndFacts(
  selectors: readonly FactSelector[],
  opts: { workspaceId?: string; limitPerSelector?: number; audiences?: readonly string[] | 'all' } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  return foldFacts(selectors, { ...opts, keyPrefix: DEAD_END_KEY_PREFIX }, inject);
}

/** A wall fact whose TTL has LAPSED (expired) but was never retracted — the
 *  wall-lapse watchdog's candidate set. Cross-scope/cross-workspace by design
 *  (a lapsed wall is a page regardless of who asserted it or where). */
export interface LapsedWallFact {
  workspaceId: string;
  scope: FactScope;
  scopeRef: string | null;
  key: string;
  body: string;
  createdBy: string;
  expiresAt: string;
}

/**
 * Every WALL fact (`key LIKE 'wall:%'`) that has expired without being
 * retracted — the read leg {@link WALL_KEY_PREFIX}'s callers sweep. Bounded +
 * oldest-lapsed-first (the wall that has been silently "cleared" the longest
 * is the most urgent). Distinct from {@link sweepExpiredFacts}, which only
 * hard-deletes rows >30d past expiry/retraction — a lapsed wall is a page
 * target from the MOMENT it lapses, long before that deletion sweep would
 * ever touch it.
 */
export async function listLapsedWallFacts(
  opts: { limit?: number } = {},
  inject?: Sql,
): Promise<LapsedWallFact[]> {
  const sql = sqlOf(inject);
  const limit = opts.limit ?? 200;
  const rows = await sql<Array<{
    workspace_id: string;
    scope: FactScope;
    scope_ref: string | null;
    key: string;
    body: string;
    created_by: string;
    expires_at: string;
  }>>`
    SELECT workspace_id, scope, scope_ref, key, body, created_by, expires_at::text
      FROM harness_shared.agent_facts
     WHERE key LIKE ${WALL_KEY_PREFIX + '%'}
       -- P-008 (a): only the CURRENT version of a wall can be lapsed. A
       -- superseded version's expiry is a historical fact, not a page.
       AND superseded_at IS NULL
       AND retracted_at IS NULL
       AND expires_at < now()
     ORDER BY expires_at ASC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    scope: r.scope,
    scopeRef: r.scope_ref,
    key: r.key,
    body: r.body,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
  }));
}

/** List facts for one selector (the facts:list tool read; includes near-expiry).
 *  Audience-UNfiltered by design ('all') — an explicit list must show
 *  audience-scoped facts (visible `audienceScope` field) so they stay
 *  manageable/retractable; only the automatic FOLDS filter by recipient. */
export async function listFacts(
  sel: FactSelector,
  opts: { workspaceId?: string; limit?: number } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  return foldFacts(
    [sel],
    { workspaceId: opts.workspaceId, limitPerSelector: opts.limit ?? 50, audiences: 'all' },
    inject,
  );
}

/**
 * Every VERSION of one fact identity, newest first — the read that makes
 * append-versioning (P-008 a) worth having. The current version is the row with
 * `supersededAt === null`; walk `supersedesId` to follow the chain back.
 *
 * LOCAL partition only (`source_hive IS NULL`), matching every other
 * identity-scoped path here: a foreign hive's observations are not versions of
 * yours, and interleaving them would make the chain unreadable.
 *
 * ⚠ HISTORY IS BOUNDED, NOT INFINITE — {@link sweepExpiredFacts} deletes
 * superseded versions 30d after they were replaced. A chain therefore truncates
 * at the tail, and a `supersedesId` older than that resolves to nothing. That is
 * deliberate (an unbounded audit tail on a hot table is its own defect); what
 * D-003 requires is that a pointer never resolves to DIFFERENT content, not
 * that it resolves forever.
 */
export async function factVersions(
  args: { scope: FactScope; scopeRef?: string | null; key: string; workspaceId?: string; limit?: number },
  inject?: Sql,
): Promise<AgentFact[]> {
  const err = validateFactScope(args.scope, args.scopeRef);
  if (err) throw new InvalidInputError(`facts:versions — ${err}`);
  const key = args.key.trim();
  if (!key) throw new InvalidInputError('facts:versions — key required');
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const ref = args.scope === 'workspace' ? '' : (args.scopeRef ?? '').trim();
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 20;
  const rows = await sql<AgentFactRow[]>`
    SELECT id, superseded_at::text, supersedes_id,
           scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
           confidence, kind, depends_on, claim, created_by, updated_at::text, expires_at::text
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${key}
       AND source_hive IS NULL
     ORDER BY superseded_at DESC NULLS FIRST, id DESC
     LIMIT ${limit}`;
  return rows.map(rowToFact);
}

/** Expiry sweep (routines-tick reaper pattern): hard-delete rows expired or
 *  retracted > 30d ago — keeps the audit trail bounded. Fail-soft at call site. */
export async function sweepExpiredFacts(inject?: Sql): Promise<number> {
  const sql = sqlOf(inject);
  const rows = await sql<{ key: string }[]>`
    DELETE FROM harness_shared.agent_facts
     WHERE expires_at < now() - interval '30 days'
        OR retracted_at < now() - interval '30 days'
        -- P-008 (a): bound the version tail on the SUPERSEDE date, not on the
        -- version's own expiry. A long-TTL fact (a 90d wall) corrected on day
        -- one leaves a version whose expires_at is still months out; without
        -- this clause the tail would outlive the value it was corrected to.
        OR superseded_at < now() - interval '30 days'
    RETURNING key`;
  return rows.length;
}

/** F0-2 (federated-scout-gym): the ELITE eligibility rule — sender-side gate on
 *  what may federate. Outcome-verified or strongly-graded only; everything else
 *  is spam-by-design on an open network (D-005 H3: receiver-side signed-outcome
 *  verification + reputation weighting still apply on top of this). */
export function federatableElite(e: { outcome?: string | null; grade?: number | null }): boolean {
  return e.outcome === 'won' || (e.grade ?? 0) >= 4;
}

/** Render facts as the compact fold block briefs embed. Deterministic layout:
 *  one line per fact — `[scope:ref] body (src, expires in Nd)`; P-007 adds the
 *  audience tag (`⊸fleet:x`, only ever present when the reader matched it) and
 *  the provenance-hydrated src form (verified quote / loud ✗unverified). */
export function renderFactsFold(facts: readonly AgentFact[], now: number = Date.now()): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f) => {
    const scope = f.scopeRef ? `${f.scope}:${f.scopeRef}` : f.scope;
    const aud = f.audienceScope ? ` ⊸${f.audienceScope}` : '';
    const days = Math.max(0, Math.round((Date.parse(f.expiresAt) - now) / 86_400_000));
    const rendered = renderFactSrc(f);
    const src = rendered ? `, src ${rendered}` : '';
    return `• [${scope}${aud}] ${f.body} (expires ~${days}d${src})`;
  });
  return `### Standing facts (deterministic — assert via facts:assert, retract when stale)\n${lines.join('\n')}`;
}

interface AgentFactRow {
  scope: FactScope;
  scope_ref: string | null;
  key: string;
  body: string;
  source_ref: string | null;
  audience_scope: string | null;
  source_provenance: unknown;
  confidence: string | null;
  /** P-008 (b) — migration 690. */
  kind?: string | null;
  depends_on?: unknown;
  claim?: unknown;
  created_by: string;
  updated_at: string;
  expires_at: string;
  /** P-008 (a) — selected only where the caller needs version identity. */
  id?: string | number | null;
  superseded_at?: string | null;
  supersedes_id?: string | number | null;
}

/** Defensive validation of a raw `confidence` DB value against the 3-tier
 *  enum (mirrors parseFactSourceProvenance's defensive style, per WI-6052's
 *  fix step 3) — an out-of-band write (a raw psql INSERT, a future bad
 *  migration) that smuggles in an unrecognized value renders unbadged rather
 *  than propagating a bogus tier into the AgentFact contract. The DB CHECK
 *  constraint (mig 671) already rejects this at write time for ordinary
 *  callers; this is the read-side backstop. */
function parseFactConfidence(raw: string | null): FactConfidence | null {
  if (raw === null) return null;
  return (FACT_CONFIDENCE_LEVELS as readonly string[]).includes(raw) ? (raw as FactConfidence) : null;
}

/** P-008 (b): the same read-side backstop for `kind`. The mig-690 CHECK already
 *  rejects an unknown value at write time; this catches the case a CHECK cannot
 *  — a LATER migration widening the vocabulary, after which an old reader would
 *  otherwise map a new modality onto one it does not actually have. PURE. */
function parseFactKind(raw: string | null | undefined): FactKind | null {
  if (raw == null) return null;
  return (FACT_KINDS as readonly string[]).includes(raw) ? (raw as FactKind) : null;
}

/** P-008 (b): defensive read of the `claim` jsonb. Same dual text/object arrival
 *  handling as {@link parseFactDependencies}; anything that is not a JSON OBJECT
 *  (an array, a bare scalar) is null — P-011 compares typed FIELDS, and a scalar
 *  has none. PURE. */
export function parseFactClaim(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function rowToFact(r: AgentFactRow): AgentFact {
  return {
    scope: r.scope,
    scopeRef: r.scope_ref,
    key: r.key,
    body: r.body,
    sourceRef: r.source_ref,
    audienceScope: r.audience_scope ?? null,
    sourceProvenance: parseFactSourceProvenance(r.source_provenance),
    // WI-6052: now persisted — mig 671 added the `confidence` column and the
    // INSERT/RETURNING/SELECT above all carry it round-trip.
    confidence: parseFactConfidence(r.confidence),
    // P-008 (b), migration 690. `dependsOn` normalizes to [] rather than null so
    // every consumer can iterate without a null guard — the absence of
    // dependencies and an empty set mean the same thing to a reader ("this fact
    // cannot go stale on declared terms"), unlike `kind`/`claim`, where absent
    // genuinely means "not declared" and must stay distinguishable.
    kind: parseFactKind(r.kind),
    dependsOn: parseFactDependencies(r.depends_on),
    claim: parseFactClaim(r.claim),
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    // P-008 (a): version identity, emitted ONLY when the query selected it —
    // omitted rather than nulled, so a reader can tell "this read did not ask
    // for version identity" from "this row has no predecessor" (`supersedesId:
    // null`). `id` arrives as a bigint, which node-postgres hands back as a
    // string; coerce once here so every consumer sees a number.
    ...(r.id != null ? { id: Number(r.id) } : {}),
    ...(r.superseded_at !== undefined ? { supersededAt: r.superseded_at } : {}),
    ...(r.supersedes_id !== undefined
      ? { supersedesId: r.supersedes_id == null ? null : Number(r.supersedes_id) }
      : {}),
  };
}

/**
 * Resolve the FEDERATION identity slug a shareable fact should carry
 * (`agent_facts.harness_slug`, mig 461): a Hive MEMBER harness resolves to its
 * hive HOME slug (the registry `hive_slug` pointer — the slug the peer-side
 * projection is bound to, register-all A-003); a hive home / standalone
 * harness is itself. Returns null for an unresolvable / wildcard slug — the
 * fact then stays un-hived (local-only), matching mig 461's NULL semantics.
 * Fail-soft: a registry read error yields null, never throws (an assert must
 * not fail on federation-identity resolution).
 */
export async function resolveFactFederationSlug(
  harnessSlug: string | null | undefined,
): Promise<string | null> {
  const slug = harnessSlug?.trim();
  if (!slug || slug === '*') return null;
  try {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const reg = await loadHarnessRegistry();
    const entry = reg.projects.find((p) => p.slug === slug);
    return entry?.hive_slug ?? slug;
  } catch {
    return null;
  }
}
