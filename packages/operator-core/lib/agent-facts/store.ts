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
  createdBy: string;
  updatedAt: string;
  expiresAt: string;
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
  // The arbiter is mig 461's 5-column identity (per-source partitioning, H6):
  // a LOCAL assert always writes the source_hive-NULL ('') partition, so the
  // coalesce(source_hive,'') dimension must be IN the inference spec — the old
  // 4-column spec matched no unique index after 461 and errored EVERY assert
  // at plan time (found 2026-07-03: zero fact writes since 461 applied).
  const rows = await sql<AgentFactRow[]>`
    INSERT INTO harness_shared.agent_facts
      (workspace_id, harness_slug, scope, scope_ref, key, body, source_ref, created_by, expires_at, shareable,
       audience_scope, source_provenance, confidence)
    VALUES
      (${ws}, ${input.potHomeSlug ?? null}, ${input.scope}, ${ref}, ${key}, ${body},
       ${input.sourceRef ?? null}, ${input.createdBy},
       now() + make_interval(secs => ${ttl}), ${input.shareable === true},
       ${audienceScope},
       ${input.sourceProvenance ? JSON.stringify(input.sourceProvenance) : null}::text::jsonb,
       ${confidence})
    ON CONFLICT (workspace_id, scope, coalesce(scope_ref, ''), key, coalesce(source_hive, ''))
    DO UPDATE SET body = EXCLUDED.body,
                  source_ref = EXCLUDED.source_ref,
                  -- keep an already-stamped federation identity when a later
                  -- assert omits it (never NULL it back out)
                  harness_slug = COALESCE(EXCLUDED.harness_slug, harness_shared.agent_facts.harness_slug),
                  updated_at = now(),
                  expires_at = EXCLUDED.expires_at,
                  retracted_at = NULL,
                  shareable = EXCLUDED.shareable,
                  -- P-007: a re-assert REPLACES audience + provenance + confidence
                  -- — the fresh assert is the current truth (omitting them clears,
                  -- matching source_ref's existing replace semantics).
                  audience_scope = EXCLUDED.audience_scope,
                  source_provenance = EXCLUDED.source_provenance,
                  confidence = EXCLUDED.confidence
    RETURNING scope, scope_ref, key, body, source_ref, audience_scope, source_provenance,
              confidence, created_by, updated_at::text, expires_at::text`;
  // Cap enforcement — evict oldest-updated live facts past the cap for this
  // (scope, ref). LOCAL partition only (H6): the local writer's cap must never
  // evict foreign-source observations (those are bounded per-source by the
  // substrate rate caps + each sender's own cap).
  await sql`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE source_hive IS NULL
       AND (workspace_id, scope, coalesce(scope_ref,''), key) IN (
       SELECT workspace_id, scope, coalesce(scope_ref,''), key
         FROM harness_shared.agent_facts
        WHERE workspace_id = ${ws} AND scope = ${input.scope}
          AND coalesce(scope_ref,'') = ${ref ?? ''}
          AND source_hive IS NULL
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
  const rows = await sql<{ key: string }[]>`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${args.key.trim()}
       AND source_hive IS NULL
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
             confidence, created_by, updated_at::text, expires_at::text
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${ws} AND scope = ${sel.scope}
         AND coalesce(scope_ref,'') = ${ref}
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

/** Expiry sweep (routines-tick reaper pattern): hard-delete rows expired or
 *  retracted > 30d ago — keeps the audit trail bounded. Fail-soft at call site. */
export async function sweepExpiredFacts(inject?: Sql): Promise<number> {
  const sql = sqlOf(inject);
  const rows = await sql<{ key: string }[]>`
    DELETE FROM harness_shared.agent_facts
     WHERE expires_at < now() - interval '30 days'
        OR retracted_at < now() - interval '30 days'
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
  created_by: string;
  updated_at: string;
  expires_at: string;
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
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
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
