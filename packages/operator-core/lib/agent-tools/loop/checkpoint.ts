/**
 * loop:checkpoint — the su AUTO loop's CARRY-NOTE write (su-cold-auto-mode-2026-07-03
 * P-002 PRODUCER; the enabled→functional linchpin). The loop analog of
 * work_items:checkpoint: an su loop writes a compressed "note to my next self" that a
 * COLD wake (reset / recycle) reconstructs its working state from, instead of a grown
 * transcript. Keyed by the ownerId the loop wakes (loopScope) — STABLE across a
 * fresh-context RESET and a RECYCLE (PAPERCUSP_SID preserved, P-004), so the cold
 * successor reads the SAME note this warm turn left.
 *
 * WHY THIS EXISTS: without a producer, setLoopCarryNote has no caller, so a cold loop
 * has no anchor and decideColdWake's P-006 guard keeps it WARM forever. This tool is
 * what makes loop:arm{carry:'cold'} actually go cold — the missing half of P-002/P-004
 * (P-002 delivered the substrate; this writes it).
 *
 * SHAPE (the shared D-004 contract): pass the structured fields { did, left, insight,
 * next } (with `goal` accepted as an alias for `next`; rendered to renderCarryNote's canonical `## Heading` template a cold successor
 * knows how to read) OR a raw { note } string. Replace-on-write; a blank/null note (or
 * all-blank fields) CLEARS. Journaling ON (the loop trajectory ring, like the Queen) —
 * recent wakes' notes survive a clear so a cold successor still sees the trajectory.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePotHomeSlug } from '../../pot/wake';
import { CARRY_ROW_ID_SCHEMA } from '../_carry-row-id';
import {
  lintUncheckedExternalClaims,
  lintUncheckedImperativeActions,
  mergeCarryRows,
  parseCarryNote,
  renderCarryNote,
  renderCheckLine,
  renderWallLine,
  setLoopCarryNoteWithPrior,
  getLoopCarryNoteWithMeta,
  shortCarryHash,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_NOTE_MAX_WALLS,
  rescueTaggedCarryNoteBlob,
  CARRY_ROW_SOFT_CAPS,
  CARRY_TEXT_SOFT_CAP,
  CARRY_CAP_HARD_MULTIPLE,
  CARRY_ROW_ID_MAX,
  coerceCarryRowShape,
  findVerificationConflict,
  sanitizeCarryRowId,
  truncateCarryField,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  withCarryNoteChecks,
  withCarryNoteWalls,
  type CarryArgRepair,
} from '../../carry-note';
import { getOrgPg } from '@papercusp/db-org';
import { getLoopStatus } from '../../harness/routines/loop';
import { HARVESTED_FIRST_LINE_RULE } from '../../harness/improvements/observation-title-guidance';
import { modeImpliesAutonomy } from '../../modes/registry';
import { getPresence } from '../coordination/presence';
import { readInbox } from '../coordination/messages';
import { readWatermark, pickUnreadCursor } from '../coordination/watermarks';
import {
  continuationGateFromReads,
  countPendingInterrupts,
  readFleetWindDownLoopEndAuthorization,
} from '../coordination/tools/continuation-gate';
import { CONTEXT_GAUGE_CRITICAL_PCT, contextUsagePct } from '../coordination/tools/inbox-context-usage';
import { COORD_READ_TOOL_NAMES } from '../coordination/inbox-read-freshness';
import { carryProvenanceFields, retainedProvenanceText } from '../../carry-surface-provenance-stamp';
import { detectAbsencePremises } from '../../premises-claim-port';
import { detectScopeOverreach } from '../../carry-note-probe-scope';
import { withBoundedTimeout } from '../../bounded-timeout';
import { listVerifiedWaitTakeoversForSubscribers } from '../../events/await/store';

/** The continuation hint is advisory; it must never consume the checkpoint
 * tool's 60s transport budget when coordination reads are degraded. */
export const CONTINUATION_READ_BUDGET_MS = 5_000;

/** P-013 — the optional stable row identity, shared by the walls and checks schemas
 *  (their contract is deliberately identical) AND by work_items:checkpoint's checks
 *  rows, which is why it lives in ../_carry-row-id rather than here: the two tools'
 *  schemas were copies once, and they drifted. See that module for the bound rationale. */

/**
 * Normalize the compact row shorthand accepted by walls and checks. A row
 * string is losslessly the claim itself, while a JSON-encoded array supports
 * stale manifest-pinned clients that serialized the whole field. Object rows
 * stay untouched so genuinely undeclared fields still fail the strict schema
 * instead of being silently dropped.
 */
function normalizeCompactRowInput(value: unknown): unknown {
  let rows: unknown = value;
  if (typeof rows === 'string') {
    const trimmed = rows.trim();
    if (!trimmed) return [];
    try {
      rows = JSON.parse(trimmed);
    } catch {
      rows = [rows];
    }
    // A JSON string is still a compact one-row shorthand, not an array.
    if (typeof rows === 'string') rows = [rows];
  }
  return Array.isArray(rows) ? rows.map((row) => (typeof row === 'string' ? { claim: row } : row)) : rows;
}

function normalizeWallInput(value: unknown): unknown {
  return normalizeCompactRowInput(value);
}

/**
 * P-007 (fleet-member-dx-improvements-2026-07-10, EI-9035): the owner's most
 * recent coord:inbox / coord:orient invocation (ISO), or null. The continuation
 * gate's unread-inbox leg previously keyed ONLY off the turn-END watermark
 * (`messages_since_ts`) — a session that never settled one has an empty
 * watermark, so the gate reported "inbox not evaluated" FOREVER, even seconds
 * after the agent literally read its inbox in the same turn. An inbox/orient
 * READ is evaluation: credit it as the unread cursor. Both name forms matched
 * (colon registry name + underscore transport variant). Best-effort: any
 * failure returns null (the gate then fails safe toward settling, as before).
 */
/** P-007 pure cursor pick — the LATER of the turn-END settle watermark and the
 *  owner's last inbox READ; either alone counts; neither ⇒ null (the gate then
 *  blocks, fail-safe toward settling).
 *
 *  MOVED to ../coordination/watermarks (unread-count-truthfulness-2026-07-27
 *  P-002): the Sessions-dossier unread badge needs the identical rule, and two
 *  copies of "what counts as read" would drift. Re-exported here because this
 *  is where it was published from. */
export { pickUnreadCursor };

export async function lastInboxReadAt(ownerId: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ invoked_at: string | Date }[]>`
      SELECT invoked_at
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ${ownerId}
         AND tool_name = ANY(${[...COORD_READ_TOOL_NAMES]})
       ORDER BY invoked_at DESC
       LIMIT 1
    `;
    const v = rows[0]?.invoked_at;
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'loop:checkpoint',
  profile: 'engineer',
  description:
    "Write or clear the su AUTO loop carry-note read by a COLD wake after reset/recycle; " +
    'the live transcript does not survive. Pass { did, left, insight, next } (or goal as an alias for next) or raw { note }; ' +
    'blank/null clears. The note is keyed by ownerId. Supplying { walls } or { checks } uses ' +
    "rowsMode:'merge' by default (supplied rows add/update without dropping unmentioned carried rows); use " +
    "rowsMode:'replace' to retire omitted rows, and use an empty list with replace to clear that row set. Returns { ok, harness, ownerId, cleared, length, verified, " +
    'contentHash, walls, checks }; writes verify-read.',
  guidance: {
    when:
      "At the end of a COLD loop turn, store compressed facts (did, left, insight, next), not a transcript. " +
      'Add a same-line [turn:<session>@<iso-ts>] ref for owner directives or completed coordination actions; ' +
      'never invent a ref. Mark non-owner sources [self-imposed], [peer:<sid>], or [inferred]. When updating one wall/check, ' +
      "pass rowsMode:'replace' only when retiring omitted rows; the default merge mode preserves them. Pair with " +
      'work_items:checkpoint because a loop note can be lost if the session dies.',
    notWhen:
      "WARM loops (carry:'warm', the default) carry the live transcript and need no note. " +
      'Use work_items:checkpoint for work-item state.',
    chaining:
      'Use as the last step before a cold-loop turn ends; also refresh work_items:checkpoint for successor ' +
      'recovery and facts:assert for durable conclusions.',
    seeAlso: [
      "loop:arm (arm the loop; carry:'cold' opts into the cold lifecycle)",
      'loop:status (inspect the loop, incl. carry mode)',
      'work_items:checkpoint (the work-item-scoped analog)',
    ],
  },
  capability: 'routines:write',
  // EI-20228649300818575: this handler writes through the carry-note store and
  // performs its own bounded coordination reads. Do not hold the ambient org-app
  // workspace transaction while it waits on those independent scopes; under pool
  // starvation that outer acquisition can deadlock the mandatory continuity write.
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      note: z
        .string()
        .max(32000)
        .nullish()
        .describe('Raw carry-note text; blank/null ⇒ clear. Ignored when any of did/left/insight/next is set.'),
      // WI-7264: the `.max()` here is a SANITY BACKSTOP, not the real limit. The real
      // limit is CARRY_TEXT_SOFT_CAP, applied by TRUNCATION in the handler and reported
      // back as `repairs`. A hard reject discards the whole multi-KB note over one long
      // field and the agent just re-sends it — measured as 7.7% of this tool's argument
      // bytes, spent twice. Keep the advertised guidance at the soft cap.
      did: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .optional()
        .describe('What this wake accomplished (concrete progress).'),
      left: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .optional()
        .describe('What remains, in order.'),
      insight: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .optional()
        // observation-and-recall-surface-honesty-2026-08-16 P-001: this field is the
        // turn-end reflection path — checkpoint-harvest's boundInsight() takes its FIRST
        // LINE verbatim as the filed observation's title, which is the only thing
        // recurrence matching ever sees. Saying "titles should be identifiers" is
        // unactionable here unless it also says which line becomes the title.
        .describe(`The non-obvious thing a cold successor would waste time re-deriving. ${HARVESTED_FIRST_LINE_RULE}`),
      next: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .optional()
        .describe('The single concrete next action for the next wake.'),
      goal: z
        .string()
        .max(CARRY_TEXT_SOFT_CAP * CARRY_CAP_HARD_MULTIPLE)
        .optional()
        .describe(
          'Compatibility alias for `next`, for callers mirroring loop:arm { goal }. Explicit `next` wins when both are supplied.',
        ),
      // WI-7264: walls deliberately get the cap RELAXATION but NOT the `{status,
      // evidence}` shape coercion that `checks` gets. A wall has no `verified` field,
      // so there is no lossless place to put an `evidence` string — coercing it would
      // have to DROP the caller's data, which is the silent-loss failure
      // (EI-18723223344390510) this whole change exists to avoid re-creating. An
      // unmappable wall shape keeps failing loudly, and the data says that is fine:
      // the `{status, evidence}` volume is a checks-row phenomenon (97 calls in 6 days
      // vs 2 for walls).
      walls: z
        .preprocess(
          normalizeWallInput,
          z
            .array(
              z.object({
                claim: z
                  .string()
                  .min(1)
                  .max(CARRY_ROW_SOFT_CAPS.claim * CARRY_CAP_HARD_MULTIPLE)
                  .describe('The pending owner-gated action/decision, stated concretely.'),
                id: CARRY_ROW_ID_SCHEMA,
                recheck: z
                  .string()
                  .max(CARRY_ROW_SOFT_CAPS.recheck * CARRY_CAP_HARD_MULTIPLE)
                  .optional()
                  .describe('A concrete command a successor runs to re-check it.'),
              }),
            )
            .max(CARRY_NOTE_MAX_WALLS * CARRY_CAP_HARD_MULTIPLE),
        )
        .optional()
        .describe(
          'Open WALLS (owner-gated commitments) as rows — rendered into EVERY wake + carry brief until cleared. ' +
            "Compact claim strings are accepted (`walls: ['owner approval']`) and mapped losslessly to `{ claim }`; " +
            'a JSON-encoded array is accepted for stale wire manifests. ' +
            'OMITTED ⇒ existing walls CARRY FORWARD (a rewrite or note-clear never drops them); a supplied list ' +
            "REPLACES (the default is rowsMode:'merge', which upserts instead), so pass the full current set (dropped ones come " +
            'back as `wallsDropped`) only when retiring rows; [] clears under replace.',
        ),
      checks: z
        .preprocess(
          // EI-302-class wire coercion (proven live the night this shipped): a session
          // whose manifest-pinned schema predates this field sends the array as a JSON
          // STRING — parse it instead of rejecting the write. Compact claim strings
          // are the same lossless shorthand as walls. Non-array JSON values remain
          // invalid; ordinary strings are treated as the scalar shorthand.
          (v) => {
            const rows = normalizeCompactRowInput(v);
            // WI-7264: repair the wrong-but-obvious row SHAPE rather than rejecting the
            // whole note over it. `{claim, recheck, status, evidence}` is what agents
            // actually reach for — `evidence` (57×) and `status` (40×) were the top two
            // rejected undeclared keys across 6 days of transcripts, and this field's own
            // description already warns against that shape, so documenting it has not
            // worked. The coercion is data-PRESERVING (evidence becomes `verified`, so the
            // row still renders VERIFIED), which is what separates it from
            // EI-18723223344390510 — the bug where a nested row silently DROPPED those
            // keys and destroyed the evidence. Silent here means "nothing was lost", not
            // "nothing happened"; truncation, which does lose bytes, is reported instead.
            return Array.isArray(rows) ? rows.map((row, i) => coerceCarryRowShape(row, `checks[${i}]`, [])) : rows;
          },
          z.array(
            z.object({
              claim: z
                .string()
                .min(1)
                .max(CARRY_ROW_SOFT_CAPS.claim * CARRY_CAP_HARD_MULTIPLE)
                .describe('The external-state claim, stated concretely.'),
              id: CARRY_ROW_ID_SCHEMA,
              recheck: z
                .string()
                .max(CARRY_ROW_SOFT_CAPS.recheck * CARRY_CAP_HARD_MULTIPLE)
                .optional()
                .describe('Concrete probe to run before relying on the claim.'),
              verified: z
                .string()
                .max(CARRY_ROW_SOFT_CAPS.verified * CARRY_CAP_HARD_MULTIPLE)
                .optional()
                .describe(
                  'The EVIDENCE STRING itself (max 300 chars) — e.g. "Verified 15:14Z: 30/30 passed, tree clean". ' +
                    'NOT a boolean (`true`/`false` is rejected) and NOT `{status, evidence}` — this ONE string field ' +
                    'carries both the verified/PREDICTED flag and its justification: presence of `verified` (however ' +
                    'short) renders the row VERIFIED; omitting it entirely renders PREDICTED. There is no separate ' +
                    'boolean flag to set.',
                ),
              contested: z
                .string()
                .max(CARRY_ROW_SOFT_CAPS.contested * CARRY_CAP_HARD_MULTIPLE)
                .optional()
                .describe(
                  'Evidence that was supplied as verification but contradicts it (for example, "STILL RUNNING"). ' +
                    'Rendered with ⚠ CONTESTED and never upgraded to VERIFIED; re-check before relying on the claim.',
                ),
            }),
          ).max(CARRY_NOTE_MAX_CHECKS * CARRY_CAP_HARD_MULTIPLE),
        )
        .optional()
        .describe(
          'Carried CHECKS — claims about EXTERNAL STATE as {claim, recheck, verified?, contested?} rows (compact claim strings ' +
            'are accepted and mapped to {claim}; the non-owner analog ' +
            'of walls; renders a ## Checks section every wake). `verified` is a STRING (evidence, ≤300 chars), never ' +
            'a boolean — a claim OMITTING `verified` renders PREDICTED, a successor must run its recheck before ' +
            'relying on it. If its evidence says STILL RUNNING, pending, outstanding, in-flight, unverified, or awaiting, ' +
            'the writer downgrades it to `contested` and reports the repair; contested rows render ⚠ and require a re-check. ' +
            'Put hash/id/timestamp expectations HERE, never in Left prose. Same carry-forward ' +
            'semantics as walls: OMITTED ⇒ carried; a supplied list REPLACES, so re-send the FULL set you want ' +
            "kept (dropped claims come back as `checksDropped`). The default rowsMode:'merge' preserves omitted rows; " +
            "pass rowsMode:'replace' to retire them; [] clears under replace.",
        ),
      rowsMode: z
        .enum(['replace', 'merge'])
        .optional()
        .describe(
          "How a supplied walls/checks list combines with the carried set. 'merge' (default) — rows UPSERT by `id` " +
            '(else by exact claim text) and unmentioned rows SURVIVE, so adding/updating ONE row needs only that ' +
            "row. 'replace' makes the list the new set and is the only retirement path. Under 'merge' a [] list is a " +
            'no-op, never a clear.',
        ),
      ownerId: z
        .string()
        .max(120)
        .optional()
        .describe('The loop owner id (default: your own resolved identity). Mirrors loop:arm/end/status.'),
      harness: z
        .string()
        .max(120)
        .optional()
        .describe('Harness the loop is scoped under (default: your session harness / home pot).'),
    })
    .refine(
      (a) =>
        a.note !== undefined ||
        a.did !== undefined ||
        a.left !== undefined ||
        a.insight !== undefined ||
        a.next !== undefined ||
        a.goal !== undefined ||
        a.walls !== undefined ||
        a.checks !== undefined,
      {
        message:
          'pass { did, left, insight, next } (any; goal aliases next), { note }, { walls }, or { checks } — nothing to write',
      },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.ownerId ?? identity.ownerId;
    // WI-2148: the carry-note scope key MUST match what the cold-wake READER resolves —
    // and the reader gets `harness` from the ColdLoopMarker the FIRE stamped on the wake
    // payload, which is the ARMED ROUTINE's fixed `install_slug` (loop.ts's getLoopStatus),
    // NOT the checkpointing session's own ctx.harnessSlug. Those two can legitimately
    // differ wake-to-wake for the SAME loop (observed live: wakes 1-3 wrote
    // 'loop:*:<owner>', wake-4 wrote 'loop:papercusp:<owner>' because ctx.harnessSlug
    // resolved differently across wakes) — writing under the session's transient harness
    // instead of the routine's fixed one creates a SECOND, stale-diverging carry_notes row;
    // a cold reset that resolves the note by the routine's install_slug then reads whichever
    // row is stale. An EXPLICIT harness is an intentional cross-harness address and must
    // win (loop:end/status similarly accept explicit owner-scoped control); otherwise
    // resolve from the armed routine FIRST (the single source of truth the reader also
    // uses). Only fall back to the old session-context chain when no routine is armed yet
    // (e.g. a checkpoint written before the first loop:arm — an edge case, since
    // loop:checkpoint's whole purpose assumes an armed loop already exists).
    const armedRoutine = await getLoopStatus(ownerId).catch(() => null);
    // EI-7734: the pre-armed-routine fallback is routed through resolvePotHomeSlug
    // (not a raw `??` chain) so its '*'-skip logic runs — every superuser/operator
    // session sets ctx.harnessSlug='*' (the wildcard sentinel), which would otherwise
    // win this chain outright and scope the carry-note under the literal '*' namespace.
    const requestedHarness = args.harness?.trim();
    const explicitHarness =
      requestedHarness && requestedHarness !== '*' && requestedHarness.toLowerCase() !== 'all'
        ? resolvePotHomeSlug(requestedHarness, undefined)
        : null;
    const harness =
      explicitHarness ?? armedRoutine?.harnessSlug ?? resolvePotHomeSlug(undefined, ctx.harnessSlug);
    if (!harness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_harness',
              message:
                'Pass `harness` — your session is not scoped to a harness and no home hive is set, so the loop carry-note has nowhere to live.',
            }),
          },
        ],
        isError: true,
      };
    }

    // EI-18833865002636933 — rescue-by-parse of a MALFORMED structured write. Seen live:
    // an agent serialized its whole note as one XML-tagged string into `did`, so the cold
    // wake got a single `## Did` section with literal `</did><left>…<checks>[…]` text in
    // it — typed checks rows demoted to inert JSON prose, ✓/? badges gone, and NOTHING
    // saying it had happened. Same philosophy as the `checks` z.preprocess above: the
    // caller sent the right CONTENT in the wrong SHAPE, so parse it rather than refuse
    // (refusing would have made this the FOURTH consecutive failed checkpoint that turn,
    // leaving the cold wake with no note at all).
    //
    // Gated on siblings being ABSENT: a well-formed call that merely QUOTES `</did>` in
    // its prose has left/insight/next set, so it is never touched. rescueTaggedCarryNote-
    // Blob applies the second half of the guard (the full close-tag signature).
    const rescued =
      args.did !== undefined && args.left === undefined && args.insight === undefined && args.next === undefined
        ? rescueTaggedCarryNoteBlob(args.did)
        : null;
    const fields = rescued
      ? { did: rescued.did, left: rescued.left, insight: rescued.insight, next: rescued.next }
      : { did: args.did, left: args.left, insight: args.insight, next: args.next ?? args.goal };

    // WI-7264: enforce the SOFT caps by truncation, here, after the schema's backstop
    // let the call through. The cap's job is to bound what re-injects into every future
    // wake — truncation does that just as well as rejection did, without discarding the
    // whole note (and the agent's next wake with it). Every trim is REPORTED: a cut that
    // the caller cannot see is the EI-18723223344390510 failure mode, where a row was
    // quietly reshaped and a verified check's evidence was destroyed with no signal.
    const repairs: CarryArgRepair[] = [];
    for (const key of ['did', 'left', 'insight', 'next'] as const) {
      const v = fields[key];
      if (typeof v === 'string') fields[key] = truncateCarryField(v, CARRY_TEXT_SOFT_CAP, key, repairs);
    }
    const capRows = <T extends { id?: string; claim: string; recheck?: string; verified?: string; contested?: string }>(
      rows: T[] | undefined,
      label: string,
    ): T[] | undefined =>
      rows?.map((row, i) => {
        const out = { ...row };
        if (typeof out.id === 'string') {
          const originalId = out.id;
          const normalizedId = sanitizeCarryRowId(originalId);
          if (normalizedId !== originalId) {
            const overStoredLimit = originalId.length > CARRY_ROW_ID_MAX;
            repairs.push({
              field: `${label}[${i}].id`,
              kind: overStoredLimit ? 'truncated' : 'renamed',
              detail: overStoredLimit
                ? `${originalId.length} chars normalized to ${normalizedId?.length ?? 0} chars (stored ids max ${CARRY_ROW_ID_MAX}) — write it shorter to preserve the full identity`
                : `id normalized to ${normalizedId ?? 'no stable id'} — use only letters, numbers, ., _, :, and - to keep the merge identity stable`,
            });
          }
          if (normalizedId) out.id = normalizedId;
          else delete out.id;
        }
        out.claim = truncateCarryField(out.claim, CARRY_ROW_SOFT_CAPS.claim, `${label}[${i}].claim`, repairs);
        if (typeof out.recheck === 'string')
          out.recheck = truncateCarryField(out.recheck, CARRY_ROW_SOFT_CAPS.recheck, `${label}[${i}].recheck`, repairs);
        // A ✓ is an affirmative claim. If its evidence contradicts that claim,
        // preserve the exact evidence but store it as contested so neither the
        // carry note nor a wake can present it as settled. Do this BEFORE capping
        // the evidence: a conflict marker near the tail must not be truncated away
        // and accidentally restore a false ✓.
        if (typeof out.verified === 'string') {
          const conflict = findVerificationConflict(out.verified);
          if (conflict) {
            out.contested = out.verified;
            delete out.verified;
            repairs.push({
              field: `${label}[${i}].verified`,
              kind: 'downgraded',
              detail:
                `verification evidence contains contradiction marker "${conflict}" — stored as contested evidence; re-check before relying on this claim`,
            });
          }
        }
        if (typeof out.verified === 'string')
          out.verified = truncateCarryField(
            out.verified,
            CARRY_ROW_SOFT_CAPS.verified,
            `${label}[${i}].verified`,
            repairs,
          );
        if (typeof out.contested === 'string')
          out.contested = truncateCarryField(
            out.contested,
            CARRY_ROW_SOFT_CAPS.contested,
            `${label}[${i}].contested`,
            repairs,
          );
        return out;
      });
    const hasStructured =
      fields.did !== undefined || fields.left !== undefined || fields.insight !== undefined || fields.next !== undefined;
    // Structured fields win over a raw note (renderCarryNote skips blank sections, so an
    // all-blank structured write renders '' ⇒ a clear). Otherwise the raw note verbatim.
    const baseNote = hasStructured ? renderCarryNote(fields) : args.note;

    // P-006 walls merge — commitments are cleared EXPLICITLY, never incidentally:
    //   explicit `walls` wins (its [] is the only true clear); a raw note's own
    //   `## Walls` rows win next; otherwise the PRIOR walls carry forward — across
    //   rewrites AND across a note clear (the note then survives as walls-only).
    //   A walls-only write likewise carries the prior note body forward.
    // A rescued blob's own rows slot in where the explicit arg would have gone — an
    // EXPLICIT `walls`/`checks` arg still wins outright (including its `[]` clear).
    const effectiveWalls = capRows(args.walls ?? rescued?.walls, 'walls');
    const effectiveChecks = capRows(args.checks ?? rescued?.checks, 'checks');
    const hasNoteWrite = hasStructured || args.note !== undefined;
    // P-014: lint only what this call supplied as current provenance. Rows and
    // narrative inherited by mergeCarryRows remain in the stored note, but are
    // reported separately as retainedProvenance rather than as fresh activity.
    const currentProvenanceText = (() => {
      let text = baseNote ?? '';
      if (effectiveChecks !== undefined) {
        text = withCarryNoteChecks(splitCarryNoteChecks(text).body, effectiveChecks);
      }
      if (effectiveWalls !== undefined) {
        text = withCarryNoteWalls(splitCarryNoteWalls(text).body, effectiveWalls);
      }
      return text;
    })();
    // P-013: replace stays the DEFAULT — it is the only way to retire a stale row, and
    // silently switching every existing caller to merge would make a clear impossible.
    const rowsMode = args.rowsMode ?? 'merge';

    // WI-6813: the walls/checks merge runs INSIDE the row's locked transaction (the
    // `transform` seam), not out here. The caller-side read → merge → write it
    // replaces had a real race — a concurrent writer on this scope landing between
    // the prior read and the write was silently clobbered, which for WALLS means
    // dropping an owner-gated commitment.
    //
    // The transform's own output is CAPTURED (via a holder object, so the assignment
    // survives control-flow narrowing) rather than re-merged out here: the advisory
    // lint and the reported counts then describe EXACTLY what was stored, instead of
    // a second merge against a staler prior that could disagree with it.
    const captured: { merged?: ReturnType<typeof mergeCarryRows> } = {};
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? undefined;
    const { stored } = await setLoopCarryNoteWithPrior(
      { harness, ownerId, workspaceId: workspaceId ?? undefined },
      baseNote,
      {
        transform: (priorNote) => {
          captured.merged = mergeCarryRows({
            priorNote,
            baseNote,
            walls: effectiveWalls,
            checks: effectiveChecks,
            hasNoteWrite,
            mode: rowsMode,
          });
          return captured.merged.note;
        },
      },
    );

    // WI-7124 (mirrors the work_items:checkpoint P-003 verify-read precedent,
    // fleet-deltas-leader-primitives-2026-07-10): prove the write is visible through
    // the SAME path a COLD-WAKE reader resolves it by — not merely that the store
    // echoed back what we asked it to write. This carry-note has a DOCUMENTED,
    // real historical failure of exactly this shape (WI-2148, see the `harness`
    // resolution above): the write-side scope key (a session's transient
    // ctx.harnessSlug) can diverge from the read-side key (the armed routine's fixed
    // install_slug), silently creating a SECOND, stale-diverging carry_notes row that
    // the next cold wake never sees — "written" from the caller's point of view, but
    // invisible to the reader that actually matters. Catch that class LOUDLY at write
    // time, before the slower advisory reads below, instead of discovering it only
    // when a cold wake resumes from a stale/absent note (WI-7124's whole complaint).
    let verifyError: string | null = null;
    let verified: true | null = null;
    let contentHash: string | null = null;
    if (stored !== null) {
      const verifyRead = await getLoopCarryNoteWithMeta({ harness, ownerId, workspaceId }).catch(
        () => ({ note: null, updatedAtMs: null }),
      );
      if (verifyRead.note !== stored) {
        verifyError =
          `checkpoint_verify_failed — the write did not read back via the reader path a cold wake ` +
          `uses (stored ${stored.length} chars, read back ${
            verifyRead.note === null ? 'null' : `${verifyRead.note.length} chars`
          }). A cold wake of this loop would NOT see this note. Retry, or pass { harness } explicitly ` +
          `if your session's scope may differ from the armed routine's (WI-2148).`;
      } else {
        verified = true;
        contentHash = shortCarryHash(stored);
      }
    }
    if (verifyError) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: verifyError, harness, ownerId }),
          },
        ],
        isError: true,
      };
    }

    // Unreachable today (this tool passes no `guard`, and only a blocked guard skips
    // the transform) — but a missing capture must never silently read as "no rows".
    const { walls, checks, narrativeBody, droppedWalls, droppedChecks, overflowWalls, overflowChecks } =
      captured.merged ??
      mergeCarryRows({
        priorNote: null,
        baseNote,
        walls: effectiveWalls,
        checks: effectiveChecks,
        hasNoteWrite,
        mode: rowsMode,
      });

    // P-009: advisory lint — an external-state ASSERTION in the narrative prose whose
    // distinctive tokens (hash / WI-EI id / ISO instant) appear in NO check/wall row is
    // a carried claim with no probe (the phantom-re-anchor shape). Never blocks.
    const probeText = [...checks.map(renderCheckLine), ...walls.map(renderWallLine)].join('\n');
    const uncheckedClaims = hasNoteWrite ? lintUncheckedExternalClaims(narrativeBody, probeText) : [];

    // EI-20079511619330371: a carry-note's `left`/`next` is read as an
    // instruction at wake time, even though its singleton/shared-state
    // precondition may have changed after this write. Keep the warning
    // advisory and only clear it with a matching checks row carrying a
    // runnable recheck; a conclusion in prose (or a wall) is insufficient.
    const imperativeActions = (() => {
      if (!hasNoteWrite) return [];
      try {
        // The production renderer emits canonical headings, but the handler's
        // routing tests intentionally replace it with a sentinel. Prefer the
        // original structured fields when this write supplied them; parse the
        // merged body for raw canonical notes and carried-forward text.
        const parsed = parseCarryNote(narrativeBody);
        const source = hasStructured ? fields : parsed;
        return lintUncheckedImperativeActions(
          [source.left, source.next].filter((value): value is string => Boolean(value?.trim())).join('\n'),
          checks,
        );
      } catch {
        return []; // advisory lint must never cost the checkpoint write
      }
    })();

    // outage-must-not-be-silent-2026-08-02 P-009: the ABSENCE-claim leg of the same lint.
    //
    // The lint above keys on a distinctive TOKEN (hash / WI-EI id / ISO instant) or an
    // external-state noun. An absence claim — "nothing reads X", "there is no exported
    // helper for Y" — carries NEITHER, so it passes straight through, which is exactly how
    // the motivating incident happened.
    //
    // This reuses `detectAbsencePremises` rather than adding a second detector: it is the
    // one already measured against 31,090 real bodies (fires on ~1 claim in 22, not on
    // everything) and it already strips fenced/inline code so a PASTED error string like
    // `column "payload" does not exist` is read as evidence the author GATHERED, never as
    // their own assertion. A second opinion here would be a second bug — the D-005 lesson.
    //
    // Why this surface: the claim-time port fires on a work-item/plan-item at CLAIM. A
    // carry-note never passes a claim event, yet it is re-injected into the author's next
    // wake — and is a COLD successor's only memory — with nothing marking a guess as a
    // guess. Absence claims are uniquely worth catching because the payoff is asymmetric:
    // expensive to act on (you build the thing), cheap to falsify (one reverse-grep).
    //
    // Suppressed when the claim's own subject already appears in a checks[]/walls[] probe —
    // an author who parked the falsifier has done the thing this lint asks for.
    // Advisory + fail-open, like every other leg here: never blocks the write.
    const absenceClaims = (() => {
      if (!hasNoteWrite) return [];
      try {
        // Coverage is judged by WORD OVERLAP, not by a prefix/substring match. A substring
        // test looks simpler and is wrong: the prose and the check row are authored
        // separately, so they routinely differ by a leading fragment, a rewrap, or a
        // rendering prefix — and any such difference silently re-flags a claim the author
        // HAS parked, training them to ignore the lint. Overlap survives all three.
        const probeWords = new Set(probeText.toLowerCase().match(/[a-z0-9_.:/-]{4,}/g) ?? []);
        const covered = (claim: string): boolean => {
          const words = claim.toLowerCase().match(/[a-z0-9_.:/-]{4,}/g) ?? [];
          if (words.length === 0) return false;
          const hits = words.filter((w) => probeWords.has(w)).length;
          return hits / words.length >= 0.6;
        };
        return detectAbsencePremises(narrativeBody, 'carry-note')
          .filter((p) => !covered(p.claim))
          .map((p) => ({ claim: p.claim, recheck: p.recheck }));
      } catch {
        return []; // a lint must never cost the agent the checkpoint it asked for
      }
    })();

    // EI-18741016606334594: the SCOPE leg. Both lints above ask whether a claim has a
    // probe at all. This one asks whether the probe it has can actually see what the
    // claim asserts — a `✓` row whose claim is quantified ("no X", "never", "every")
    // while its own recheck declares a narrow bound (`--since '60 min ago'`, `tail -3`).
    // The badge is a licence to skip re-checking, so an over-broad one does not decay
    // across cold wakes; it hardens, and the successor inherits it as settled fact.
    //
    // Measured against the real corpus before wiring in (D-001, agent-epistemics):
    // 4,074 rows across 618 notes with a `## Checks` section (2026-08-13) — it flags
    // 31 (0.8% of rows, 1.1% of ✓ rows), and the prescriptive-row exclusion is what
    // keeps it there. Advisory + fail-open, like its siblings.
    const scopeOverreach = (() => {
      try {
        return detectScopeOverreach(checks);
      } catch {
        return [];
      }
    })();

    // P-020 (su-ideate-learning-substrate): checkpoint-HARVEST. The carry-note `insight`
    // is exactly the "non-obvious thing a future agent would re-derive" the observation
    // lane wants — auto-file it as a lane:observation with ZERO new workflow (D-016/D-017).
    // Fire-and-forget + fully fail-open: a harvest miss must NEVER slow or break the
    // checkpoint write (the same discipline as the SSE-invalidate in capture-core). The
    // leg self-coalesces the verbatim carry-note that persists across consecutive wakes.
    // Reads `fields.insight`, not `args.insight`: a RESCUED insight is a real insight and
    // must still reach the observation lane (EI-18833865002636933).
    if (fields.insight && fields.insight.trim()) {
      const insightText = fields.insight;
      const harvestHarness = harness !== '*' ? harness : undefined;
      void (async () => {
        try {
          const filedByRole = (await getPresence(ownerId).catch(() => null))?.agentRole ?? undefined;
          const { harvestInsight } = await import('../../harness/improvements/checkpoint-harvest');
          await harvestInsight({
            insight: insightText,
            createdBy: ownerId,
            source: 'loop-checkpoint',
            ref: 'loop:checkpoint',
            ...(filedByRole ? { filedByRole } : {}),
            ...(harvestHarness ? { harness: harvestHarness, sourceHive: harvestHarness } : {}),
          });
        } catch {
          /* fail-open: harvest never affects the checkpoint the agent asked for */
        }
      })();
    }

    // flush-to-proceed-stretch-discipline-2026-07-04 P-005: piggyback the CONTINUATION-GATE
    // read on the checkpoint the agent already writes at a unit boundary, so settle-vs-continue
    // is a one-call read (not a separate orient). Two mechanical legs: context headroom (from
    // the cached presence row) and any unread inbox since the last settle. Best-effort — a read
    // failure omits the leg (which the gate treats as blocking ⇒ it recommends settling, never a
    // false "continue"). An unresolvable inbox cursor also stays null (blocking) rather than
    // counting all history as unread.
    const continuationRead = await withBoundedTimeout(
      async () => {
        const pres = await getPresence(ownerId).catch(() => null);
        // P-006 (cold-carry-system-hardening-2026-07-19): derive context usage from the
        // transcript's CURRENT state (WI-4154's live read — the same fix inbox.ts already
        // carries), with the presence cache only as fallback. The gate previously read
        // ONLY presence.contextTokens, which is null/stale for psu sessions — so every
        // checkpoint closed on "context usage unknown" even seconds after a fresh turn
        // (observed on every single wake of 2026-07-19). Best-effort: null keeps the
        // old fail-safe-toward-settling behavior.
        const liveTokens = await (async () => {
          try {
            const { currentContextTokensForOwner } = await import('../../compaction-usage');
            return await currentContextTokensForOwner(ownerId);
          } catch {
            return null;
          }
        })();
        // Same P-006 gap on the denominator: presence.compactionLimit is null for the
        // same sessions — derive the model-spec default (the compliance-watchdog's own
        // fallback chain) so a live token read isn't wasted on a null limit.
        const derivedLimit = await (async () => {
          if (pres?.compactionLimit != null) return pres.compactionLimit;
          try {
            const [{ resolveModelSpecForOwner }, { defaultCompactionLimitForSpec }] = await Promise.all([
              import('../../compaction-usage'),
              import('../../agent-config-constants'),
            ]);
            return defaultCompactionLimitForSpec(await resolveModelSpecForOwner(ownerId));
          } catch {
            return null;
          }
        })();
        let unreadInbox: number | null = null;
        try {
          const wm = await readWatermark(ownerId);
        // messages_since_ts advances at turn-END, so this counts messages addressed to you
        // that arrived since your last settle. filterInbox (inside readInbox) drops own +
        // notify-kind rows; countPendingInterrupts then drops system machinery — categorized
        // broadcasts, `auto` lifecycle chatter, intent declares — because WI-4179 showed the
        // raw count reads a watchdog burst (16 identical severe-event-resolved rows in one
        // 300ms window) as "16 unread ⇒ pending owner input" and closes the gate while
        // coord:inbox/orient show nothing pending.
        // P-007 (fleet-member-dx, EI-9035): ALSO credit the owner's last coord:inbox/
        // coord:orient READ — use the LATER of the two cursors. A never-settled session
        // ('' watermark) that just read its inbox no longer gets a false, permanent
        // "inbox not evaluated"; and a mid-turn read after the last settle correctly
        // narrows "unread" to what arrived AFTER that read. Neither cursor available ⇒
        // stays null (blocking — fail safe toward settling, unchanged).
          const readTs = await lastInboxReadAt(ownerId);
          const sinceTs = pickUnreadCursor(wm?.messages_since_ts, readTs);
          if (sinceTs) {
            const unread = await readInbox(ownerId, { since_ts: sinceTs, excludeOwn: true });
            unreadInbox = countPendingInterrupts(unread);
          }
        } catch {
          unreadInbox = null;
        }
        // Re-wake guarantee (turn-end-tracking.isRewakeGuaranteed): is ending
        // THIS turn safe, or would an autonomous session silently halt? A CLOSED
        // gate that says "settle" is FALSE COMFORT when no re-wake exists — it
        // must escalate to self-compact / arm-a-wake. Excludes the always-armed
        // coord:inbox-wake keepalive (liveness, not a deliberate wake for this
        // work). Best-effort; unknown ⇒ null → base guidance (non-breaking).
        let rewakeGuaranteed: boolean | null = null;
        let nextWakeFresh: boolean | null = null;
        try {
          const [{ isRewakeGuaranteed }, { listActiveAwaits, INBOX_WAKE_KEY_PREFIX }, { getModes }] =
            await Promise.all([
              import('../../turn-end-tracking'),
              import('../../events/await/store'),
              import('../../modes/store'),
            ]);
          const [loop, awaits, modes] = await Promise.all([
            getLoopStatus(ownerId).catch(() => null),
            listActiveAwaits(ownerId).catch(() => []),
            workspaceId ? getModes(workspaceId, ownerId).catch(() => []) : Promise.resolve([]),
          ]);
          rewakeGuaranteed = isRewakeGuaranteed({
            autonomousModeActive: modes.some((m) => modeImpliesAutonomy(m.mode)),
            loopActive: Boolean(loop?.active),
            activeAwaitCount: awaits.filter((a) => !a.eventKey.startsWith(INBOX_WAKE_KEY_PREFIX)).length,
          });
          // A loop can guarantee another turn without guaranteeing a fresh
          // context. Only cold carry sheds the transcript on settle.
          nextWakeFresh = loop?.active ? loop.carry === 'cold' : null;
        } catch {
          rewakeGuaranteed = null;
          nextWakeFresh = null;
        }
        // Can this session actually SELF-COMPACT? (EI-20209826138488049.) When the
        // gate has no guaranteed re-wake it recommends a recovery mechanism, and
        // recommending self-compaction to a session with no psu-pty host sent it to
        // spend its LAST turn on a call that can only return no_live_pty_host. Read
        // the SAME predicate session:request-compaction evaluates — not a correlated
        // proxy — so advice and refusal cannot disagree. Best-effort; unknown ⇒ null.
        let selfCompactionAvailable: boolean | null = null;
        try {
          const { selfCompactionAvailability } = await import('../../events/await/psu-pty-discovery');
          selfCompactionAvailable = selfCompactionAvailability(ownerId).available;
        } catch {
          selfCompactionAvailable = null;
        }
        let fleetWindDownLoopEndAuthorized: boolean | null = null;
        const contextPct = contextUsagePct(liveTokens ?? pres?.contextTokens, derivedLimit);
        const authorizationWorkspaceId = workspaceId ?? identity.workspaceId;
        if (
          contextPct != null &&
          contextPct >= CONTEXT_GAUGE_CRITICAL_PCT &&
          selfCompactionAvailable === false &&
          authorizationWorkspaceId
        ) {
          fleetWindDownLoopEndAuthorized = await readFleetWindDownLoopEndAuthorization({
            ownerId,
            workspaceId: authorizationWorkspaceId,
          });
        }
        return continuationGateFromReads({
          contextTokens: liveTokens ?? pres?.contextTokens,
          compactionLimit: derivedLimit,
          unreadInbox,
          rewakeGuaranteed,
          nextWakeFresh,
          selfCompactionAvailable,
          fleetWindDownLoopEndAuthorized,
        });
      },
      {
        fallback: undefined,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint continuation reads',
      },
    );
    const continuation = continuationRead.value;
    // P-005: the wake payload that carried a verified-timeout diagnosis is
    // ephemeral, while timeout_verification on event_awaits is durable. Return
    // the latest authoritative stalled/absent evidence on the checkpoint write
    // the owner already performs, including the concrete wake/takeover remedy.
    const verifiedWaitTakeovers = await withBoundedTimeout(
      listVerifiedWaitTakeoversForSubscribers([ownerId]),
      {
        fallback: [],
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint verified-wait takeovers',
      },
    );
    const verifiedWaitTakeoverRows = verifiedWaitTakeovers.value ?? [];

    // WI-3801 lint + P-014 turn-ref verification/origin stamp — both warn-only,
    // absent (no fields) on a clean/cleared write. The final stored note is used
    // only to derive inherited lines; current lint receives submitted bytes.
    const provenanceFields =
      stored !== null
        ? await carryProvenanceFields(currentProvenanceText, ownerId, {
            retainedText: retainedProvenanceText(stored, currentProvenanceText),
          })
        : {};
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness,
            ownerId,
            cleared: stored === null,
            length: stored?.length ?? 0,
            /** WI-7124: the write READ BACK byte-identically via the SAME path a cold
             *  wake uses (null on a clear — nothing to verify; a mismatch never reaches
             *  here — it returns checkpoint_verify_failed above instead). */
            verified,
            /** First 12 hex chars of sha256(stored) — eyeball-check without a re-read. */
            contentHash,
            walls: walls.length,
            checks: checks.length,
            ...(verifiedWaitTakeoverRows.length > 0
              ? { verifiedWaitTakeovers: verifiedWaitTakeoverRows }
              : {}),
            /** P-013: which row semantics this write actually ran under, so a caller
             *  never has to infer it from the counts. Present only when it was NOT the
             *  default, keeping the common reply shape unchanged. */
            ...(rowsMode !== 'replace' ? { rowsMode } : {}),
            /** P-013: under merge, `[]` deliberately means "change nothing" rather than
             *  "clear" — a clear must be explicit. Say so, or the caller reads a silent
             *  no-op as a clear that failed. */
            ...(rowsMode === 'merge' && (args.walls?.length === 0 || args.checks?.length === 0)
              ? {
                  rowsModeNote:
                    "rowsMode:'merge' treats an empty list as a NO-OP, not a clear — the carried rows are " +
                    "untouched. To clear, re-send with rowsMode:'replace' and [].",
                }
              : {}),
            /**
             * EI-19463731740128181: a supplied list REPLACES, so carried rows the caller
             * left out are GONE. The reply used to carry only these post-merge COUNTS —
             * which reveal a loss ONLY to a caller who recorded the prior count first, so
             * in practice the loss was silent behind `ok: true`. Adding one row to a
             * carried set is the most natural use of the parameter (and exactly what the
             * `checksLint` advisory below tells you to do), which is what made this bite.
             * Absent entirely when nothing was lost, so the common result shape is
             * unchanged. Claims are truncated: they identify WHICH row went, they are not
             * a restore payload. Mirrors work_items:checkpoint's `checksDropped`.
             */
            ...(droppedChecks.length
              ? {
                  checksDropped: droppedChecks.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)),
                  checksDroppedNote:
                    rowsMode === 'merge'
                      ? `CAP EVICTION, not a replace: rowsMode:'merge' UNIONED your ${effectiveChecks?.length ?? 0} ` +
                        `row(s) onto the carried set, the union exceeded the ${CARRY_NOTE_MAX_CHECKS}-row cap, and ` +
                        `${droppedChecks.length} CARRIED row(s) were evicted from the tail (supplied rows are kept ` +
                        `first). Re-sending the full set CANNOT fix this — that set is over the cap and would be ` +
                        `rejected as invalid_input. To keep them: RETIRE rows you no longer need in a separate ` +
                        `plain write (rowsMode:'replace'), then merge; or pass no \`checks\` at all to ` +
                        `leave the stored rows untouched.`
                      : `a supplied \`checks\` list REPLACES the carried set — ${droppedChecks.length} carried ` +
                        `claim(s) were not in this write and are now gone. To restore: re-send them (a re-sent claim ` +
                        `inherits its prior recheck/verified). To AVOID this next time, pass rowsMode:'merge' — ` +
                        `unmentioned rows then survive and you send only the rows you are changing; give a row an ` +
                        `\`id\` if you expect to re-word its claim.`,
                }
              : {}),
            /** Same contract for WALLS — and a dropped wall is worse than a dropped check:
             *  it is an owner-gated commitment, so losing one silently un-blocks work the
             *  owner never released. */
            ...(droppedWalls.length
              ? {
                  wallsDropped: droppedWalls.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)),
                  wallsDroppedNote:
                    rowsMode === 'merge'
                      ? `CAP EVICTION, not a replace: rowsMode:'merge' UNIONED your ${effectiveWalls?.length ?? 0} ` +
                        `row(s) onto the carried set, the union exceeded the ${CARRY_NOTE_MAX_WALLS}-row cap, and ` +
                        `${droppedWalls.length} CARRIED owner-gated commitment(s) were evicted from the tail ` +
                        `(supplied rows are kept first). Re-sending the full set CANNOT fix this — that set is over ` +
                        `the cap and would be rejected as invalid_input. To keep them: RETIRE rows you no longer need ` +
                        `in a separate plain write (rowsMode:'replace'), then merge; or pass no ` +
                        '`walls` at all to leave the stored rows untouched.'
                      : `a supplied \`walls\` list REPLACES the carried set — ${droppedWalls.length} carried ` +
                        `owner-gated commitment(s) were not in this write and are now gone. Re-send the FULL set, ` +
                        `pass no \`walls\` at all, or use rowsMode:'merge' so unmentioned rows survive.`,
                }
              : {}),
            /**
             * P-013: rows YOU supplied that the row cap cut. `checksDropped` above can
             * only see rows lost from the CARRIED set, so without this a 13th row sent
             * into a 12-row cap disappears behind `ok: true` — the same silence, one
             * step over. Absent when nothing overflowed.
             */
            ...(overflowChecks.length || overflowWalls.length
              ? {
                  ...(overflowChecks.length
                    ? { checksOverflowed: overflowChecks.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)) }
                    : {}),
                  ...(overflowWalls.length
                    ? { wallsOverflowed: overflowWalls.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)) }
                    : {}),
                  overflowNote:
                    `the row cap (${CARRY_NOTE_MAX_CHECKS} checks / ${CARRY_NOTE_MAX_WALLS} walls) cut ` +
                    `${overflowChecks.length + overflowWalls.length} row(s) YOU supplied — they were NOT stored. ` +
                    `Retire a carried row first (re-send the set you want under rowsMode:'replace'), ` +
                    `then add the new one.`,
                }
              : {}),
            /** WI-7264: fields trimmed to their soft cap so the write could SUCCEED instead
             *  of the whole note being rejected over one long field. Omitted when nothing
             *  was trimmed. Same never-silently-degrade contract as `rescued` below: the
             *  bytes really were cut, so the caller has to be told. */
            ...(repairs.length ? { repairs } : {}),
            // EI-18833865002636933: NEVER rescue silently. The original defect was that a
            // mangled note reached the cold wake looking like sloppy authoring, with
            // nothing saying it had been degraded — so a rescue must announce itself and
            // teach the correct call shape.
            ...(rescued
              ? {
                  rescued: {
                    from: 'tagged-blob',
                    recovered: Object.keys(rescued),
                    note:
                      'Your `did` was a whole structured note serialized as one XML-tagged string; it was PARSED ' +
                      'back into sections + typed rows and stored correctly. Pass { did, left, insight, next, ' +
                      'checks } as SEPARATE arguments — do not emit section tags inside a field value.',
                  },
                }
              : {}),
            ...(uncheckedClaims.length > 0
              ? {
                  checksLint: {
                    flagged: true,
                    note:
                      'checks_lint: prose line(s) assert external state (hash / id / instant) with NO matching ' +
                      'checks[]/walls[] probe — a carried claim without its check is the phantom-re-anchor shape. ' +
                      'Move each into checks:[{ claim, recheck, verified? }] so the probe travels with the claim. ' +
                      'Advisory only; the write was kept.',
                    lines: uncheckedClaims,
                  },
                }
              : {}),
            ...(absenceClaims.length > 0
              ? {
                  absenceLint: {
                    flagged: true,
                    note:
                      'absence_lint: this note asserts that something DOES NOT EXIST. That claim class is the ' +
                      'single most repeated diagnostic error in this codebase, it is expensive to act on (you ' +
                      'build the missing thing) and cheap to falsify (one reverse-grep), and your next wake — or ' +
                      'a cold successor, for whom this note is the ONLY memory — will read it as established ' +
                      'fact. Run each recheck NOW. If it holds, move it into checks:[{ claim, recheck, verified }] ' +
                      'so the evidence travels with the claim; if it does not, fix the note before it is inherited. ' +
                      'Search for the thing you say is ABSENT (who reads/calls/imports it), not just the thing you ' +
                      'say ignores it — an absence proved by one grep in one file is not proved. Advisory only; ' +
                      'the write was kept.',
                    claims: absenceClaims,
                  },
                }
              : {}),
            ...(scopeOverreach.length > 0
              ? {
                  scopeLint: {
                    flagged: true,
                    note:
                      'scope_lint: a ✓VERIFIED row claims MORE than its own re-check can observe — the claim is ' +
                      'quantified (no / never / every / all / today) while the probe declares a narrow bound. The ' +
                      '✓ badge is what a cold successor reads INSTEAD of re-checking, and a re-rendered row does ' +
                      'not decay — it hardens into settled fact. Either NARROW the claim to what the probe saw, ' +
                      'or WIDEN the probe and re-run it. Advisory only; the write was kept.',
                    rows: scopeOverreach,
                  },
                }
              : {}),
            ...(imperativeActions.length > 0
              ? {
                  imperativeLint: {
                    flagged: true,
                    note:
                      'imperative_lint: this carry-note instructs the next wake to invoke a singleton/shared-state ' +
                      'mutator whose precondition may be stale by wake time. Park the PRECONDITION as a runnable ' +
                      'checks:[{ claim, recheck }] row naming the same action; do not carry only the conclusion. ' +
                      'Advisory only; the write was kept.',
                    matches: imperativeActions,
                  },
                }
              : {}),
            ...(continuation ? { continuation } : {}),
            ...provenanceFields,
          }),
        },
      ],
    };
  },
});
