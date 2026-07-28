/**
 * facts:assert — upsert a standing fact: a deterministic, scoped, TTL'd
 * CONCLUSION that will be folded VERBATIM into every relevant future brief /
 * dossier / orient until it expires or is retracted
 * (queen-memory-hybrid-2026-07-02 L1b; D-001: harness/work_item scopes optional).
 *
 * THE LINE vs the other memory surfaces (put facts HERE, not there):
 *   facts  = deterministic delivery of a scoped conclusion ("WI-1439 is
 *            owner-residue — exclude from frontier").
 *   mem0   = fuzzy semantic background (may or may not surface).
 *   coord  = ephemeral status. checkpoint = task progress. insights doc =
 *            long-form how-it-works.
 */
import { z } from 'zod';
import { InvalidInputError } from '@papercusp/tooldef';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  assertFact,
  resolveFactScopeRef,
  clampFactBody,
  FACT_SCOPES,
  FACT_BODY_MAX_CHARS,
  FACT_CONFIDENCE_LEVELS,
  FACT_KINDS,
  CONVENTION_ENFORCEMENT_TIERS,
  FACT_MAX_DEPENDENCIES,
  DEAD_END_KEY_PREFIX,
  WALL_KEY_PREFIX,
  WALL_DEFAULT_TTL_SEC,
  type FactDependency,
  type FactSourceProvenance,
} from '../../agent-facts/store';
import { isAssumptionFact } from '../../agent-facts/store';
import { resolveScopeRefAlias } from './scope-ctx';
import { carryProvenanceFields } from '../../carry-surface-provenance-stamp';
import { noteAssumptionAsserted } from '../../agent-state-stamp';

/**
 * EI-10952: the disclosure for a truncated body. Returns undefined on the clean
 * case (no field on the response) — same warn-only shape as provenanceLint.
 *
 * PURE (unit-tested without PG): compares what the caller SENT against what the
 * store actually PERSISTED, so it reports the real stored/dropped counts rather
 * than re-deriving the clamp and hoping the two agree.
 */
/** Cap on the verbatim dropped-tail echoed back in the disclosure (P-004). */
const TRUNCATION_TAIL_ECHO_CHARS = 240;

export function truncationField(
  rawBody: string,
  storedBody: string,
): { storedChars: number; droppedChars: number; droppedTail?: string; note: string } | undefined {
  const raw = rawBody.trim();
  if (raw.length <= storedBody.length) return undefined;
  // P-004 (cold-carry-system-hardening-2026-07-19): recover the dropped TAIL and echo
  // it verbatim, so the caller can immediately re-assert a tighter body without
  // reconstructing what was lost. The stored body is always <marker-stripped prefix
  // of raw> + a clip marker (' […]' at a boundary, or '…' on the hard-cut fallback).
  const prefix = storedBody.endsWith(' […]')
    ? storedBody.slice(0, -' […]'.length)
    : storedBody.endsWith('…')
      ? storedBody.slice(0, -1)
      : storedBody;
  const tail = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : '';
  const clippedTail =
    tail.length > TRUNCATION_TAIL_ECHO_CHARS ? `${tail.slice(0, TRUNCATION_TAIL_ECHO_CHARS - 1)}…` : tail;
  return {
    storedChars: storedBody.length,
    droppedChars: raw.length - storedBody.length,
    ...(clippedTail ? { droppedTail: clippedTail } : {}),
    note:
      `CLIPPED to the ${FACT_BODY_MAX_CHARS}-char cap — the write was KEPT (a fact is never lost to a length ` +
      `error). The clip lands on a sentence/word boundary when one exists (marker ' […]'); droppedTail echoes ` +
      `what was cut, verbatim. Facts fold VERBATIM into every future orient as BINDING context, so verify the ` +
      `stored body still says what you mean — front-load the operative clause — and re-assert the SAME key ` +
      `tighter if not (facts are conclusions, not documents; detail belongs on the work-item / insight).`,
  };
}

/**
 * P-015 (deterministic-context-carry) — the DEAD-END fact slot. A tried-and-
 * failed approach recorded as ordinary prose ("the FS-watch route didn't work")
 * reads as narrative and gets re-tried by successors; typed as a dead-end slot
 * it is machine-greppable (key LIKE 'dead-end:%') and renders unmistakably in
 * every fold. Deliberately encoded in the key + body (no schema change): every
 * existing delivery surface (orient/brief/dossier fact folds) renders it
 * correctly with zero renderer changes.
 */
// The key prefix is owned by the agent-facts store (single source shared with the
// P-006 dead-end matcher's read filter, foldDeadEndFacts) — re-exported here so the
// slot's write-side helpers + existing importers keep their `./assert` import path.
export { DEAD_END_KEY_PREFIX };
export const DEAD_END_BODY_PREFIX = '⛔ DEAD END — do not retry: ';

/** PURE: normalize a slot:'dead-end' assert's key/body onto the slot encoding.
 *  Idempotent — an already-prefixed key/body is left alone (a re-assert of the
 *  same fact must hit the same upsert key and not stack markers). */
export function normalizeDeadEndSlot(key: string, body: string): { key: string; body: string } {
  const k = key.toLowerCase().startsWith(DEAD_END_KEY_PREFIX) ? key : `${DEAD_END_KEY_PREFIX}${key}`;
  const b = body.startsWith(DEAD_END_BODY_PREFIX) ? body : `${DEAD_END_BODY_PREFIX}${body}`;
  return { key: k, body: b };
}

/**
 * owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270): the
 * WALL fact slot — an owner-gated blocker recorded as a standing fact so it
 * is machine-greppable (`key LIKE 'wall:%'`) and renders unmistakably (⚠) in
 * every fold, instead of reading as an ordinary conclusion that quietly
 * times out. Re-exported for the same reason DEAD_END_KEY_PREFIX is.
 */
export { WALL_KEY_PREFIX };
export const WALL_BODY_PREFIX = '⚠ WALL (owner-gated) — absence ≠ resolved: ';

/** PURE: normalize a slot:'wall' assert's key/body onto the slot encoding.
 *  Idempotent, same shape as {@link normalizeDeadEndSlot}. */
export function normalizeWallSlot(key: string, body: string): { key: string; body: string } {
  const k = key.toLowerCase().startsWith(WALL_KEY_PREFIX) ? key : `${WALL_KEY_PREFIX}${key}`;
  const b = body.startsWith(WALL_BODY_PREFIX) ? body : `${WALL_BODY_PREFIX}${body}`;
  return { key: k, body: b };
}

export default defineTool({
  name: 'facts:assert',
  capability: 'coord:write',
  description:
    'Assert (upsert by key) a STANDING FACT — a durable, scoped conclusion folded VERBATIM into every relevant future brief/dossier/orient until it expires (default TTL 7d) or is retracted. Unlike memory:remember (fuzzy semantic recall), a fact is delivered deterministically. Re-asserting the same key refreshes body + TTL.',
  guidance: {
    when:
      'You reached a durable CONCLUSION that should shape future turns — yours or your role\'s: "X is owner-residue, exclude it", "plan Y stalls on Z", "this harness\'s tests need Docker". Scope it as narrowly as true: workspace (global), role (all queens/bees/…), owner (just you), harness, or work_item.',
    notWhen:
      `Ephemeral status (use coord), in-flight task progress (work_items:checkpoint), long-form knowledge (agent-insights doc), fuzzy background worth semantic recall (memory:remember). Not a dumping ground — ${FACT_BODY_MAX_CHARS}-char cap, per-scope cap 50, TTL mandatory.`,
    chaining:
      'facts:list { scope } to see what already stands (re-assert refreshes rather than duplicating); facts:retract when a fact stops being true — a stale fact folded verbatim is worse than none.',
    seeAlso: ['facts:retract', 'facts:list', 'memory:remember (fuzzy background instead)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    scope: z.enum(FACT_SCOPES).describe('workspace (global, no ref) | role | owner | harness | work_item'),
    scopeRef: z.string().max(120).optional().describe('Required for every scope except workspace: role name / ownerId / harness slug / WI id.'),
    scope_ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef; accepted so a snake_case call still resolves the ref instead of silently dropping it.'),
    ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    harness: z.string().max(120).optional().describe('Alias for scopeRef when scope:"harness" (EI-7371) — prefer scopeRef.'),
    key: z.string().min(1).max(120).describe('Stable slug — upsert + retract target (e.g. "wi-1439-owner-residue").'),
    // Transport ceiling 4000 ≫ the stored cap: the store TRUNCATES to FACT_BODY_MAX_CHARS
    // (code-run-self-state-adoption-2026-07-03 P-007 — the hard zod reject cost the WHOLE
    // write 7×/14d; truncate-not-reject preserves the fact, '…' makes it visible).
    // EI-18670525043445474: the 4000 here is TRANSPORT headroom only (so a slightly-
    // over-cap write is accepted-and-clipped instead of hard-rejected and lost whole —
    // code-run-self-state-adoption-2026-07-03 P-007, after a hard reject cost 7 whole
    // writes in 14d). The REAL cap a caller must size against is FACT_BODY_MAX_CHARS
    // (1200 as of EI-18681984560352579 / migration 664, raised from 500 — the old
    // cap was silently amputating the operative clause of real conclusions) —
    // front-loaded below because a caller sizing off the bare `maxLength: 4000` in
    // the schema (without reading the rest of the description) silently loses
    // everything past the real cap, discovered only after the write via
    // truncated.droppedTail.
    body: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        `HARD-CLIPPED AT ${FACT_BODY_MAX_CHARS} CHARS — size your write to this, not the 4000 schema ceiling (that 4000 is transport headroom only, so an over-cap write is accepted-and-clipped rather than rejected-and-lost; anything past ${FACT_BODY_MAX_CHARS} is silently dropped and only visible after the fact via the response's truncated.droppedTail). Front-load the operative clause. The conclusion — write tight, ≤${FACT_BODY_MAX_CHARS}-char conclusions, not documents.`,
      ),
    sourceRef: z.string().max(200).optional().describe('Anchor that proved it. A TYPED ref — msg:<id>, wi:<id>/WI-/EI- id, or "owner-turn" (the human turn you are answering) — is PLATFORM-VERIFIED at assert time and folds with the verified verbatim quote; anything else (plan slug, prose) stays a plain anchor.'),
    slot: z
      .enum(['dead-end', 'wall'])
      .optional()
      .describe(
        "Typed slot. 'dead-end' (P-015) = a tried-and-failed approach, recorded so successors never re-try it: the key is normalized under 'dead-end:' and the body rendered with the ⛔ DEAD END marker in every future fold. 'wall' (owner-wall-ttl-lapse-hardening) = an OWNER-GATED blocker whose absence must never be read as resolved: the key is normalized under 'wall:' and the body rendered with the ⚠ WALL marker; TTL defaults to 90d instead of the ordinary 7d (still overridable via ttlSec, capped at 90d) and an unretracted lapse is escalated LOUDLY by the wall-lapse watchdog rather than silently vanishing from folds. State the approach AND why it failed / the condition and what remediates it; pair with sourceRef to anchor the evidence.",
      ),
    audienceScope: z.string().max(160).optional().describe('Restrict WHO receives this fact in folds (v1 grammar: "fleet:<slug>") — it then folds ONLY into orients of that fleet\'s members. Omit = every reader of the scope. Orthogonal to `scope` (what the fact is about). facts:list still shows it to everyone (delivery relevance, not secrecy).'),
    confidence: z
      .enum(FACT_CONFIDENCE_LEVELS)
      .optional()
      .describe(
        "Evidence strength (WI-6052): 'verified' (you confirmed it directly / it's replicated), 'provisional' (a single run / one data point — plausible but unreplicated), or 'suspected' (a hunch / a peer's hedge relayed second-hand). Omit = legacy/unset, renders unbadged, ordinary TTL. Setting 'provisional'/'suspected' shortens the default TTL so a hedge can't quietly calcify into settled fact. Never write a peer's provisional evidence at higher confidence than they stated it.",
      ),
    kind: z
      .enum(FACT_KINDS)
      .optional()
      .describe(
        "P-008: the claim MODALITY — 'conclusion' (a settled finding), 'assumption' (provisional; pair it with dependsOn so it goes stale on its own terms), or 'convention' (normative: \"we do X here\"). This is NOT `scope`: scope says who the fact is ABOUT, kind says what kind of claim it is. Omit = not declared (never rewritten to 'conclusion' — a modality nobody stated is not one).",
      ),
    dependsOn: z
      .array(
        z.union([
          z.string().min(1).max(200),
          z.object({
            cell: z.string().min(1).max(200),
            as: z
              .string()
              .max(200)
              .optional()
              .describe('The SUBJECT, for a cell whose callerRelativity is "parameter" — same meaning as state:read { as }.'),
          }),
        ]),
      )
      .max(FACT_MAX_DEPENDENCIES)
      .optional()
      .describe(
        `P-008: the CELL ids this fact rests on (max ${FACT_MAX_DEPENDENCIES}) — either a bare id ("deploy.3070.sha") or { cell, as } when the cell is caller-relative ({ cell: "git.pipelinePosition", as: "packages/operator-core/lib/x.ts" }). Each is READ AND DIGESTED NOW, so a later reader is told mechanically that "the cell you relied on changed from X to Y" instead of guessing from the fact's age. This is what makes an assumption auto-invalidate (D-007) — without it, an assumption is just a conclusion with a weaker badge. A cell that cannot be read is recorded as such and never later reported fresh; it never blocks the write. Run state:read { } to see the cells you may declare.`,
      ),
    claim: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'P-008: an optional TYPED restatement of what this fact asserts, e.g. { subject: "cell:gate.greenCheckpoint.verdict", assertion: "unrelated-to-my-change" }. `body` stays the prose humans read. ⚠ NOTHING READS THIS TODAY — the contradiction detector it was built for was retired (WI-6545 / D-103) after 3 of 2,217 facts ever carried a claim. Stored faithfully if you pass it; omit it unless you have your own reason.',
      ),
    enforcement: z
      .object({
        tier: z.enum(CONVENTION_ENFORCEMENT_TIERS),
        floor: z.number().optional(),
        reviewBy: z.string().max(40).optional(),
      })
      .optional()
      .describe(
        "P-018: HOW this convention is enforced (kind:'convention' only) — 'structural' (impossible to do wrong; no agent decision involved), 'gate' (refused at a chokepoint), or 'detector' (measured, never silently tolerated). gate/detector REQUIRE floor (a rate in (0,1]) + reviewBy: D-016 — \"a detector without a floor is prose exhortation in a costume\". 'structural' takes neither. There is deliberately no 'prompt' tier: a convention carried only by documentation omits this and reads as untiered.",
      ),
    ttlSec: z.number().int().positive().max(90 * 24 * 3600).optional().describe('TTL seconds (default 7d, max 90d).'),
    shareable: z.boolean().optional().describe('OPT-IN federation egress (F0-2): true = this fact may leave the pot over the substrate. Default false — facts are pot-private.'),
    acceptTruncation: z
      .boolean()
      .optional()
      .describe(
        `Explicit opt-in to force the write through when body exceeds the ${FACT_BODY_MAX_CHARS}-char cap. WITHOUT this, an ` +
          `over-cap body is REFUSED (no write happens) — the error names the overage and previews the exact tail that would be ` +
          `cut, so you can re-write it tight instead of losing it silently (EI-18685042986450096: the old truncate-and-report-` +
          `after behavior dropped the operative clause of a fact 3x, once removing a rule's verdict sentence entirely). Pass ` +
          `true only when you deliberately want the clipped write to land anyway (P-007: a write is never rejected outright — ` +
          `this is the one way to still get the old lossy-but-never-lost behavior).`,
      ),
  }),
  async handler(args, ctx) {
    const { resolveAgentIdentity, deriveAgentRole } = await import('../coordination/identity');
    const identity = resolveAgentIdentity(ctx);
    // EI-7517: default an OMITTED scopeRef from the caller's context for the
    // self-scoped cases (owner = me, harness = this harness, role = my role), so
    // the common "assert a fact about just myself" doesn't error on a missing
    // ref the tool can infer. An explicit scopeRef always wins.
    const aliasedScopeRef = resolveScopeRefAlias(args.scope, args);
    const scopeRef = resolveFactScopeRef(args.scope, aliasedScopeRef, {
      ownerId: identity.ownerId,
      harnessSlug: ctx.harnessSlug,
      role: deriveAgentRole(identity),
    });
    // F1-1 federation identity: a SHAREABLE fact must carry the hive-home slug
    // (mig 461 harness_slug) or the capture routes nowhere and peers reject the
    // wire row. Resolved only when federating (a registry read per assert is
    // not worth paying for hive-private facts).
    const potHomeSlug =
      args.shareable === true
        ? await (await import('../../agent-facts/store')).resolveFactFederationSlug(ctx.harnessSlug)
        : null;
    // P-007: a TYPED sourceRef (msg:/wi:/owner-turn) is platform-verified at
    // assert time — the stamp travels with the fact and folds render the
    // verified quote with zero extra reads. Fail-soft: stamping never blocks
    // the assert (the resolver degrades internally; this catch is the belt).
    let sourceProvenance: FactSourceProvenance | null = null;
    if (args.sourceRef) {
      try {
        const { resolveFactSourceProvenance } = await import('./source-provenance-resolve');
        sourceProvenance = await resolveFactSourceProvenance(identity, args.sourceRef);
      } catch {
        sourceProvenance = null;
      }
    }
    // P-015 dead-end slot / owner-wall-ttl-lapse-hardening wall slot: normalize
    // key/body onto the slot encoding (idempotent).
    const slotted =
      args.slot === 'dead-end'
        ? normalizeDeadEndSlot(args.key, args.body)
        : args.slot === 'wall'
          ? normalizeWallSlot(args.key, args.body)
          : { key: args.key, body: args.body };
    // EI-18685042986450096 (owner-flagged): the old behavior wrote the
    // clipped body UNCONDITIONALLY and only disclosed the loss AFTER the write
    // (truncationField below) — silently dropping the OPERATIVE clause 3x,
    // once removing a discriminator rule's verdict sentence entirely. A fact
    // folds VERBATIM as binding context, so an unnoticed truncation is not a
    // clipped note, it is a wrong instruction presented as complete. REFUSE
    // BEFORE the write (name the overage, preview the exact tail that would be
    // cut) unless the caller explicitly accepts the loss via acceptTruncation —
    // preserving P-007's "never lose a write outright" invariant (the caller
    // always has a path forward: shorten it, or explicitly opt in) while
    // closing the "silent after-the-fact" gap this item is about.
    if (args.acceptTruncation !== true) {
      const wouldStore = clampFactBody(slotted.body);
      const preview = truncationField(slotted.body, wouldStore);
      if (preview) {
        throw new InvalidInputError(
          `facts:assert — body is ${preview.droppedChars} char(s) over the ${FACT_BODY_MAX_CHARS}-char cap and would be ` +
            `CLIPPED, silently dropping this operative tail: "${preview.droppedTail ?? '(tail unavailable)'}". No write ` +
            `happened. Either shorten the body to front-load the operative clause within ${FACT_BODY_MAX_CHARS} chars, or ` +
            `re-call with acceptTruncation:true to force the clipped write through anyway.`,
        );
      }
    }
    // A wall slot with no EXPLICIT ttlSec defaults to WALL_DEFAULT_TTL_SEC (90d)
    // rather than the ordinary 7d, so an owner-gated blocker cannot quietly lapse
    // out of folds. An explicit ttlSec always wins (a caller who deliberately
    // wants a shorter wall can have one).
    //
    // Restored 2026-07-26 (WI-5989): this declaration had been deleted while its
    // use below survived, leaving `ttlSec` an unbound shorthand — a ReferenceError
    // on EVERY facts:assert call, and a tsc regression that red-pinned the
    // green-checkpoint typecheck leg. The still-present WALL_DEFAULT_TTL_SEC
    // import, unused without this line, is what gave the accident away.
    const ttlSec = args.ttlSec ?? (args.slot === 'wall' ? WALL_DEFAULT_TTL_SEC : undefined);
    // P-008 (b): resolve the declared cell dependencies to DIGESTS now, so a
    // later read can answer "did what this rests on change?" mechanically
    // (D-007/D-012) rather than by eyeballing the fact's age. Fail-soft in two
    // layers: captureFactDependencies already records a per-cell unknown for a
    // cell it cannot read, and this catch covers the registry/dispatcher being
    // unavailable wholesale. Losing the DECLARATION is bad; losing the FACT
    // because a resolver was down would be worse, and is the failure mode this
    // table's write path has been hardened against twice already.
    let dependsOn: FactDependency[] = [];
    const declaredCells = (args.dependsOn ?? []).map((d) => (typeof d === 'string' ? d : d.cell));
    if (declaredCells.length > 0) {
      try {
        const { cellReaderFromCtx } = await import('../cell-reader-ctx');
        const { captureFactDependencies } = await import('./dependency-staleness');
        const { reader, env } = cellReaderFromCtx(identity, ctx);
        // A caller-relative cell needs its SUBJECT, or the read comes back
        // `insufficient-data` and the dependency can never be compared.
        const subjects: Record<string, string> = {};
        for (const d of args.dependsOn ?? []) {
          if (typeof d !== 'string' && d.as) subjects[d.cell] = d.as;
        }
        dependsOn = await captureFactDependencies(declaredCells, reader, env, subjects);
      } catch {
        dependsOn = [];
      }
    }
    const fact = await assertFact({
      scope: args.scope,
      scopeRef: scopeRef ?? null,
      key: slotted.key,
      body: slotted.body,
      sourceRef: args.sourceRef ?? null,
      audienceScope: args.audienceScope ?? null,
      sourceProvenance,
      confidence: args.confidence ?? null,
      kind: args.kind ?? null,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(args.claim ? { claim: args.claim } : {}),
      // P-018: validated inside assertFact (validateConventionEnforcement), not
      // here — the D-016 floor rule has to bind every writer, not just this tool.
      ...(args.enforcement ? { enforcement: args.enforcement } : {}),
      ttlSec,
      createdBy: identity.ownerId,
      ...(args.shareable !== undefined ? { shareable: args.shareable } : {}),
      ...(potHomeSlug ? { potHomeSlug } : {}),
    });
    // P-009 / D-011: an ASSUMPTION advances this agent's assumption watermark,
    // which every subsequent tool call is stamped with. `fact.id` is the
    // append-versioned row id P-008(a) made immutable — that immutability is
    // precisely what lets ONE monotonic id name a SET ("every live assumption of
    // mine at or below this id"), so no assumption-set table is needed.
    //
    // Only an ASSUMPTION moves it: a conclusion or a convention is not something
    // the agent is provisionally taking as true, and folding those in would make
    // the watermark mean "any fact I wrote", which no reader wants.
    //
    // ⚠ Via `isAssumptionFact`, NOT a hand-rolled `kind === 'assumption'`. P-008
    // shipped the assumption as `confidence:'suspected'` + `dependsOn` BEFORE
    // migration 690 added the `kind` discriminator, and `kind` is still declared
    // on a small minority of rows (D-083 §2) — so a kind-only test silently
    // misses every legacy-form assumption while passing every fixture that sets
    // the new field. One predicate decides what an assumption is (D-087 R2); a
    // second copy here would be free to drift from it.
    //
    // ⚠ The predicate now lives in `agent-facts/store.ts`. WI-6545 / D-103 retired
    // P-011's detector, which used to be its home — this watermark is its
    // surviving caller, and the reason it was not retired alongside.
    if (isAssumptionFact({ kind: args.kind ?? null, confidence: args.confidence ?? null })) {
      noteAssumptionAsserted(identity.ownerId, fact.id ?? null);
    }
    // WI-3801 lint + P-014 turn-ref verification/origin stamp — warn-only,
    // no fields on the common clean case.
    const provenanceFields = await carryProvenanceFields(slotted.body, identity.ownerId);
    // EI-10952: a body over the cap is TRUNCATED, not rejected (P-007 — the hard
    // reject cost 7 whole facts in 14d, so truncate-not-reject stays). But the
    // caller was never TOLD: the response was a clean `ok:true` and the fact
    // shipped cut mid-sentence. Facts fold VERBATIM into every future orient and
    // are BINDING context, so a silently-truncated fact is not a clipped note —
    // it is a mid-sentence INSTRUCTION presented as complete, to every future
    // agent, until someone retracts it. Keep the write; stop calling it clean.
    const truncation = truncationField(slotted.body, fact.body);
    // P-008 (b): the same disclosure discipline, for dependencies. A cell the
    // caller DECLARED but that could not be read is stored honestly (it will
    // read `undeterminable` forever, never `fresh`) — but a silent `ok:true`
    // would let the agent believe it had armed auto-invalidation when it had
    // not. That is exactly the "silent after-the-fact" gap
    // EI-18685042986450096 closed for truncation, so it is closed here too,
    // warn-only: no field at all on the clean case.
    const unresolvedDeps = fact.dependsOn.filter((d) => !d.digest);
    const droppedDeps = declaredCells.filter((c) => !fact.dependsOn.some((d) => d.cell === c.trim()));
    const dependencyWarning =
      unresolvedDeps.length > 0 || droppedDeps.length > 0
        ? {
            ...(unresolvedDeps.length > 0
              ? {
                  unresolved: unresolvedDeps.map((d) => ({ cell: d.cell, reason: d.unknown })),
                }
              : {}),
            ...(droppedDeps.length > 0 ? { dropped: droppedDeps } : {}),
            note:
              'These declared dependencies carry NO comparison anchor, so this fact can never be reported fresh or stale ' +
              'on their account — only `undeterminable`. `absent` = no such cell for you (a typo, or outside your ' +
              'audience). `insufficient-data` usually means the cell is CALLER-RELATIVE and you passed a bare id — ' +
              'declare it as { cell, as: "<subject>" } instead. Run state:read { } for the cells you may read and ' +
              'their callerRelativity.',
          }
        : null;
    // ⚠ The D-087 R5 `detectorVisibility` warning that stood here is GONE, removed
    // by WI-6545 / D-103 along with the detector it advertised. It told an asserting
    // agent that a claimless assumption was invisible to `facts:conflicts`; with that
    // detector retired the warning pointed at nothing, and a warning that names a
    // surface which no longer exists is worse than no warning — it sends the reader
    // looking for a tool to satisfy. Do not reinstate it without a detector to name.
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            fact,
            ...(truncation ? { truncated: truncation } : {}),
            ...(dependencyWarning ? { dependenciesUnresolved: dependencyWarning } : {}),
            ...provenanceFields,
          }),
        },
      ],
    };
  },
});
