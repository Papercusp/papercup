/**
 * Fire a reaction through the NORMAL dispatch (event-reaction-system D-003).
 *
 * A reaction is not special code — it is the system invoking tool U through the
 * same `dispatchProjectedTool` path every transport uses (auth-gated, quota'd,
 * audited, typed). We build a system reaction ctx that:
 *   - inherits workspace / harness / identity from the trigger (so the reaction
 *     acts in the right scope and can target the originating agent's pane);
 *   - stamps the cause-chain (`reactionCause`) so the loop guard sees it on the
 *     NEXT post-invocation and telemetry can audit why it fired;
 *   - runs as a first-party trusted principal (bypasses capability/quota/role —
 *     Events-file rules are curated, not user input — but is still AUDITED).
 *
 * Plugin/blueprint-scoped rules (D-012) tighten the bypass to the rule's
 * capability; that path is layered on top of this in P3.
 *
 * This is the P0 in-process executor. P1 adds a durable DBOS path behind the
 * same call shape (see `./durable`).
 */

import {
  lookupByMcpName,
  dispatchProjectedTool,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { activeWorkspaceId } from '../workspace-registry';
import type { ReactionCause } from './types';

export interface FireReactionResult {
  ok: boolean;
  error?: string;
  /** The reaction's runId (for audit / dedup correlation). */
  runId?: string;
}

/**
 * Build the system ctx a reaction runs under, inheriting the trigger's scope.
 *
 * `capability` (D-012): when set, the rule is a plugin/blueprint contribution and
 * the reaction is SANDBOXED to that one capability — the principal holds only it
 * and the capability gate is enforced, so the rule can fire ONLY a tool that
 * capability permits. When unset, the rule is first-party (curated Events-file
 * code) and runs with full system trust. Either way it is still AUDITED.
 */
export function buildReactionCtx(
  parent: UnifiedToolContext,
  workspaceId: string,
  cause: ReactionCause,
  capability?: string,
): Omit<UnifiedToolContext, 'tx'> {
  const scoped = typeof capability === 'string' && capability.length > 0;
  return {
    workspaceId,
    harnessSlug: parent.harnessSlug ?? '*',
    role: parent.role ?? 'operator',
    featureId: parent.featureId ?? null,
    chunkId: parent.chunkId ?? null,
    runId: globalThis.crypto.randomUUID(),
    // Marks the row in tool_invocations as system-fired; parent links the cause.
    spawnId: 'event-reaction',
    parentSpawnId: parent.spawnId ?? null,
    // Inherit the agent's coordination id so reactions can target its own pane.
    uiClientId: parent.uiClientId ?? null,
    reactionCause: cause,
    isSuperuser: false,
    // Scoped (plugin/blueprint, D-012): enforce the capability gate against a
    // principal holding ONLY that capability — the rule can fire only what it's
    // permitted to. First-party (curated): full system trust. Both are AUDITED.
    gateBypass: scoped ? { quota: true, role: true } : { capability: true, quota: true, role: true },
    profile: 'engineer',
    transport: 'in_process',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    principal: {
      slug: scoped ? `plugin:event-reaction:${capability}` : 'system:event-reaction',
      workspaceId,
      capabilities: new Set(scoped ? [capability as string] : ['*']),
    },
  };
}

/**
 * Run a reaction in-process. Resolves the tool, scopes a workspace tx, builds
 * the reaction ctx, and dispatches. Never throws — returns `{ ok:false, error }`
 * so the caller (the engine) can log without breaking anything.
 */
export async function fireReactionInProcess(opts: {
  fire: string;
  args: Record<string, unknown>;
  parentCtx: UnifiedToolContext;
  cause: ReactionCause;
  /** Capability scope for a plugin/blueprint rule (D-012). Unset ⇒ first-party trusted. */
  capability?: string;
}): Promise<FireReactionResult> {
  const projected = lookupByMcpName(opts.fire);
  if (!projected) return { ok: false, error: `unknown reaction tool "${opts.fire}"` };

  const workspaceId =
    opts.parentCtx.workspaceId ?? opts.parentCtx.principal?.workspaceId ?? activeWorkspaceId();
  if (!workspaceId) return { ok: false, error: 'no workspace to scope the reaction' };

  try {
    const result = await withWorkspace(workspaceId, async (tx) => {
      const ctx: UnifiedToolContext = {
        ...buildReactionCtx(opts.parentCtx, workspaceId, opts.cause, opts.capability),
        tx,
      };
      return dispatchProjectedTool(projected, opts.fire, opts.args, ctx, PROJECTED_DEPS);
    });
    if (!result.ok) {
      return { ok: false, error: result.error ? `${result.error.code}: ${result.error.message}` : 'reaction failed' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
