/**
 * _create-core — the per-item work-item CREATION core, extracted from
 * `work_items/create.ts` WITHOUT behavior change (work-queue-completeness Phase B,
 * unified-work-item-ledger). The single `work_items:create` handler and the BULK
 * `work_items:create_batch` loop both call `createOneWorkItem` so the mirror-guard,
 * workspace resolution, and hive-scope gate are applied IDENTICALLY per item.
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
import { createWorkItem, getWorkItem, type WorkItem, type WorkItemKind } from '../../work-items';
import { findMirroredOpenItem } from './mirror-guard';
import { resolveHiveScope, HIVE_REQUIRED_DETAIL } from '../_hive-scope';

/**
 * PIPELINE work-item kinds that belong to a HIVE's fleet queue (D-020): a fresh one
 * must resolve to a hive (auto-resolve-then-require). Issue kinds (bug/change) are
 * deliberately EXCLUDED — they may stay workspace-global (the issues surface).
 */
export const HIVE_GATED_KINDS: ReadonlySet<string> = new Set(['feature', 'research-task', 'chunk']);

/** One per-item create spec — the shared shape `create.ts` + `create_batch.ts` accept. */
export interface CreateOneWorkItemArgs {
  kind: string;
  title: string;
  summary?: string;
  harness?: string;
  hive?: string;
  workspace?: string;
  severity?: 'critical' | 'major' | 'minor' | 'nit';
  parent?: string;
  topics?: string[];
  payload?: Record<string, unknown>;
  urgent?: boolean;
  force?: boolean;
  /** Atomic create+claim target (B-LOOP-4): the agent id to own the new item. */
  assign_to?: string;
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
  | { ok: true; workItem: WorkItem }
  | { ok: false; error: string; message?: string; existing?: { id: string; state: string } };

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
    // EI-728: route the write to the request's workspace. Precedence: explicit
    // `workspace` arg → the request's concrete workspace (ctx.workspaceId) →
    // undefined (keep the trigger-derived default). '*' (unscoped SU) ⇒ "no workspace".
    const workspaceId =
      (typeof args.workspace === 'string' && args.workspace.trim()) ? args.workspace.trim()
        : (ctx.workspaceId && ctx.workspaceId !== '*') ? ctx.workspaceId
          : undefined;
    // Hive-scope gate (D-019/D-020): a PIPELINE work-item belongs to a hive's fleet
    // queue, so it must resolve to a hive — auto-resolve-then-require from the explicit
    // `hive` arg, else the item's harness, else the session's harness. Issue kinds
    // (bug/change) are NOT gated — they may stay workspace-global (D-020).
    let harnessForItem = args.harness;
    if (HIVE_GATED_KINDS.has(args.kind)) {
      const hiveScope = await resolveHiveScope(args.hive, {
        workspaceId: ctx.workspaceId,
        harnessSlug: args.harness ?? ctx.harnessSlug,
      });
      if (hiveScope.kind === 'none') {
        return { ok: false, error: 'hive_required', message: HIVE_REQUIRED_DETAIL };
      }
      harnessForItem = args.harness ?? hiveScope.slug;
    }
    const workItem = await createWorkItem({
      kind: args.kind as WorkItemKind,
      title: args.title,
      summary: args.summary,
      harness: harnessForItem,
      workspaceId,
      severity: args.severity,
      parent: args.parent,
      topics: args.topics,
      payload: args.payload,
      createdBy: ctx.ownerId,
      urgent: args.urgent,
      // B-LOOP-4 (loop-routines P-007 / D-008): atomic create+claim. `assign_to`
      // stamps the owner in the same write — no create→claim race. The creator is
      // the durable delegator (`assignedBy`, issue-family only).
      assignee: args.assign_to,
      assignedBy: args.assign_to ? ctx.ownerId : undefined,
    });
    return { ok: true, workItem };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
