/**
 * work_items:checkpoint — the bee's work-item-scoped CHECKPOINT / carry-note write
 * (bee-context-efficiency-2026-06-14 Phase 3 / P-010·P-011·P-012; D-002, D-003).
 *
 * The bee translation of the Queen's self-authored carry-note: a bee writes a
 * compressed snapshot of its in-flight state at a task boundary / on graceful evict.
 * The NEXT invocation on the SAME work-item re-injects it in the spawn/wake-hydration
 * volatile tail (`### Carry-note (your last checkpoint)`, P-011) — so a re-woken bee OR
 * a SUCCESSOR bee after eviction resumes from the checkpoint instead of a cold start.
 * This is what lets fresh-context warm-inject (D-001) drop the grown transcript without
 * losing continuity: the transcript will NOT carry; the checkpoint is the continuity.
 *
 * setHiveCarryNote semantics (D-003): replace-on-write; omitted/blank/null ⇒ CLEARED
 * (the next invocation re-derives from the dossier alone — graceful degradation).
 * WORK-ITEM-scoped (D-002): the note lives on the item, so a successor inherits it.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): checkpoint ONE item inline
 * ({ id, checkpoint?, harness? }) or MANY (items:[{ id, checkpoint?, harness? }]) →
 * { ok, results:[{ ok, id, harness, cleared, length, contentHash, by | error }], counts }.
 * Each item resolves its own harness; one unresolvable item never fails the rest.
 *
 * EI-9036: `append: true` is an opt-in mode for the common "just add a short addendum
 * to my detailed checkpoint" case. Replace-on-write is the default and stays the
 * default — a caller who forgets `append` gets EXACTLY today's behavior, no surprise
 * either direction. With `append: true`, the tool reads the CURRENT stored checkpoint
 * first (via the same reader path a future pickup uses) and joins the new text onto it
 * with a `---` separator, instead of overwriting it — so an incremental progress note
 * can never silently discard a detailed prior record. Still bounded to the 32000-char
 * cap: if the join would exceed it, the OLDEST content is trimmed (with a visible
 * `[older checkpoint content truncated]` marker) so the newest addendum is never the
 * part that gets cut. `append: true` with a blank/omitted checkpoint text is rejected
 * (append + clear is a contradiction) rather than silently falling back to a clear.
 *
 * EI-8987: `contentHash` is a short sha256 (first 12 hex chars) of the STORED text —
 * computed from what the store actually persisted (the same trimmed string
 * setWorkItemCheckpoint returns), not from the caller's input — so a paranoid caller
 * can round-trip-verify a write landed byte-for-byte in the SAME call, no second
 * work_items:get read needed. Null when cleared (nothing was stored). This is a
 * defense-in-depth addition on top of EI-8824 (the actual silent-loss bug, already
 * fixed) and EI-8885 (checkpointAgeMs on work_items:get) — belt-and-suspenders so a
 * FUTURE silent-loss bug class is caught at write time, not discovered post-compaction.
 *
 * EI-9325: a plain replace-on-write (not append, not a clear) that shrinks a
 * substantial prior checkpoint by more than half gets a non-blocking `shrinkWarning`
 * on the result — the caller-side footgun this was filed against is a rewrite that
 * INTENDED to preserve prior content verbatim (e.g. prepending a new section by hand)
 * but instead wrote a placeholder/marker line, silently truncating a detailed
 * checkpoint with no built-in signal that data was lost. Uses
 * `setWorkItemCheckpointWithPrior`, which surfaces the prior length for FREE (the row
 * is already SELECTed FOR UPDATE inside the write transaction to build the journal
 * ring) — no extra round-trip, so the existing "plain replace never pre-reads"
 * contract (see the append-mode tests) is unaffected.
 *
 * EI-18140632570924965: EI-9325's shrinkWarning was WARN-ONLY — it still executed
 * the destructive write in the same call. Confirmed live: a plain replace on WI-4487
 * (a 19,348-char / 5-day / 4-agent forensic record) silently collapsed it to 739
 * chars; only the shrinkWarning in the response let the caller notice and restore
 * from a prior Read. Fix: the SAME shrink condition now BLOCKS the write by default
 * (`shrink_blocked`, no data touched — the guard runs inside
 * setWorkItemCheckpointWithPrior's locked transaction, before the DELETE/INSERT) —
 * pass `append: true` to join instead (the item's own convention here — every real
 * checkpoint on a long-running ticket already separates dated sections with `---`),
 * or `confirmShrink: true` when a genuine replace is intended. The blocked result
 * carries both recovery shapes as structured data, so a successor does not have
 * to infer the retry from prose after a context boundary.
 *
 * EI-18132462898750489: NO ownership guard existed — any agent could checkpoint (or
 * CLEAR) an item it does not hold, silently overwriting the actual assignee's
 * in-flight state. Confirmed live: a fleet member (su-2e534e59) that had only READ
 * WI-5557 via work_items:get (assignee su-a7d08fd3, a different live agent) called
 * this tool on it anyway; the write succeeded with no signal that the caller wasn't
 * the holder. Believing the silent success proved ownership, that agent then told
 * its OWN compaction summary "Currently holding WI-5557" — a false directive that
 * would have caused its successor to edit the item concurrently with its real
 * holder had the successor not independently re-verified via coord:orient. The
 * checkpoint text itself shows this had already happened at least once before
 * ("a prior holder's detailed design got lost when overwritten by a meta-checkpoint").
 * Fix: refuse the write per-item when the item has an assignee and it is not the
 * caller (`not_holder`) — this is the exploitable surface (the item's own
 * `taken_by`/`assignee` column is the authoritative holder signal); an unassigned
 * item (about to be claimed) or one already assigned to the caller still writes
 * normally. A caller that wants to leave a note on an item it doesn't hold has
 * work_items:comment for that.
 *
 * EI-18665443723911343: the single-shorthand `append`/`confirmShrink` booleans
 * intermittently rejected a caller's `true`/`false` with "expected boolean, received
 * string", while the byte-identical value sent through `items:[{ ... }]` parsed fine
 * on the same session, minutes apart — a rejected write on the exact surface whose job
 * is surviving a context boundary. Fix: `looseBoolean()` preprocesses the two literal
 * strings `"true"`/`"false"` to their boolean value ahead of the zod boolean check, on
 * both the shorthand and the `items[]` fields, so the two paths accept identical input.
 * Deliberately NOT `z.coerce.boolean()` — that coerces via `Boolean(x)`, which would
 * turn the string `"false"` into `true`.
 *
 * WI-7190: `append: true` used to arm NO shrink guard at all — the one mode whose
 * whole contract is "never lose the existing text" was the mode with no shrink
 * protection. Confirmed live: a caller's append pre-read (the `getWorkItemCheckpoint`
 * call above, used only to build the joined text) came back empty on a resolvable
 * item while a real 10,671-char checkpoint existed — the join then had nothing to
 * join onto, `checkpointToStore` collapsed to just the addendum, and the write
 * silently REPLACED the prior checkpoint while still returning
 * `ok:true, verified:true`. Fix: the append path now ALSO arms a guard — run inside
 * the SAME locked write transaction as `setWorkItemCheckpointWithPrior`'s own prior
 * read — that compares what the tool's separate pre-read saw against the
 * AUTHORITATIVE prior read at write time. If the pre-read came back
 * null/empty/errored while the authoritative prior is substantial (>500 chars), the
 * write is refused (`append_base_unreadable`) instead of silently degrading to a
 * replace. `confirmShrink: true` still forces it through (same escape hatch as the
 * plain-replace guard), for a caller that genuinely wants to reset the checkpoint.
 *
 * EI-19447043119380534: `{ id, checks }` with `checkpoint` OMITTED used to DESTROY the
 * body — it rendered a note consisting only of the `## Checks` section and returned
 * ok:true. Confirmed live (9376 → 1562 chars) and reproduced in test: the plan and the
 * file-by-file record were gone, and with `checks: []` the note collapsed to null
 * outright. The shape was uniquely bad because the two adjacent fields had OPPOSITE
 * omission defaults (an omitted `checks` PRESERVES, by its own documented contract)
 * and because the >50% shrink guard structurally could not fire: `isPlainReplace`
 * requires a non-empty replacement body, so the guard armed for the DELIBERATE case
 * and skipped the ACCIDENTAL one. Fix: an omitted `checkpoint` alongside `checks` is a
 * checks-only PATCH that carries the stored body forward (read inside the store's
 * locked transaction, so a concurrent writer cannot interleave). An explicit clear
 * stays reachable via `checkpoint: null`/`''`, and a bare `{ id }` still clears — the
 * contract work_items:complete's terminal cleanup depends on.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemCheckpointWithPrior, getWorkItemCheckpoint } from '../../work-item-checkpoint';
import { SUPPORTED_DEP_KINDS } from '../../freshness/resolvers';
import { markFeatureProgress, markIssueProgress, isClaimHoldParked } from '../../work-items';
import { lookupWorkItem } from './_lookup';
import { detectPauseDeclaration, pauseNotEnforcedWarning } from '../../carry-note-pause-declaration';
import { runBulk, bulkContent } from '../_bulk';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { carryProvenanceFields } from '../../carry-surface-provenance-stamp';
import {
  CARRY_CAP_HARD_MULTIPLE,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_ROW_SOFT_CAPS,
  type CarryArgRepair,
  normalizeCheckEntries,
  splitCarryNoteChecks,
  truncateCarryField,
  withCarryNoteChecks,
} from '../../carry-note';

/** First 12 hex chars of sha256(text) — short enough to eyeball, long enough that an
 *  accidental collision between two DIFFERENT checkpoint bodies is not a real concern. */
function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * EI-18665443723911343: the single-shorthand `append`/`confirmShrink` booleans were
 * observed rejecting a caller-supplied `true`/`false` STRING ("expected boolean,
 * received string") on the exact same tool call shape that accepts a real boolean —
 * while the identical value sent through `items:[{ ... }]` parsed fine. Rather than
 * chase the intermittent string-vs-boolean arrival (client/transport serialization,
 * outside this tool's control) at its source, make the shorthand booleans tolerant of
 * their own literal string form: a plain `z.coerce.boolean()` is NOT safe here (JS
 * `Boolean("false")` is `true` — it would silently invert a caller's explicit
 * `"false"`), so this preprocesses ONLY the exact strings `"true"`/`"false"` to their
 * boolean value and leaves every other input (including a real boolean, or a typo'd
 * string) to fail the normal boolean check untouched.
 */
function looseBoolean() {
  return z.preprocess((v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }, z.boolean().optional());
}

/** Hard cap on a stored checkpoint (matches the `checkpoint` arg's max). */
const CHECKPOINT_CAP = 32000;
const TRUNCATION_MARKER = '…[older checkpoint content truncated]…\n';

/** EI-9036: join an addendum onto the prior checkpoint text, bounded to CHECKPOINT_CAP.
 *  Trims from the FRONT (oldest content) when the join would overflow, so the newest
 *  addendum — the part the caller just wrote and cares most about right now — is never
 *  the part that gets cut. */
function joinCheckpoint(prior: string | null, addendum: string): string {
  const joined = prior && prior.length > 0 ? `${prior}\n\n---\n${addendum}` : addendum;
  if (joined.length <= CHECKPOINT_CAP) return joined;
  const keep = CHECKPOINT_CAP - TRUNCATION_MARKER.length;
  // keep <= 0 only if CHECKPOINT_CAP is absurdly small; guard against a negative slice.
  return TRUNCATION_MARKER + joined.slice(joined.length - Math.max(keep, 0));
}

/**
 * P-007/D-013: the declared-dependency arg, shared by the single shorthand and
 * `items[]`. Tri-state — OMITTED preserves the existing declaration (so an append
 * or a plain re-write never silently drops it), `[]` clears it, a list re-stamps.
 */
function dependsOnSpec() {
  return z
    .array(z.string().min(1).max(300))
    .max(24)
    .optional()
    .describe(
      'P-007 freshness: what this checkpoint is derived FROM, as `kind:ref` tags — ' +
        `supported kinds: ${SUPPORTED_DEP_KINDS.join(', ')} ` +
        '(e.g. "file:packages/operator-core/lib/x.ts", "work-item:WI-6198", "plan:my-plan-slug"). ' +
        "Each is resolved to a version token and stamped NOW, so a later reader is told WHICH dependency " +
        'moved instead of guessing from the checkpoint\'s age. Declaring them makes an OLD checkpoint ' +
        'readable as fresh when nothing moved, and — the case no age threshold can catch — a SECONDS-OLD ' +
        "one as stale when a PEER changed a file it depends on. Omit to keep the previous declaration; " +
        'pass [] to clear it.',
    );
}

/**
 * EI-19298690705878336: the verified-vs-asserted marking, reused from the SAME
 * `carry-note` machinery `loop:checkpoint` already exposes — deliberately not a
 * second, drifting notion of what a carried claim is.
 *
 * The gap this closes: a work-item checkpoint could carry a confident factual
 * claim with no way to mark whether it had been VERIFIED or merely predicted, and
 * the checkpoint re-injects on every subsequent invocation of the item in the
 * author's own voice. A wrong claim therefore reads as better-established on each
 * re-read rather than more suspect. Root incident: an assertion about a plan
 * item's scope survived FIVE consecutive wakes, was restated each time, and was
 * refuted by a single query nobody ran because nothing said it was unverified.
 *
 * That surface matters more here than on the loop note: a loop note is read by the
 * author's own next wake, whereas a work-item checkpoint is what an unrelated
 * SUCCESSOR inherits — the reader least able to tell an asserted claim from a
 * checked one.
 */
function checksSpec() {
  return z
    .array(
      z.object({
        // EI-19400299440742193: these are SANITY BACKSTOPS, not the real limits. The
        // real caps (CARRY_ROW_SOFT_CAPS) are enforced by TRUNCATION in the handler.
        // A zod `.max()` rejects the WHOLE CALL, so a `recheck` a few chars over 300
        // used to discard the entire accompanying multi-KB checkpoint and the agent
        // re-sent it — the bytes paid twice, and, worse, an item could be left with NO
        // durable state at the moment its session ended. Measured over a 6-day window:
        // 6 of the 9 schema rejections on this tool were exactly this, 32,967 chars.
        // Same fix as WI-7264 landed for loop:checkpoint, reusing its helpers.
        claim: z
          .string()
          .min(1)
          .max(CARRY_ROW_SOFT_CAPS.claim * CARRY_CAP_HARD_MULTIPLE)
          .describe('The claim about external state, stated concretely.'),
        recheck: z
          .string()
          .max(CARRY_ROW_SOFT_CAPS.recheck * CARRY_CAP_HARD_MULTIPLE)
          .optional()
          .describe('The concrete probe that would falsify the claim.'),
        verified: z
          .string()
          .max(CARRY_ROW_SOFT_CAPS.verified * CARRY_CAP_HARD_MULTIPLE)
          .optional()
          .describe(
            'The EVIDENCE STRING (what you actually observed), NOT a boolean — `true`/`false` is rejected. ' +
              'Presence renders the row ✓ VERIFIED; omitting it entirely renders ? PREDICTED, telling a ' +
              'successor to run `recheck` before relying on the claim.',
          ),
      }),
    )
    .max(CARRY_NOTE_MAX_CHECKS)
    .optional()
    .describe(
      'Carried CHECKS — claims about EXTERNAL state paired with the probe that falsifies them, rendered as a ' +
        '`## Checks` section every time this checkpoint is re-injected. Put hash/id/timestamp/state expectations ' +
        'HERE rather than in checkpoint prose, so the probe travels with the claim and a successor can tell an ' +
        'ASSERTED claim from a VERIFIED one. Carry-forward semantics: OMITTED preserves the existing rows (a ' +
        'plain rewrite never silently drops them) and [] clears them. With `append: true` a supplied list is ' +
        `UNIONED onto the carried set (supplied wins on matching claim text), but capped at ` +
        `${CARRY_NOTE_MAX_CHECKS}: an overflow EVICTS THE CARRIED TAIL, so an additive write CAN drop rows. ` +
        'WITHOUT append a supplied list REPLACES the set: send the FULL set you want stored, ' +
        'because any stored claim you leave out is DROPPED — that is how you RETIRE a stale check. A supplied ' +
        'row whose claim text matches a stored one inherits that row\'s recheck/verified/sinceMs when you omit ' +
        'them, so re-sending a claim never loses its evidence. Rows dropped come back as `checksDropped`.',
    );
}

const itemSpec = z.object({
  id: z.string().min(1).describe('the work-item id to checkpoint'),
  /** The compressed in-flight state. Blank / null / omitted ⇒ CLEAR the checkpoint —
   *  EXCEPT omitted alongside `checks`, which is a checks-only patch (EI-19447043119380534). */
  checkpoint: z
    .string()
    .max(32000)
    .nullish()
    .describe('compressed in-flight state; blank/null ⇒ clear (omitted WITH `checks` ⇒ checks-only patch, body kept)'),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default / ctx / item lookup)'),
  append: looseBoolean().describe(
    'EI-9036: append `checkpoint` onto the EXISTING stored checkpoint (joined with a `---` separator) instead ' +
      'of replacing it. Makes the WHOLE write additive: supplied `checks` are UNIONED onto the carried set ' +
      'rather than replacing it (EI-19944669306930709). Reads the current checkpoint first via the same path a ' +
      'future pickup uses. Requires a non-blank `checkpoint` (append + clear is contradictory — rejected, not ' +
      'silently treated as a clear). Bounded to the 32000-char cap: the OLDEST content is trimmed first if the ' +
      'join would overflow it.',
  ),
  confirmShrink: looseBoolean().describe(
    'EI-18140632570924965: a plain replace (no append) that would shrink a substantial prior checkpoint by ' +
      'more than half is BLOCKED (`shrink_blocked`) by default. Pass true to confirm the replace is intentional.',
  ),
  dependsOn: dependsOnSpec(),
  checks: checksSpec(),
});

export default defineTool({
  name: 'work_items:checkpoint',
  profile: 'engineer',
  description:
    "Write (or clear) one OR many work-items' checkpoints — a compressed snapshot of your in-flight state. " +
    'Single: { id, checkpoint? }. Many: items:[{ id, checkpoint?, harness? }]. ' +
    'Your transcript does NOT carry across a task boundary / re-spawn; the checkpoint is your continuity, ' +
    "re-injected on the next invocation of that item (yours or a successor's). Replace-on-write; `append:true` joins instead. " +
    'Returns { ok, results:[{ ok, id, harness, cleared, length, contentHash, verified, storedHead, by | error }], counts }. ' +
    'Writes are verify-read (checkpoint_verify_failed on a miss); a plain replace shrinking a substantial checkpoint ' +
    '>50%, or an append with a disagreeing pre-read, is BLOCKED (`shrink_blocked` / `append_base_unreadable` — ' +
    'the refusal includes `errorCode` + structured `recovery` args: `append:true` to preserve prior content, or ' +
    '`append:false, confirmShrink:true` only for an intentional full replacement). Refuses a peer-held item (`not_holder`).',
  guidance: {
    when:
      'At a task boundary or on graceful eviction, before you finish/yield: persist what a successor (or your ' +
      'next wake) needs — what is done, left, current approach, gotchas. A digest, not a transcript. ' +
      'Declare `dependsOn` for a real freshness verdict.',
    notWhen:
      'Mid-task scratch the live transcript already holds; never dump file contents or tool output. Not an edit ' +
      'channel: use work_items:update for the body, work_items:comment for a note. Not for a peer\'s item — claim it, or comment instead.',
    chaining:
      'Call before work_items:complete / on yield; blank clears a stale note. For a concise successor addendum to a ' +
      'detailed prior note, pass append:true. For an intentional full replacement, include confirmShrink:true. ' +
      'Doubles as a liveness pulse — a claim held through long local-only tool use can go presence-stale and be reclaimed.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `checkpoint`)'),
      /** The compressed in-flight state. Blank / null / omitted ⇒ CLEAR the checkpoint —
       *  EXCEPT omitted alongside `checks`, which is a checks-only patch (EI-19447043119380534). */
      checkpoint: z
        .string()
        .max(32000)
        .nullish()
        .describe('single shorthand: compressed in-flight state; blank/null ⇒ clear (omitted WITH `checks` ⇒ checks-only patch)'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('checkpoint many work-items at once — each { id, checkpoint?, harness?, append? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
      append: looseBoolean().describe(
        'single shorthand default for `append` (EI-9036): join `checkpoint` onto the existing stored checkpoint ' +
          'instead of replacing it, and UNION supplied `checks` onto the carried set instead of replacing them ' +
          '(EI-19944669306930709). Also the default applied to any `items[]` entry that omits its own `append`.',
      ),
      confirmShrink: looseBoolean().describe(
        'single shorthand default for `confirmShrink` (EI-18140632570924965), also the items[] default.',
      ),
      checks: checksSpec(),
      dependsOn: dependsOnSpec(),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id, checkpoint? } for one, or items:[{ id, checkpoint? }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null; workspaceId?: string | null };
    const items = args.items?.length
      ? args.items
      : [
          {
            id: args.id as string,
            checkpoint: args.checkpoint,
            harness: args.harness,
            append: args.append,
            confirmShrink: args.confirmShrink,
            dependsOn: args.dependsOn,
          },
        ];
    const env = await runBulk(
      items,
      async (it) => {
        // EI-8805: KEY the checkpoint by the ITEM's OWN harness so the write agrees
        // with the read (work_items:get keys by the resolved item.harness). A
        // harness-null item — an issue-family EI filed from an unscoped su session —
        // must NOT be keyed under the session's harness ('*' or a scoped slug): the
        // read looks it up under the item's own null harness, and the mismatch
        // silently loses the checkpoint. The caller's arg/ctx harness is only a
        // disambiguation HINT for a feature id that repeats across harnesses; the '*'
        // wildcard is not a real harness filter.
        const hint = it.harness ?? args.harness ?? c.harnessSlug ?? undefined;
        const hintHarness = hint && hint !== '*' ? hint : undefined;
        // WI-6746: this pre-read IS the ownership guard below — setWorkItemCheckpoint has
        // no assignee check. Swallowing it to null (the old `.catch(() => null)`) meant a PG
        // fault skipped `not_holder` entirely and the write landed on whatever item it was
        // aimed at, overwriting a peer's in-flight state — the exact corruption
        // EI-18132462898750489 added the guard to stop, and it failed open precisely when
        // the database was unhealthy. Fail CLOSED: unreadable is not unowned.
        const lookup = await lookupWorkItem(it.id, hintHarness);
        if (lookup.status === 'unreadable') {
          return {
            ok: false as const,
            id: it.id,
            error:
              `work_item_unreadable — could not read '${it.id}' to verify you hold it (${lookup.error}). ` +
              "Refusing the checkpoint write rather than risk silently overwriting the real holder's in-flight state. " +
              'This is a READ FAILURE, not a missing item and not a harness-resolution problem — retry, and if it ' +
              'persists check database health (dev:pg_health). Your checkpoint text was NOT saved.',
          };
        }
        const item = lookup.status === 'found' ? lookup.item : null;
        if (!item && !hintHarness) {
          return { ok: false as const, id: it.id, error: `could not resolve a harness for work_item '${it.id}' — pass { harness }` };
        }
        // EI-18132462898750489: refuse a checkpoint write/clear on an item ASSIGNED to
        // someone else. Before this guard the write silently succeeded for anyone, which
        // both corrupted the real holder's in-flight state and gave the writer a false
        // "I must hold this, my checkpoint write succeeded" signal — the confirmed root
        // cause of a false "currently holding" directive surviving into a compaction
        // summary. An unassigned item (assignee null/undefined — about to be claimed, or
        // an older row shape) or one already assigned to the caller is unaffected.
        if (item && item.assignee && item.assignee !== ident.ownerId) {
          return {
            ok: false as const,
            id: it.id,
            error:
              `not_holder — work_item '${it.id}' is assigned to ${item.assignee}, not you (${ident.ownerId}). ` +
              'Checkpointing an item you do not hold would silently overwrite its real holder\'s in-flight state. ' +
              'Leave a note instead with work_items:comment, or work_items:claim it first if you are taking it over.',
          };
        }
        // The item's own harness is authoritative (null for a harness-null item — the
        // store canonicalizes it). Fall back to the hint only when the item can't be
        // resolved (e.g. a not-yet-persisted id).
        const harness: string | null = item ? item.harness ?? null : hintHarness ?? null;
        const workspaceId = resolveConcreteWorkspaceId(c.workspaceId);
        // EI-9036: append:true joins onto the EXISTING checkpoint instead of replacing
        // it — the fix for the "meant to add a short addendum, silently wiped the
        // detailed prior note" trap. append + a blank/omitted checkpoint is a
        // contradiction (append has nothing to append, and blank normally means
        // CLEAR) — reject it loudly rather than guessing which the caller meant.
        const wantsAppend = it.append ?? args.append ?? false;
        if (wantsAppend && !(it.checkpoint && it.checkpoint.length > 0)) {
          return {
            ok: false as const,
            id: it.id,
            error: 'append:true requires a non-blank `checkpoint` — append has nothing to append, and blank normally means clear (contradiction).',
          };
        }
        let checkpointToStore = it.checkpoint;
        // WI-7190: this pre-read is a SEPARATE call (getWorkItemCheckpoint) from the
        // authoritative prior the write transaction reads a few lines below (inside
        // setWorkItemCheckpointWithPrior's own SELECT ... FOR UPDATE). Track what it
        // saw — `appendPriorRaw` (null/failed vs. real content) — so the guard below
        // can catch the two paths disagreeing BEFORE the write commits, instead of
        // silently joining onto nothing and clobbering a real prior checkpoint while
        // still reporting ok:true/verified:true.
        let appendPriorRaw: string | null = null;
        let appendPreReadFailed = false;
        if (wantsAppend && it.checkpoint) {
          try {
            appendPriorRaw = await getWorkItemCheckpoint({ harness, workItemId: it.id, workspaceId });
          } catch {
            appendPriorRaw = null;
            appendPreReadFailed = true;
          }
          // EI-19298690705878336: strip any rendered `## Checks` section out of the
          // prior BEFORE joining. That section runs to the end of the document (there
          // is no following heading to bound it), so appending after it would bury the
          // addendum INSIDE the section — where the re-render then drops it as an
          // unparseable row. Caught by test: the addendum vanished entirely.
          // The rows are NOT lost by stripping here: the transform below recovers them
          // from the stored prior note, which the store reads inside its own locked
          // transaction.
          const priorBody = appendPriorRaw !== null ? splitCarryNoteChecks(appendPriorRaw).body : null;
          checkpointToStore = joinCheckpoint(priorBody, it.checkpoint);
        }
        // EI-8824: c.workspaceId is '*' for an unscoped superuser session (the
        // read-scoping wildcard) — passing it straight through as `?? undefined`
        // let the truthy '*' win and persisted the checkpoint under a literal
        // workspace_id='*' row that no concrete-workspace read (work_items:get's
        // getWorkItemCheckpoint, which never resolves to '*') can ever see. Same
        // bug class as EI-3409/WI-892; resolveConcreteWorkspaceId is the fix.
        //
        // EI-9325: a PLAIN replace (not append, not a clear) is the shrink-risk case
        // this footgun report described — the caller means to paste the FULL prior
        // content verbatim (e.g. prepending a new section by hand) and instead writes
        // a placeholder/marker line, silently truncating a detailed checkpoint. Use
        // the *WithPrior variant ONLY on that path: it costs no extra round-trip (the
        // row is already SELECTed FOR UPDATE inside the same write transaction to
        // build the journal ring) and gives us the prior length for free to warn on.
        // append mode already reads + folds the prior text explicitly above, so it
        // can't hit this failure mode; a clear has no "shrink" to warn about either.
        // EI-18140632570924965: a plain replace (not append, not a clear) that
        // would shrink a substantial prior checkpoint by more than half is BLOCKED
        // by default — the same threshold EI-9325's shrinkWarning already used to
        // WARN, now enforced as a guard. Confirmed live: a caller relying on the
        // warn-only nudge still executed the destructive write before noticing it.
        // `confirmShrink:true` opts back into the old warn-only behavior for a
        // genuinely intentional replace. The guard runs INSIDE the store's locked
        // transaction (see setCarryNoteWithPrior) — no separate read-then-write
        // race between the check and the write.
        const wantsConfirmShrink = it.confirmShrink ?? args.confirmShrink ?? false;
        let priorLength: number | null = null;
        let stored: string | null;
        let blockedReason: string | undefined;
        // P-007: `dependsOn` is tri-state at the store (undefined ⇒ preserve the
        // existing declaration, [] ⇒ clear, list ⇒ re-stamp), so only forward the
        // key when the caller actually supplied one.
        const declaredDeps = it.dependsOn ?? args.dependsOn;
        const depsOpt = declaredDeps !== undefined ? { dependsOn: declaredDeps } : {};
        // Both branches go through setWorkItemCheckpointWithPrior — the plain
        // setWorkItemCheckpoint is only a wrapper over it, so unifying costs nothing
        // and lets the shrink guard, the prior length AND the P-007 dependency
        // stamping apply on the append/clear paths too.
        const isPlainReplace = !wantsAppend && !!checkpointToStore && checkpointToStore.length > 0;
        const newLength = checkpointToStore?.length ?? 0;
        // EI-19298690705878336: `checks` rows are rendered INTO the stored note, so a
        // write must MERGE them against the prior note rather than replace it — and
        // that merge has to happen inside the store's locked transaction, or a
        // concurrent writer on the same item can interleave between our read and our
        // write. Hence the `transform` seam rather than a read-then-write here.
        // EI-19400299440742193: enforce the SOFT row caps by TRUNCATION, here, after the
        // schema's backstop let the call through. The cap's job is to bound what
        // re-injects into every future pickup of this item — truncation does that just
        // as well as rejection did, without discarding the whole checkpoint. Every trim
        // is REPORTED below: a cut the caller cannot see is the EI-18723223344390510
        // failure mode, where a row was quietly reshaped and a verified check's evidence
        // was destroyed with no signal.
        const repairs: CarryArgRepair[] = [];
        const rawSuppliedChecks = it.checks ?? args.checks;
        const suppliedChecks = rawSuppliedChecks?.map((row, i) => {
          const out = { ...row };
          out.claim = truncateCarryField(out.claim, CARRY_ROW_SOFT_CAPS.claim, `checks[${i}].claim`, repairs);
          if (typeof out.recheck === 'string')
            out.recheck = truncateCarryField(out.recheck, CARRY_ROW_SOFT_CAPS.recheck, `checks[${i}].recheck`, repairs);
          if (typeof out.verified === 'string')
            out.verified = truncateCarryField(
              out.verified,
              CARRY_ROW_SOFT_CAPS.verified,
              `checks[${i}].verified`,
              repairs,
            );
          return out;
        });
        const isClear = !(checkpointToStore && checkpointToStore.length > 0);
        // EI-19447043119380534: `checks` supplied while `checkpoint` is ENTIRELY OMITTED
        // (undefined — NOT an explicit null/'' clear) is a checks-only PATCH: carry the
        // stored body forward instead of rendering a body-less note. Confirmed live: a
        // 9376-char checkpoint became 1562 chars of bare `## Checks`, ok:true, with the
        // plan and the file-by-file record gone.
        //
        // Two properties made this the worst possible shape. Within ONE call an omitted
        // `checks` PRESERVES (documented) while an omitted `checkpoint` DESTROYED — the
        // safe-to-omit and catastrophic-to-omit fields sat adjacent with opposite
        // defaults. And the >50% shrink guard could never fire here: `isPlainReplace`
        // requires a non-empty replacement body, which this path by definition lacks, so
        // the guard armed for the DELIBERATE case (an explicitly-provided shorter body)
        // and skipped the ACCIDENTAL one.
        //
        // `checkpoint` is `.nullish()`, so undefined (omitted) is distinguishable from an
        // explicit null — a real clear stays reachable via { checkpoint: null } (or ''),
        // and a bare { id } with no checks still clears, which is the contract
        // work_items:complete's terminal cleanup and "blank clears a stale note" rely on.
        const isChecksOnlyPatch = it.checkpoint === undefined && suppliedChecks !== undefined && !wantsAppend;
        // A CLEAR wipes the checks too, UNLESS the caller supplied some in the same
        // call. This is a DELIBERATE divergence from loop:checkpoint, where checks
        // survive a note clear: work_items:complete clears the checkpoint as terminal
        // cleanup, and rows surviving that would resurrect a checks-only checkpoint on
        // an already-closed item.
        // EI-19460631385508515: a SUPPLIED `checks` list REPLACES the stored set —
        // normalizeCheckEntries iterates only the incoming rows and uses the prior set
        // solely to inherit recheck/verified/sinceMs onto claims that reappear. A stored
        // claim the caller leaves out is therefore DROPPED, silently. That is defensible
        // as semantics (it is the only way to retire a stale check) but it was documented
        // as "a list merges by claim text", which promises a UNION — so an agent updating
        // ONE row to mark it verified would lose the others and the reply's `checks` count
        // (read off the stored note) was the only trace. The doc now says REPLACES; this
        // captures what went missing so the loss is VISIBLE in the result rather than
        // inferable only by diffing a count you would have to have recorded beforehand.
        let droppedCheckClaims: string[] = [];
        const checksTransform =
          suppliedChecks !== undefined || !isClear
            ? (priorNote: string | null, incoming: string | null | undefined) => {
                const priorSplit = splitCarryNoteChecks(priorNote);
                const prior = priorSplit.checks;
                // `incoming` may carry its OWN rendered `## Checks` — append mode folds
                // the whole prior note in, section and all — so strip it before
                // re-attaching or the note ends up with two Checks sections.
                const { body: incomingBody } = splitCarryNoteChecks(incoming ?? '');
                // EI-19447043119380534: on a checks-only patch the caller supplied no body
                // at all, so the STORED one is the body — read authoritatively here, inside
                // the store's locked transaction, so a concurrent writer cannot interleave.
                const body = isChecksOnlyPatch ? priorSplit.body : incomingBody;
                // EI-19944669306930709: under `append: true` the supplied rows are
                // UNIONED onto the carried set instead of replacing it. `append` is an
                // explicit declaration that this write is ADDITIVE, and it governed only
                // the body — so "append a progress note, and record the one claim I just
                // verified", the single most natural incremental write, destroyed every
                // other carried check. Reported twice in one session ~25min apart by an
                // agent who had already READ the replace-semantics warning: the rule was
                // known and did not help, because `append: true` in the same call frames
                // the whole invocation as additive and `checks` reads as one more field
                // of it.
                //
                // EI-19460631385508515 made that loss VISIBLE (`checksDropped`). Visible
                // is not prevented: the report is after-the-fact, rides on an `ok: true`,
                // and recovery means re-sending the full set verbatim — where any claim
                // whose text you retype slightly differently loses its inherited
                // recheck/verified and silently becomes a new, unevidenced row. Under an
                // explicitly additive write there is nothing to trade off, so prevent it.
                //
                // Order matters: supplied FIRST. normalizeCheckEntries dedups by claim
                // text (first occurrence wins) and caps at CARRY_NOTE_MAX_CHECKS, so a
                // re-sent claim updates in place rather than duplicating, and if the cap
                // bites it is the carried tail that yields — never the row the caller
                // just told us mattered. A carried row passed through inherits from
                // itself, so its evidence and original sinceMs survive untouched.
                //
                // PLAIN (non-append) replace is deliberately UNCHANGED: it is the only
                // way to RETIRE a stale check, and dropping that would trade one footgun
                // for another. Retiring a row while appending is two calls, by design.
                const effectiveChecks =
                  suppliedChecks === undefined ? undefined : wantsAppend ? [...suppliedChecks, ...prior] : suppliedChecks;
                const merged =
                  effectiveChecks !== undefined ? normalizeCheckEntries(effectiveChecks, prior) : prior;
                // Recomputed on every transform invocation (the store may retry it under
                // its lock) so the last run — the one whose result is stored — wins.
                const keptClaims = new Set(merged.map((c) => c.claim.trim()));
                droppedCheckClaims = prior
                  .map((c) => c.claim.trim())
                  .filter((claim) => claim.length > 0 && !keptClaims.has(claim));
                if (merged.length === 0) return body.length > 0 ? body : null;
                const rendered = withCarryNoteChecks(body, merged);
                if (rendered.length <= CHECKPOINT_CAP) return rendered;
                // Over cap: trim the BODY from the front (oldest content) and re-attach,
                // so the checks — bounded to CARRY_NOTE_MAX_CHECKS rows — are never the
                // part that gets cut. Mirrors joinCheckpoint's front-trim rationale.
                const overflow = rendered.length - CHECKPOINT_CAP + TRUNCATION_MARKER.length;
                const trimmedBody = TRUNCATION_MARKER + body.slice(Math.min(overflow, body.length));
                return withCarryNoteChecks(trimmedBody, merged);
              }
            : undefined;
        const res = await setWorkItemCheckpointWithPrior({ harness, workItemId: it.id, workspaceId }, checkpointToStore, {
          ...(checksTransform ? { transform: checksTransform } : {}),
          guard:
            isPlainReplace && !wantsConfirmShrink
              ? (_priorNote, priorLen) =>
                  priorLen > 500 && newLength < priorLen * 0.5
                    ? `plain replace would shrink the checkpoint from ${priorLen} to ${newLength} chars (>50% loss). ` +
                      'Pass { append: true } to join onto the existing checkpoint instead, or { confirmShrink: true } ' +
                      'if this replace is intentional.'
                    : null
              : wantsAppend && !wantsConfirmShrink
                ? // WI-7190: `append:true` used to arm NO guard at all — "the one mode whose
                  // whole contract is 'never lose the existing text' was the mode with no
                  // shrink protection." Confirmed live: the tool's own pre-read
                  // (getWorkItemCheckpoint, above) came back empty on a resolvable item while
                  // a 10,671-char checkpoint genuinely existed — the join then had nothing to
                  // join onto, so `checkpointToStore` was just the addendum, and the write
                  // silently REPLACED the real checkpoint while still returning
                  // ok:true/verified:true. `_priorNote`/`priorLen` here are the AUTHORITATIVE
                  // prior — read inside this same locked transaction, independent of the
                  // tool's separate pre-read above — so disagreement between the two is
                  // exactly the failure signature: the write path resolves the item, the
                  // (different) read path used to build the join does not.
                  (_priorNote, priorLen) =>
                    priorLen > 500 && (appendPriorRaw === null || appendPriorRaw.length === 0)
                      ? `append_base_unreadable — the append pre-read returned ${appendPreReadFailed ? 'an error' : 'nothing'} ` +
                        `while the current checkpoint is ${priorLen} chars (read authoritatively at write time, inside ` +
                        'the same locked transaction as this write). Appending now would silently REPLACE it instead of ' +
                        'joining — refusing the write rather than losing it. Retry (a transient read/key mismatch is the ' +
                        'likely cause), pass { harness } explicitly, or pass { confirmShrink: true } to force the replace ' +
                        'if that is actually intended.'
                      : null
                : undefined,
          ...depsOpt,
        });
        stored = res.stored;
        priorLength = res.priorLength;
        blockedReason = res.blockedReason;
        const depsWarnings = res.depsWarnings;
        const depsStamped = res.depsStamped;
        const depsRecomputed = res.recomputed;
        if (blockedReason) {
          // WI-7190: the append guard's reason already carries its own leading error
          // code (`append_base_unreadable — …`) — don't relabel it `shrink_blocked`,
          // it isn't a shrink, it's the append's pre-read disagreeing with the
          // authoritative prior. Anything WITHOUT its own code (the plain-replace
          // guard's message, or a caller-supplied reason in a test double) keeps the
          // original `shrink_blocked — ` prefix unchanged.
          const hasOwnCode = /^[a-z][a-z0-9_]*\s+—\s/.test(blockedReason);
          const errorCode = hasOwnCode ? blockedReason.split(' — ', 1)[0] : 'shrink_blocked';
          return {
            ok: false as const,
            id: it.id,
            error: hasOwnCode ? blockedReason : `shrink_blocked — ${blockedReason}`,
            errorCode,
            // EI-20185430154274838: the guard is correct, but an error string alone
            // makes the normal successor-note recovery shape discoverable only after
            // a failed call and a second read of prose. Keep both choices explicit:
            // append preserves the detailed prior; confirmShrink is the deliberate
            // full-replacement escape hatch. `append:false` is included on replace
            // because this option also serves append_base_unreadable failures.
            recovery: {
              append: {
                args: { append: true },
                description: 'Join this submitted checkpoint onto the existing note and preserve its prior content.',
              },
              replace: {
                args: { append: false, confirmShrink: true },
                description: 'Replace the prior note only when this checkpoint contains the complete intended body.',
              },
            },
          };
        }
        // agent-activity-liveness-truth P-001 (D-001/D-004): a non-clear checkpoint write
        // is REAL item-scoped progress — credit it so the item reads as `progressing`, not
        // `stalled`. Fire-and-forget + fail-soft (each swallows errors and no-ops on the
        // wrong family / a holderless row) so a progress bump never breaks the checkpoint
        // write. WI-3006: markFeatureProgress only matches feature-family rows and
        // markIssueProgress only matches issue-family (bug/change/task) rows — item_kind is
        // mutually exclusive between them, so firing both unconditionally is a harmless
        // no-op on whichever one doesn't apply (no need to look up the item's kind first).
        if (stored !== null) {
          void markFeatureProgress(harness ?? '', it.id);
          void markIssueProgress(it.id);
        }
        // P-003 (fleet-deltas-leader-primitives-2026-07-10): TRUE read-after-write
        // through the SAME path a future reader uses (getWorkItemCheckpoint, same
        // canonicalized ref). contentHash-of-the-returned-string (EI-8987) proves the
        // store ECHOED the write, but not that a future READ resolves the row — and
        // the real silent-loss class (WI-3549 / EI-8805 / EI-8824 / EI-9013) was
        // precisely write/read KEY divergence. A verify miss fails THIS item loudly
        // at write time instead of being discovered post-compaction.
        let readBack: string | null = null;
        if (stored !== null) {
          try {
            readBack = await getWorkItemCheckpoint({ harness, workItemId: it.id, workspaceId });
          } catch {
            readBack = null;
          }
          if (readBack !== stored) {
            return {
              ok: false as const,
              id: it.id,
              error:
                `checkpoint_verify_failed — the write did not read back via the reader path ` +
                `(stored ${stored.length} chars, read back ${readBack === null ? 'null' : `${readBack.length} chars`}). ` +
                `The checkpoint would be INVISIBLE to the next pickup. Retry, or pass { harness } explicitly.`,
            };
          }
        }
        return {
          ok: true as const,
          id: it.id,
          harness,
          cleared: stored === null,
          length: stored?.length ?? 0,
          contentHash: stored !== null ? shortHash(stored) : null,
          /** P-003: verified = the stored text READ BACK byte-identically via the reader
           *  path (null on a clear — nothing to verify). */
          verified: stored !== null ? (true as const) : null,
          /** P-003: first 80 chars of what was stored — eyeball-check without a re-read. */
          storedHead: stored !== null ? stored.slice(0, 80) : null,
          /**
           * EI-19298690705878336: how many `## Checks` rows the stored note ended up
           * carrying. Read back off `stored` rather than counting the caller's input, so
           * it reflects what the store actually WROTE instead of what was passed in.
           * EI-19460631385508515: note this is NOT evidence of a union — a supplied list
           * REPLACES the set, so this can legitimately come back LOWER than the count you
           * had stored. `checksDropped` below names what went missing.
           *
           * EI-20004424625703051: it can come back lower on an APPEND too, for the other
           * reason — the union overflowed the CARRY_NOTE_MAX_CHECKS cap and the carried
           * tail was evicted. So a count below what you stored does not by itself tell
           * you which of the two happened; read `checksDroppedNote`, which now says.
           */
          checks: stored !== null ? splitCarryNoteChecks(stored).checks.length : 0,
          /**
           * EI-19460631385508515: stored check claims this write DROPPED — present only
           * when a supplied `checks` list omitted rows that were already stored, so an
           * unaffected result's shape is unchanged (same convention as `repairs`). The
           * write SUCCEEDS either way; this reports a loss, never a refusal. Claims are
           * truncated for the reply — they identify WHICH row went, they are not a
           * restore payload.
           *
           * EI-20004424625703051: there are TWO distinct causes and they need DIFFERENT
           * remedies, so the note branches. A plain write drops because a supplied list
           * REPLACES. An APPEND write unioned correctly and then overflowed the
           * CARRY_NOTE_MAX_CHECKS cap, which evicts the CARRIED tail (supplied rows are
           * ordered first in `effectiveChecks`). Emitting the replace text on an append
           * is not a cosmetic slip: it names a cause that did not occur, and its remedy
           * ("re-send the FULL set") is UNACHIEVABLE there, because the full set is by
           * definition over the cap and `checks` is `.max(CARRY_NOTE_MAX_CHECKS)` — the
           * call is rejected as invalid_input. Measured: a caller followed that text to
           * the conclusion that append-union was broken and filed it as a union bug,
           * when the union had worked and the cap was the whole mechanism.
           */
          ...(droppedCheckClaims.length
            ? {
                checksDropped: droppedCheckClaims.map((c) => (c.length > 300 ? `${c.slice(0, 300)}…` : c)),
                checksDroppedNote: wantsAppend
                  ? `CAP EVICTION, not a replace: \`append\` UNIONED your ${suppliedChecks?.length ?? 0} row(s) onto ` +
                    `the stored set, the union exceeded the ${CARRY_NOTE_MAX_CHECKS}-row cap, and ` +
                    `${droppedCheckClaims.length} CARRIED row(s) were evicted from the tail (supplied rows are kept ` +
                    `first). Re-sending the full set CANNOT fix this — that set is over the cap and would be ` +
                    `rejected as invalid_input. To keep them: RETIRE rows you no longer need in a separate plain ` +
                    `write (no \`append\`, send only the survivors), then append; or pass no \`checks\` at all to ` +
                    `leave the stored rows untouched.`
                  : `a supplied \`checks\` list REPLACES the stored set — ${droppedCheckClaims.length} stored ` +
                    `claim(s) were not in this write and are now gone. Re-send the FULL set you want carried ` +
                    `(a re-sent claim inherits its prior recheck/verified), or pass no \`checks\` at all to leave ` +
                    `the stored rows untouched.`,
              }
            : {}),
          /**
           * EI-19400299440742193: every soft-cap TRIM this write applied, so a caller
           * can see exactly what was shortened. Absent entirely when nothing was
           * trimmed (the common case), so an unaffected result's shape is unchanged.
           * The write SUCCEEDS either way — this reports a repair, never a refusal.
           */
          ...(repairs.length ? { repairs } : {}),
          by: ident.ownerId,
          // P-007/D-013: what the freshness axis recorded for this write. Absent
          // entirely when the caller declared nothing (the common case today), so
          // an undeclared checkpoint's result shape is unchanged.
          ...(depsStamped !== undefined ? { depsStamped } : {}),
          ...(depsRecomputed
            ? {
                recomputed: true as const,
                recomputedNote:
                  'the checkpoint this replaced had already gone stale (a declared dependency had moved), so ' +
                  'readers are told this note was rebuilt after its world changed rather than being continuously valid.',
              }
            : {}),
          ...(depsWarnings
            ? {
                depsWarnings,
                depsWarningNote:
                  'these declared dependencies were NOT stamped — a dependency that cannot resolve would look ' +
                  'declared but could never invalidate, so it is dropped rather than silently kept. Fix the ref ' +
                  'and re-declare.',
              }
            : {}),
          // WI-3801 lint + P-014 turn-ref verification/origin stamp — warn-only,
          // absent (no fields) on the overwhelming common clean case.
          ...(stored !== null ? await carryProvenanceFields(stored, ident.ownerId) : {}),
          // EI-9325: warn-only nudge — a plain replace-on-write that shrank the
          // checkpoint by more than half, off a substantial prior checkpoint, usually
          // means an accidental placeholder/truncated paste rather than an
          // intentional rewrite. Never blocks; undefined on every clean write
          // (the overwhelming common case) or when there's nothing suspicious to flag.
          ...(stored !== null && priorLength !== null && priorLength > 500 && stored.length < priorLength * 0.5
            ? {
                shrinkWarning:
                  `This write is ${stored.length} chars, down from ${priorLength} chars previously stored. ` +
                  `If you meant to PRESERVE the prior content (e.g. prepending a new section), verify you pasted ` +
                  `it verbatim rather than a placeholder/marker — a large shrink like this usually means accidental ` +
                  `truncation (EI-9325). If the shrink is intentional, ignore this.`,
              }
            : {}),
          // EI-19395730805289668: this note DECLARES an owner pause, but the item carries no
          // claim hold — so the pause is prose the claim path cannot read, and
          // scheduler:get_next will keep serving the item (measured 2026-08-03T02:05Z).
          //
          // Warn-only, and deliberately NOT an auto-hold: two corpus items sat open-and-
          // "paused" for weeks on SITUATIONAL directives that had long expired, so silently
          // converting prose into an enforced hold would have made those worse. The author is
          // the only one who knows which case they are in, and they know it right now.
          //
          // No extra read: `item` is already loaded above (the not_holder guard). A null item
          // (unresolvable id) or one already held stays SILENT — an unknown hold state must
          // not be reported as an absent one, or this nags the authors who did it correctly.
          ...(stored !== null && item && !isClaimHoldParked(item.payload)
            ? (() => {
                const declared = detectPauseDeclaration(stored);
                return declared ? { pauseNotEnforcedWarning: pauseNotEnforcedWarning(declared) } : {};
              })()
            : {}),
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
