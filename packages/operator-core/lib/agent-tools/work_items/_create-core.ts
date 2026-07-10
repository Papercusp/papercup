/**
 * _create-core — the per-item work-item CREATION core, extracted from
 * `work_items/create.ts` WITHOUT behavior change (work-queue-completeness Phase B,
 * unified-work-item-ledger). `work_items:create` is now dual-arity
 * (bulk-endpoint-standardization-2026-06-21 P-002): its single-spec path and its
 * `items:[…]` bulk loop both call `createOneWorkItem` so the mirror-guard, workspace
 * resolution, and hive-scope gate are applied IDENTICALLY per item. (This core is
 * what let the old `work_items:create_batch` multiplexer fold back into create.)
 *
 * It performs (in order, exactly as create.ts did inline):
 *   1. EI-316 mirror-duplicate guard (flag-gated) — refuse a title embedding an OPEN id.
 *   2. EI-728 workspace resolution — explicit arg → ctx.workspaceId (concrete) → undefined.
 *   3. D-019/D-020 hive-scope gate — a pipeline kind must resolve to a hive.
 *   4. createWorkItem incl. the B-LOOP-4 atomic create+claim (assignee/assignedBy).
 *
 * Returns a discriminated result so the caller maps it onto its own envelope —
 * `{ ok: true, workItem }` or `{ ok: false, error, message?, existing? }`. It does
 * NOT throw; createWorkItem rejections are caught and returned as `{ ok: false }`.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { createWorkItem, getWorkItem, linkWorkItem, isWorkItemKind, type WorkItem, type WorkItemKind } from '../../work-items';
import { planItemRef, PLAN_ITEM_KIND } from '../../issue-blocks-merge';
import { findMirroredOpenItem } from './mirror-guard';
import { findSemanticDupes, type SemanticDupeCandidate } from './semantic-dupe-guard';
import { resolveHiveScope, HIVE_REQUIRED_DETAIL } from '../_hive-scope';
import { getOrgPg } from '@papercusp/db-org';
import { getGenericKindDatatype } from '../../datatype-registry-store';
import { validateDatatypePayload } from '../../datatype-payload-validation';
import { matchRoutingGateHint } from '../../routing-gate-hints';

/**
 * PIPELINE work-item kinds that belong to a HIVE's fleet queue (D-020): a fresh one
 * must resolve to a hive (auto-resolve-then-require). Issue kinds (bug/change) are
 * deliberately EXCLUDED — they may stay workspace-global (the issues surface).
 */
export const HIVE_GATED_KINDS: ReadonlySet<string> = new Set(['feature', 'chunk']);

/** One per-item create spec — the shared shape `create.ts` accepts (single + items[]). */
export interface CreateOneWorkItemArgs {
  kind: string;
  title: string;
  summary?: string;
  harness?: string;
  pot?: string;
  workspace?: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
  parent?: string;
  topics?: string[];
  payload?: Record<string, unknown>;
  urgent?: boolean;
  force?: boolean;
  /** Atomic create+claim target (B-LOOP-4): the agent id to own the new item. */
  assign_to?: string;
  /** Forward edge (plan-item-coverage): the plan item this work-item ADDRESSES.
   *  Writes a coord_links work→plan_item `relates` edge on create, so the item
   *  rolls up into that plan item's coverage and `plans:items` stops showing it as
   *  unworked. Non-fatal — an edge failure never blocks the create. */
  targetPlanItem?: { slug: string; itemId: string };
}

/** The acting agent identity the core needs (resolved by the caller from ctx). */
export interface CreateOneWorkItemCtx {
  /** The creator's owner id (resolveAgentIdentity(ctx).ownerId). */
  ownerId: string;
  /** The request's concrete workspace (ctx.workspaceId) — '*' / undefined = none. */
  workspaceId?: string | null;
  /** The acting session's harness (ctx.harnessSlug) — used to auto-resolve the hive. */
  harnessSlug?: string | null;
}

export type CreateOneWorkItemResult =
  | { ok: true; workItem: WorkItem; similarOpen?: SemanticDupeCandidate[] }
  | {
      ok: false;
      error: string;
      message?: string;
      existing?: { id: string; state: string };
      /** duplicate_semantic only: the OPEN items the new title cosine-matched. */
      similarOpen?: SemanticDupeCandidate[];
    };

/**
 * Create ONE work-item, applying the mirror-guard + workspace resolution + hive-scope
 * gate, then the createWorkItem call (incl. the atomic create+claim). Never throws.
 */
export async function createOneWorkItem(
  args: CreateOneWorkItemArgs,
  ctx: CreateOneWorkItemCtx,
): Promise<CreateOneWorkItemResult> {
  try {
    // EI-316 mirror-duplicate guard: a title embedding an existing OPEN work-item id
    // ("WI-118: …") is almost always an accidental mirror — refuse with the live id
    // (override: force:true). Flag-gated so a misfire is instantly reversible.
    if (!args.force && (await getFlag(FLAGS.WORK_ITEM_MIRROR_GUARD, 'system'))) {
      const mirror = await findMirroredOpenItem(args.title, async (id) => {
        const wi = await getWorkItem(id, args.harness);
        return wi ? { id: wi.id, state: wi.state } : null;
      });
      if (mirror) {
        return {
          ok: false,
          error: 'duplicate_mirror',
          message:
            `title references existing OPEN work-item ${mirror.id} (state: ${mirror.state}) — ` +
            `work that item directly (work_items:claim ${mirror.id} / work_items:set_state), do NOT create a mirror. ` +
            `Pass force:true only if this reference is deliberate.`,
          existing: mirror,
        };
      }
    }
    // P-008 semantic dupe prescreen (shared-embedding-sidecar-and-enrichment-2026-07-10):
    // cosine-rank the new title+summary against OPEN items' migration-548 embeddings —
    // the guard the 2026-07-10 30-dupe storm needed (differently-worded titles the
    // EI-316 lexical mirror-guard above cannot see). Hard match refuses (force:true
    // overrides, same contract as the mirror guard); soft match creates WITH an
    // advisory `similarOpen`. STRICTLY fail-open: null = "no verdict" = proceed.
    let similarOpen: SemanticDupeCandidate[] | undefined;
    if (!args.force) {
      const dupes = await findSemanticDupes({
        title: args.title,
        summary: args.summary,
        harness: args.harness ?? ctx.harnessSlug ?? undefined,
      });
      if (dupes && dupes.hard.length > 0) {
        const top = dupes.hard[0];
        return {
          ok: false,
          error: 'duplicate_semantic',
          message:
            `semantically duplicates OPEN work-item ${top.id} "${top.title}" ` +
            `(cosine similarity ${top.similarity.toFixed(3)} ≥ ${dupes.thresholds.hard}) — ` +
            `work that item instead (work_items:claim ${top.id}), or pass force:true if this is genuinely distinct.`,
          existing: { id: top.id, state: top.state },
          similarOpen: dupes.hard,
        };
      }
      if (dupes && dupes.soft.length > 0) similarOpen = dupes.soft;
    }
    // EI-728: route the write to the request's workspace. Precedence: explicit
    // `workspace` arg → the request's concrete workspace (ctx.workspaceId) →
    // undefined (keep the trigger-derived default). '*' (unscoped SU) ⇒ "no workspace".
    const workspaceId =
      (typeof args.workspace === 'string' && args.workspace.trim()) ? args.workspace.trim()
        : (ctx.workspaceId && ctx.workspaceId !== '*') ? ctx.workspaceId
          : undefined;
    // P-001 generic-kind gate (reflexive-platform-extensibility-datatypes-2026-06-24):
    // accept a BUILT-IN kind OR a workspace-registered generic-kind datatype. Built-ins
    // pass via the cheap in-memory check with NO DB query, so every existing caller is
    // byte-identical; only a NON-built-in kind hits the registry (today always rejected
    // here — now a registered generic-kind passes). Dark until a datatype is declared, so
    // there is no behavior change until meta:define-datatype registers a kind. This is the
    // platform-side registration path the oddsmith F1 gap needed (oddsmith D-017/P-021).
    if (!isWorkItemKind(args.kind)) {
      const datatype = workspaceId
        ? await getGenericKindDatatype(getOrgPg().sql, workspaceId, args.kind).catch(() => null)
        : null;
      if (!datatype) {
        return {
          ok: false,
          error: 'unknown_kind',
          message:
            `unknown work-item kind "${args.kind}" — use a built-in kind ` +
            `(feature, chunk, bug, change, task), or first declare it via ` +
            `meta:define-datatype (generic-kind tier) in this workspace, then create instances with that kind.`,
        };
      }
      // P-001 payload validation — the core reason a datatype exists: an instance must
      // satisfy the datatype's declared payload_schema (a malformed `bet` is rejected, not
      // stored as an untyped blob). No schema ⇒ no constraint; declare-time compilation
      // guarantees the schema is well-formed so this never fail-opens in practice.
      const pv = validateDatatypePayload(datatype.payloadSchema, args.payload);
      if (!pv.ok) {
        return {
          ok: false,
          error: 'invalid_payload',
          message: `payload does not match datatype "${args.kind}": ${pv.errors.join('; ')}`,
        };
      }
    }
    // Hive-scope gate (D-019/D-020): a PIPELINE work-item belongs to a hive's fleet
    // queue, so it must resolve to a hive — auto-resolve-then-require from the explicit
    // `pot` arg, else the item's harness, else the session's harness. Issue kinds
    // (bug/change) are NOT gated — they may stay workspace-global (D-020).
    let harnessForItem = args.harness;
    if (HIVE_GATED_KINDS.has(args.kind)) {
      const hiveScope = await resolveHiveScope(args.pot, {
        workspaceId: ctx.workspaceId,
        harnessSlug: args.harness ?? ctx.harnessSlug,
      });
      if (hiveScope.kind === 'none') {
        return { ok: false, error: 'hive_required', message: HIVE_REQUIRED_DETAIL };
      }
      harnessForItem = args.harness ?? hiveScope.slug;
    }
    // EI-8809 (routing-gate hint at dispatch): a cheap, non-blocking keyword match
    // against the papercusp-way trigger rows — the item's claimer sees the
    // prescribed mechanism in payload.routingHint instead of having to re-derive it
    // from a raw title mid-flow. Hint only, never a validation gate; a caller's
    // OWN payload.routingHint (if ever explicitly set) is never clobbered.
    const routingHint = matchRoutingGateHint(args.title, args.summary);
    const payloadWithHint =
      routingHint && !(args.payload && 'routingHint' in args.payload)
        ? { ...(args.payload ?? {}), routingHint }
        : args.payload;
    const workItem = await createWorkItem({
      kind: args.kind as WorkItemKind,
      title: args.title,
      summary: args.summary,
      harness: harnessForItem,
      workspaceId,
      severity: args.severity,
      parent: args.parent,
      topics: args.topics,
      payload: payloadWithHint,
      createdBy: ctx.ownerId,
      urgent: args.urgent,
      // B-LOOP-4 (loop-routines P-007 / D-008): atomic create+claim. `assign_to`
      // stamps the owner in the same write — no create→claim race. The creator is
      // the durable delegator (`assignedBy`, issue-family only).
      assignee: args.assign_to,
      assignedBy: args.assign_to ? ctx.ownerId : undefined,
    });
    // Forward edge: link the new work-item to the plan item it addresses (coverage
    // rollup). Non-fatal — the item is already created; an edge write that fails
    // must not turn a successful create into an error (the manual work_items:link
    // path stays available to retry).
    if (args.targetPlanItem?.slug && args.targetPlanItem?.itemId) {
      try {
        await linkWorkItem(
          workItem.id,
          { kind: PLAN_ITEM_KIND, ref: planItemRef(args.targetPlanItem.slug, args.targetPlanItem.itemId) },
          'relates',
          { harness: harnessForItem, by: ctx.ownerId },
        );
      } catch {
        // Non-fatal — coverage edge is best-effort.
      }
    }
    return { ok: true, workItem, ...(similarOpen ? { similarOpen } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
