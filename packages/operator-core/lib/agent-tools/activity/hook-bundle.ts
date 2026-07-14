/**
 * Delta-aware coordination payload folded into activity:report for native hooks.
 *
 * A busy OMP session used to pay three automatic MCP round trips around its
 * manual calls: activity:report, coord:inbox, and coord:glance.  The activity
 * report is the unavoidable heartbeat, so it now carries a caller generation
 * and conditionally hydrates the other two surfaces server-side.  A quiet run
 * still performs one cheap MAX(id) generation read per heartbeat, but performs
 * O(1) inbox/glance hydrations until coordination state actually changes.
 *
 * The host epoch is part of the generation.  An operator restart therefore
 * cannot accidentally accept a pre-restart client cursor even when the latest
 * coord_event_log id is unchanged.
 */

import { getOrgPg } from '@papercusp/db-org';
import inboxTool from '../coordination/tools/inbox';
import glanceTool from '../coordination/tools/glance';
import { coordScopeWorkspace } from '../coordination/log';

export const ACTIVITY_HOOK_BUNDLE_SCHEMA = 'activity-hook-bundle-v1';
const HOST_EPOCH = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

export interface ActivityHookBundleRequest {
  generation?: string | null;
  since_ts?: string | null;
  force_resync?: boolean;
}

export interface ActivityHookBundleSurface {
  inbox?: Record<string, unknown>;
  glance?: Record<string, unknown>;
}

export interface ActivityHookBundle {
  schemaVersion: typeof ACTIVITY_HOOK_BUNDLE_SCHEMA;
  generation: string;
  changed: boolean;
  complete: boolean;
  surfaces?: ActivityHookBundleSurface;
  provenance: {
    source: 'activity:report';
    ownerId: string;
    observedAt: string;
  };
  resync: {
    on: string[];
    strategy: 'replace-full-never-merge-behind';
    request: { generation: null; force_resync: true };
  };
}

type ToolContext = Parameters<typeof inboxTool.handler>[1];

export interface ActivityHookBundleDeps {
  generation: () => Promise<string>;
  inbox: (sinceTs: string | null | undefined, ctx: ToolContext) => Promise<Record<string, unknown> | null>;
  glance: (ctx: ToolContext) => Promise<Record<string, unknown> | null>;
  now: () => Date;
}

function parseToolPayload(result: unknown): Record<string, unknown> | null {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null;
  if (!r || r.isError) return null;
  const text = r.content?.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function currentGeneration(): Promise<string> {
  const rows = await getOrgPg().sql<Array<{ max_id: string }>>`
    SELECT COALESCE(MAX(id), 0)::text AS max_id
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${coordScopeWorkspace()}
  `;
  return `${HOST_EPOCH}:${rows[0]?.max_id ?? '0'}`;
}

const defaultDeps: ActivityHookBundleDeps = {
  generation: currentGeneration,
  // A missing baseline must never turn a post-tool fold into a full-history
  // inbox dump. turn_start establishes the cursor; until then the inbox
  // surface is an explicit empty snapshot while display can still hydrate.
  inbox: async (sinceTs, ctx) => {
    if (!sinceTs) return { entries: [], injection: '', summary: { newest_ts: null } };
    return parseToolPayload(
      await inboxTool.handler(
        { since_ts: sinceTs } as Parameters<typeof inboxTool.handler>[0],
        ctx,
      ),
    );
  },
  glance: async (ctx) =>
    parseToolPayload(
      await glanceTool.handler(
        { audience: 'user', activity_limit: 0, display_only: true } as Parameters<typeof glanceTool.handler>[0],
        ctx as Parameters<typeof glanceTool.handler>[1],
      ),
    ),
  now: () => new Date(),
};

/**
 * Return a stamped bundle.  Matching generations intentionally return no
 * surfaces: the client keeps its last full snapshot.  On mismatch both
 * surfaces are replaced together.  A partial hydrate is marked incomplete and
 * the client must retain its old generation so the next heartbeat retries.
 */
export async function buildActivityHookBundle(
  ownerId: string,
  request: ActivityHookBundleRequest,
  ctx: ToolContext,
  deps: ActivityHookBundleDeps = defaultDeps,
): Promise<ActivityHookBundle> {
  const generation = await deps.generation();
  const changed = request.force_resync === true || request.generation !== generation;
  const base: Omit<ActivityHookBundle, 'complete' | 'surfaces'> = {
    schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
    generation,
    changed,
    provenance: {
      source: 'activity:report' as const,
      ownerId,
      observedAt: deps.now().toISOString(),
    },
    resync: {
      on: ['schema-version-mismatch', 'generation-mismatch', 'surface-missing', 'operator-restart'],
      strategy: 'replace-full-never-merge-behind' as const,
      request: { generation: null, force_resync: true as const },
    },
  };
  if (!changed) return { ...base, complete: true };

  const [inbox, glance] = await Promise.all([
    deps.inbox(request.since_ts, ctx).catch(() => null),
    deps.glance(ctx).catch(() => null),
  ]);
  const complete = inbox !== null && glance !== null;
  return {
    ...base,
    complete,
    surfaces: {
      ...(inbox ? { inbox } : {}),
      ...(glance ? { glance } : {}),
    },
  };
}
