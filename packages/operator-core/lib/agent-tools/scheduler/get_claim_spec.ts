/**
 * scheduler:get_claim_spec — the READ verb for the claim-spec store (EI-7678).
 *
 * Claim specs were write-only from the tool surface: verifying a bee's or fleet's CURRENT
 * spec/revision meant grepping source for the zod grammar or hand-rolling a raw
 * `bee_claim_specs` query. A leader who just called scheduler:set_claim_spec had no
 * tool-surface way to confirm the re-steer actually landed before relying on it. Trivial read
 * projection over claim-spec-store's getClaimSpecRecord (bee spec → fleet spec → DEFAULT).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveClaimSpecWorkspace, getClaimSpecRecord, fleetSpecBeeKey } from '../../scheduler/claim-spec-store';
import {
  readClaimSpecRevisions,
  claimSpecHistoryElsewhereHint,
  CLAIM_SPEC_HISTORY_MAX,
} from '../../scheduler/claim-spec-revisions';
import { fleetSentinelCallerView } from './fleet-sentinel-caller-view';

export default defineTool({
  name: 'scheduler:get_claim_spec',
  profile: 'engineer',
  description:
    'Read the CURRENT claim spec for a cup or fleet: { source, spec, revision, updatedBy, updatedAt, harnessSlug, fleetSlug? }. `source` tells you which row actually answered — "bee" (a per-bee spec, always wins), "fleet" (inherited via membership, no per-bee override), or "default" (neither exists — DEFAULT_CLAIM_SPEC/oldest-first applies). The read counterpart to scheduler:set_claim_spec — confirm a re-steer landed before relying on it, instead of grepping source or guessing. Pass `history: N` to also get up to N PRIOR versions a destructive write superseded; use `history: 0` for an explicitly bounded current-only read.',
  guidance: {
    when:
      'You just called scheduler:set_claim_spec and want to confirm the write landed (right revision, right filter/rank) — or you want to know WHAT spec a bee/fleet is currently running under before re-steering it. This is a selector-only read: pass exactly one of cupId | fleet, plus optional workspace; do not forward generic harness or planSlug context from coord:orient or fleet wake discovery because those keys are rejected.',
    notWhen:
      'Setting/replacing a spec — scheduler:set_claim_spec. What is executing right now under which spec (the live-execution view across many bees) — scheduler:running. Full fleet roster / orphaned-claim detection — fleet:assignments.',
    chaining: 'scheduler:get_claim_spec (confirm current) → scheduler:set_claim_spec (re-steer) → scheduler:get_claim_spec (confirm the bump landed).',
    seeAlso: [
      // EI-20185841251188914: the scope-arg matrix across the spec-addressing trio, stated
      // on each member so a caller reading any ONE of them learns the distinction. Derived
      // truth, pinned by scope-args-contract.test.ts — edit that test WITH any arg change.
      // Lives in seeAlso (and not in when/notWhen/chaining) because seeAlso is outside the
      // per-tool prompt-weight budget: this tool sits at ~1408 of 1500 chars, and the same
      // sentence in `when` reds the fleet gate.
      'scheduler:set_claim_spec (write/re-steer a spec — MIRROR SCOPE ARGS: it takes harness and NO workspace, this read takes workspace and NO harness, so do not copy a scope key across the get→set→get chain)',
      'scheduler:preview_spec_delta (dry-run a revision — the scope superset: cupId|fleet plus BOTH harness and workspace)',
      'scheduler:running (live-execution view across many bees)',
      'fleet:assignments (full fleet roster)',
    ],
    // A caller reaching this tool almost always arrives from `coord:orient` or a fleet
    // wake, both of which hand them a `harness` in context — and the natural move is to
    // forward it. `when` already says not to, in the same sentence that names the
    // accepted selectors, and the filings kept coming: catalog prose is not on the
    // FAILURE path, which is the only moment the caller is holding the rejected key.
    //
    // The trap this must not repeat is specific: the WRITE half of the same chain,
    // scheduler:set_claim_spec, DOES take `harness` and takes no `workspace`. So the
    // rejection cannot simply be read as "harness scoping does not exist here" — a
    // caller who concludes that will drop it from the set call too and re-steer the
    // wrong partition. The note therefore names the asymmetry, not just the remedy.
    //
    // Object (corrective-call) form because there is no local key a harness VALUE could
    // be relocated onto: `fleet` takes a fleet slug, not a harness slug, so a
    // `fleet — explanation` string would render "pass it as `fleet` instead" over a
    // value that would then be rejected a second time.
    argRedirects: {
      harness: {
        tool: 'scheduler:get_claim_spec',
        args: { fleet: '<fleet-slug>' },
        note:
          'this READ is selector-only — exactly ONE of `cupId` (one cup, with fleet inheritance) or `fleet` (a fleet\'s own sentinel spec); a harness is not a selector here. ⚠ Do NOT conclude harness scoping is absent from the family: the WRITE verb scheduler:set_claim_spec DOES take `harness` and takes NO `workspace`, exactly inverted from this read — so drop `harness` here, and keep it there. To override the partition on this read, use `workspace`',
      },
      planSlug: {
        tool: 'scheduler:get_claim_spec',
        args: { fleet: '<fleet-slug>' },
        note:
          'a claim spec is addressed by WHO runs it (a cup or a fleet), never by the plan it happens to be working — one fleet\'s spec can admit several plans, so a plan slug cannot identify a spec row. Pass `fleet` (or `cupId`). For "who is on plan P" use fleet:assignments { plan }',
      },
    },
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  // EI-20228676874653267: this read uses the claim-spec store's own DB access
  // and never reads ctx.tx. Keeping the dispatcher's ambient transaction open
  // while resolving the spec pins an org-app pool slot and lets concurrent
  // fleet-control reads queue behind the 45s acquisition deadline.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      cupId: z.string().min(1).optional().describe('the cup to read (its session/owner id) — exactly one of cupId | fleet'),
      fleet: z.string().min(1).optional().describe('a fleet slug — reads the fleet-level sentinel spec directly (not a member\'s inherited view)'),
      workspace: z.string().max(120).optional().describe('override the workspace partition (default: resolved from your identity)'),
      history: z
        .number()
        .int()
        .min(0)
        .max(CLAIM_SPEC_HISTORY_MAX)
        .optional()
        .describe(
          `also return up to N (max ${CLAIM_SPEC_HISTORY_MAX}) PRIOR versions of this lane, newest first — the spec bytes a destructive write superseded, enough to rebuild it; 0 returns the current spec without prior versions`,
        ),
    })
    .refine((a) => Boolean(a.cupId) !== Boolean(a.fleet), {
      message: 'pass exactly ONE of cupId (read one cup, with fleet inheritance) or fleet (read a fleet\'s own sentinel spec)',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const workspaceId = resolveClaimSpecWorkspace(args.workspace ?? ident.workspaceId);
    const fleetSlug = args.fleet ? args.fleet.trim() : null;
    const targetCupId = fleetSlug ? fleetSpecBeeKey(fleetSlug) : (args.cupId as string);
    const record = await getClaimSpecRecord({ cupId: targetCupId, workspaceId });

    // EI-20304090779240149: a fleet read answers about the FLEET, and its envelope is
    // shaped exactly like the caller-scoped cupId read — so "source: fleet, rev 7" was
    // being taken as "I am running under rev 7" by callers who were in no fleet at all,
    // which then took out-of-lane work on the next self-pull. Resolve the CALLER too and
    // say plainly whether this sentinel is their effective spec. Best-effort: the caller
    // view never fails the read (an unreadable comparison reports UNKNOWN, never
    // agreement). Only for the fleet selector — a cupId read is already unambiguous
    // about whose spec it returned.
    const callerView = fleetSlug
      ? fleetSentinelCallerView({
          fleetSlug,
          callerId: ident.ownerId,
          callerRecord: await getClaimSpecRecord({ cupId: ident.ownerId, workspaceId }).catch(
            () => null,
          ),
        })
      : null;
    const subject = fleetSlug
      ? { subject: { kind: 'fleet-sentinel' as const, fleetSlug }, ...callerView }
      : {};

    if (args.history === undefined || args.history === 0) {
      return { data: { ok: true, ...record, ...subject } };
    }
    // History is read for the target the CALLER ADDRESSED, not for whichever row answered
    // the current-spec read. Those differ in exactly the case this history exists for: a
    // CLEARED lane has no row of its own, so its current spec resolves to the fleet's or to
    // DEFAULT while the bytes worth recovering are its own. Reading the answering row
    // instead would return an empty window for the one situation the table was built for.
    const history = await readClaimSpecRevisions({
      cupId: targetCupId,
      workspaceId,
      limit: args.history,
    });
    const elsewhere = claimSpecHistoryElsewhereHint({
      returned: history.returned,
      source: record.source,
      fleetSlug: record.fleetSlug,
      addressedFleet: Boolean(args.fleet),
      limit: args.history,
    });
    return {
      data: {
        ok: true,
        ...record,
        ...subject,
        history: { ...history, ...(elsewhere ? { historyElsewhere: elsewhere } : {}) },
      },
    };
  },
});
