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
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemCheckpoint, getWorkItemCheckpoint } from '../../work-item-checkpoint';
import { getWorkItem, markFeatureProgress, markIssueProgress } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

/** First 12 hex chars of sha256(text) — short enough to eyeball, long enough that an
 *  accidental collision between two DIFFERENT checkpoint bodies is not a real concern. */
function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
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

const itemSpec = z.object({
  id: z.string().min(1).describe('the work-item id to checkpoint'),
  /** The compressed in-flight state. Blank / null / omitted ⇒ CLEAR the checkpoint. */
  checkpoint: z.string().max(32000).nullish().describe('compressed in-flight state; blank/omitted ⇒ clear'),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default / ctx / item lookup)'),
  append: z
    .boolean()
    .optional()
    .describe(
      'EI-9036: append `checkpoint` onto the EXISTING stored checkpoint (joined with a `---` separator) instead ' +
        'of replacing it. Reads the current checkpoint first via the same path a future pickup uses. Requires a ' +
        'non-blank `checkpoint` (append + clear is contradictory — rejected, not silently treated as a clear). ' +
        'Bounded to the 32000-char cap: the OLDEST content is trimmed first if the join would overflow it.',
    ),
});

export default defineTool({
  name: 'work_items:checkpoint',
  profile: 'engineer',
  description:
    "Write (or clear) one OR many work-items' checkpoints — a compressed snapshot of your in-flight state. " +
    'Single: { id, checkpoint? }. Many: items:[{ id, checkpoint?, harness? }]. ' +
    'Your prior transcript does NOT carry across a task boundary / re-spawn; the checkpoint is your continuity, ' +
    "re-injected on the next invocation of that item (yours or a successor's). Replace-on-write; `append:true` " +
    'joins instead (EI-9036). ' +
    'Returns { ok, results:[{ ok, id, harness, cleared, length, contentHash, verified, storedHead, by | error }], counts }. ' +
    'Writes are verify-read; fails loudly on an invisible write (checkpoint_verify_failed).',
  guidance: {
    when:
      'At a task boundary or on graceful eviction, before you finish/yield: persist what a successor (or your ' +
      'next fresh-context wake) needs to continue — what is done, what is left, current approach, gotchas, open ' +
      'threads. Keep it COMPRESSED (a digest, not a transcript).',
    notWhen:
      'Mid-task scratch state that the live transcript already holds — checkpoint only the durable, cross-boundary ' +
      'gist. Do not dump file contents or full tool output.',
    chaining:
      'work_items:checkpoint { id, checkpoint } before work_items:complete / on yield. Pass blank to clear a stale note. ' +
      'Also the fix for EI-6772: a claim held through a long stretch of PURELY-LOCAL tool use (Bash/Read/vitest, zero ' +
      'papercusp-su calls) can go presence-stale and be reclaimed as dead — a mid-investigation checkpoint is itself a ' +
      'papercusp-su dispatch, so it doubles as a liveness pulse (there is no separate work_items:heartbeat verb).',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `checkpoint`)'),
      /** The compressed in-flight state. Blank / null / omitted ⇒ CLEAR the checkpoint. */
      checkpoint: z.string().max(32000).nullish().describe('single shorthand: compressed in-flight state; blank/omitted ⇒ clear'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('checkpoint many work-items at once — each { id, checkpoint?, harness?, append? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
      append: z
        .boolean()
        .optional()
        .describe(
          'single shorthand default for `append` (EI-9036): join `checkpoint` onto the existing stored checkpoint ' +
            'instead of replacing it. Also the default applied to any `items[]` entry that omits its own `append`.',
        ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id, checkpoint? } for one, or items:[{ id, checkpoint? }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null; workspaceId?: string | null };
    const items = args.items?.length
      ? args.items
      : [{ id: args.id as string, checkpoint: args.checkpoint, harness: args.harness, append: args.append }];
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
        const item = await getWorkItem(it.id, hintHarness).catch(() => null);
        if (!item && !hintHarness) {
          return { ok: false as const, id: it.id, error: `could not resolve a harness for work_item '${it.id}' — pass { harness }` };
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
        if (wantsAppend && it.checkpoint) {
          const prior = await getWorkItemCheckpoint({ harness, workItemId: it.id, workspaceId }).catch(() => null);
          checkpointToStore = joinCheckpoint(prior, it.checkpoint);
        }
        // EI-8824: c.workspaceId is '*' for an unscoped superuser session (the
        // read-scoping wildcard) — passing it straight through as `?? undefined`
        // let the truthy '*' win and persisted the checkpoint under a literal
        // workspace_id='*' row that no concrete-workspace read (work_items:get's
        // getWorkItemCheckpoint, which never resolves to '*') can ever see. Same
        // bug class as EI-3409/WI-892; resolveConcreteWorkspaceId is the fix.
        const stored = await setWorkItemCheckpoint(
          { harness, workItemId: it.id, workspaceId },
          checkpointToStore,
        );
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
          by: ident.ownerId,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
