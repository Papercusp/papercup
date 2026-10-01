/**
 * `system:inbox-bulk-resolve` — scheduled Inbox resolver launcher.
 *
 * This is the durable backstop for the owner-triggered bulk resolver. It reads
 * the canonical action-bearing plans:attention feed, snapshots at most 200
 * items, and starts the same supervised resolver process as the HTTP route.
 * `createRun` remains the single-flight authority; a concurrent run is a
 * normal skip, never a second launch.
 */
import { randomUUID } from 'node:crypto';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { callPlansRead } from '../../agent-tools/plans/read-dispatch';
import { readStandingBulkAutomationPolicy } from '../../attention/automation-policy';
import { bulkAutomationSnapshot } from '../../attention/bulk-dispositions';
import {
  BulkRunAlreadyActiveError,
  createRun,
  getItemIdsAwaitingOwnerReview,
  getRunningRun,
  setRunPhase,
  type BulkRunSeedItem,
} from '../../attention/bulk-run-store';
import {
  resolveBulkResolverLaunch,
  type EffectiveBulkResolverLaunch,
} from '../../agent-config-constants';
import { launchResolver } from '../../endpoint-route/routes/admin/attention-bulk-resolve';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const INBOX_BULK_RESOLVE = 'inbox-bulk-resolve';
export const INBOX_BULK_RESOLVE_CAP = 200;

interface AttentionFeedItem {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  ref?: unknown;
  ownerAgentId?: unknown;
  actions?: unknown;
}

/**
 * `exclude` holds ids that already await the owner in an open review run. They
 * are skipped BEFORE the cap, so a fire seeds the next 200 unreviewed items
 * rather than re-seeding the head of the feed (WI-10004720 follow-up).
 */
function seedItems(
  data: unknown,
  cap = INBOX_BULK_RESOLVE_CAP,
  exclude: ReadonlySet<string> = new Set(),
): BulkRunSeedItem[] {
  const groups = data && typeof data === 'object' && Array.isArray((data as { groups?: unknown }).groups)
    ? (data as { groups: unknown[] }).groups
    : [];
  const out: BulkRunSeedItem[] = [];
  const seen = new Set<string>(exclude);
  for (const group of groups) {
    const items = group && typeof group === 'object' && Array.isArray((group as { items?: unknown }).items)
      ? (group as { items: unknown[] }).items
      : [];
    for (const raw of items) {
      const item = raw as AttentionFeedItem;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id) || !Array.isArray(item.actions) || item.actions.length === 0) continue;
      seen.add(id);
      out.push({
        itemId: id,
        kind: typeof item.kind === 'string' ? item.kind : null,
        title: typeof item.title === 'string' ? item.title.slice(0, 1000) : null,
        ref: item.ref && typeof item.ref === 'object' && !Array.isArray(item.ref)
          ? (item.ref as Record<string, unknown>)
          : {},
        ownerAgentId: typeof item.ownerAgentId === 'string' ? item.ownerAgentId : null,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export interface InboxBulkResolveActionDeps {
  enabled: () => Promise<boolean>;
  readAttention: () => Promise<unknown>;
  /**
   * The run that EXCLUDES a new one: `pending`/`running` only — the same set
   * `createRun` and migration 915's single-flight index key on. A run waiting in
   * `review` is waiting on the OWNER, not working, so it must never gate the
   * scheduled backstop. It used to (via getActiveRun), and one review list left
   * open on 2026-08-24 silently no-op'd every 15-minute fire for 37 days
   * (WI-10004720).
   */
  runningRun: (workspaceId: string) => Promise<{ runId: string; phase: string } | null>;
  /**
   * Feed ids already waiting on the owner in an open `review` run. Dropping the
   * review gate (above) without this made every fire re-seed the same 200
   * items — 13 duplicate runs in 3h (WI-10004720 follow-up).
   */
  awaitingReview: (workspaceId: string) => Promise<ReadonlySet<string>>;
  launch: (input: {
    runId: string;
    itemCount: number;
    launch: EffectiveBulkResolverLaunch;
    resolverOwner: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  log: (message: string) => void;
}

async function productionLaunch(input: {
  runId: string;
  itemCount: number;
  launch: EffectiveBulkResolverLaunch;
  resolverOwner: string;
}): Promise<{ ok: boolean; error?: string }> {
  return launchResolver(input.runId, input.itemCount, null, input.launch, input.resolverOwner);
}

export function makeInboxBulkResolveAction(overrides: Partial<InboxBulkResolveActionDeps> = {}) {
  const deps: InboxBulkResolveActionDeps = {
    enabled: () => getFlag(FLAGS.INBOX_BULK_RESOLVE, 'system:inbox-bulk-resolve').catch(() => false),
    readAttention: () => callPlansRead('attention', {}, { uiProjection: false }),
    runningRun: (workspaceId) => getRunningRun(workspaceId, 'inbox-resolve'),
    awaitingReview: (workspaceId) => getItemIdsAwaitingOwnerReview(workspaceId, 'inbox-resolve'),
    launch: productionLaunch,
    log: (message) => console.log(`[${INBOX_BULK_RESOLVE}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    if (!(await deps.enabled())) return;
    // Every skip says why. A bare `return` here made "a run is executing" and
    // "the backstop is wedged" byte-identical for 37 days.
    const running = await deps.runningRun(ctx.workspaceId);
    if (running) {
      deps.log(`skip: run=${running.runId} is ${running.phase} (single-flight)`);
      return;
    }
    const held = await deps.awaitingReview(ctx.workspaceId);
    const items = seedItems(await deps.readAttention(), INBOX_BULK_RESOLVE_CAP, held);
    if (items.length === 0) {
      deps.log(
        held.size > 0
          ? `skip: no unreviewed action-bearing attention items (${held.size} already await owner review)`
          : 'skip: no action-bearing attention items',
      );
      return;
    }
    const policy = bulkAutomationSnapshot(await readStandingBulkAutomationPolicy(ctx.workspaceId));
    const resolved = resolveBulkResolverLaunch({
      automationMode: policy.mode,
      minConfidence: policy.minConfidence,
    });
    if (!resolved.ok || !resolved.effective) {
      deps.log(`launch settings refused: ${resolved.message ?? 'invalid standing resolver settings'}`);
      return;
    }
    const runId = `bulk-${randomUUID()}`;
    const resolverOwner = `su-${randomUUID()}`;
    try {
      const run = await createRun({
        items,
        workspaceId: ctx.workspaceId,
        requestedBy: 'system:inbox-bulk-resolve',
        automationPolicy: policy,
        launchSnapshot: resolved.effective,
      });
      await setRunPhase({ runId: run.runId, phase: 'pending', resolverOwner, workspaceId: ctx.workspaceId });
      const launched = await deps.launch({
        runId: run.runId,
        itemCount: items.length,
        launch: resolved.effective,
        resolverOwner,
      });
      await setRunPhase({
        runId: run.runId,
        phase: launched.ok ? 'running' : 'failed',
        resolverOwner,
        workspaceId: ctx.workspaceId,
        ...(launched.ok ? {} : { error: launched.error ?? 'scheduled resolver launch failed' }),
      });
      deps.log(`run=${run.runId} items=${items.length} phase=${launched.ok ? 'running' : 'failed'}`);
    } catch (error) {
      if (error instanceof BulkRunAlreadyActiveError) {
        deps.log(`skip: lost the single-flight race (${error.message})`);
        return;
      }
      deps.log(`scheduled start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

registerSystemAction(INBOX_BULK_RESOLVE, makeInboxBulkResolveAction());

export { seedItems as buildInboxBulkResolveSeedItems };
