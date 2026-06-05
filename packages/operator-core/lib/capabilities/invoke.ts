/**
 * Palette server-capability invocation (P-004, write side).
 *
 * Runs a tooldef tool on behalf of the desktop palette user, through the
 * SAME gated/audited path the MCP transport uses (`dispatchProjectedToolToMcp`
 * + `PROJECTED_DEPS`) — the full dispatch stack (role-allowlist → capability →
 * authorize → quota → audit) applies. Deliberately:
 *   - NO `gateBypass` and NO `isSuperuser` — unlike the MCP superuser path,
 *     the palette does not bypass any gate. It runs as a plain `operator`-role
 *     loopback principal; trust-/role-/capability-gated tools reject normally.
 *   - A SERVER-SIDE §3 re-check (never trust the client): excluded tools are
 *     refused; destructive/high-risk tools require an explicit `confirmed`.
 *
 * The route in front of this (`run-tool.ts`) enforces loopback-only origin.
 */
import {
  lookupByMcpName,
  getCatalog,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { activeWorkspaceId } from '../workspace-registry';
import { toolDefinitionToCapability, type ToolDefinitionMeta } from './from-tooldef';
import { paletteEligibility } from './safety-filter';
import type { Capability } from './types';

export type InvokeGuard =
  | { allow: true; cap: Capability }
  | { allow: false; status: number; code: string; message: string };

/**
 * The pure §3 admission decision for a palette invoke. Factored out so it's
 * unit-testable without the live catalog/dispatch.
 */
export function paletteInvokeGuard(cap: Capability, confirmed: boolean): InvokeGuard {
  const eligibility = paletteEligibility(cap);
  if (eligibility === 'exclude') {
    return {
      allow: false,
      status: 403,
      code: 'not_palette_eligible',
      message: `"${cap.id}" cannot be run from the palette (streaming, interactive, or requires arguments)`,
    };
  }
  if (eligibility === 'confirm' && !confirmed) {
    return {
      allow: false,
      status: 409,
      code: 'confirmation_required',
      message: `"${cap.id}" is destructive or high-risk; re-invoke with confirmed:true`,
    };
  }
  return { allow: true, cap };
}

export type InvokeResult =
  | { ok: false; status: number; code: string; message: string }
  | { ok: true; status: number; body: unknown };

export async function invokeServerCapability(opts: {
  name: string;
  args?: unknown;
  confirmed?: boolean;
}): Promise<InvokeResult> {
  const def = getCatalog().find((t) => t.name === opts.name) as ToolDefinitionMeta | undefined;
  if (!def) {
    return { ok: false, status: 404, code: 'unknown_tool', message: `no tool named "${opts.name}"` };
  }

  const guard = paletteInvokeGuard(toolDefinitionToCapability(def), opts.confirmed === true);
  if (!guard.allow) {
    return { ok: false, status: guard.status, code: guard.code, message: guard.message };
  }

  const projected = lookupByMcpName(opts.name);
  if (!projected) {
    return { ok: false, status: 404, code: 'unknown_tool', message: `no projected tool "${opts.name}"` };
  }

  const workspaceId = activeWorkspaceId();
  const body = await withWorkspace(workspaceId, async (tx) => {
    // The desktop loopback caller IS the operator (same trust the MCP
    // operator-tier path grants on loopback). The dispatch capability gate is
    // a literal `has(cap)` and does NOT honor the loopback principal's `'*'`,
    // so bypass it — but KEEP the role gate enforced (`role: 'operator'`), which
    // aligns invoke exactly with the role-filtered /capabilities listing. Quota
    // is bypassed too: palette actions are human-initiated, not agent budget
    // (D-004). `authorize` (resource PDP) and the §3 guard above still apply,
    // and every call is audited via PROJECTED_DEPS. Security posture: loopback
    // origin + §3 + confirm-for-destructive + audit (see D-007).
    const ctx: UnifiedToolContext = {
      workspaceId,
      harnessSlug: '*',
      role: 'operator',
      featureId: null,
      chunkId: null,
      runId: globalThis.crypto.randomUUID(),
      spawnId: 'palette',
      parentSpawnId: null,
      uiClientId: null,
      isSuperuser: false,
      gateBypass: { capability: true, quota: true },
      profile: 'engineer',
      transport: 'http',
      log: () => {},
      progress: () => {},
      emit: () => {},
      signal: new AbortController().signal,
      tx,
      principal: { slug: 'loopback', workspaceId, capabilities: new Set(['*']) },
    };
    return dispatchProjectedToolToMcp(projected, opts.name, opts.args ?? {}, ctx, PROJECTED_DEPS);
  });

  return { ok: true, status: 200, body };
}
