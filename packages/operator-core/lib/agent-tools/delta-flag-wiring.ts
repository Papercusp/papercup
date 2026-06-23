/**
 * Wire tooldef's semantic-delta gate to FLAGS.TOOL_DELTA_PROTOCOL
 * (agent-tool-delta-protocol-2026-06-22, the flag-bite — D-007/D-008).
 *
 * `@papercusp/tooldef` `defineTool` upgrades a `changed` view-response to a
 * `mode:'delta'` body only when this resolver returns true. The default
 * resolver is `() => true` (the library can't see host flags); the HOST owns
 * the policy. tooldef is host-agnostic and agent-mcp doesn't depend on
 * `@papercusp/flags`, so the flag-reading resolver is registered here, on the
 * operator side, and imported as a side-effect at startup (see
 * `agent-tools/index.ts`) — same shape as `pre-prompt-registry-config`.
 *
 * The flag is DEFAULT ON (owner-directed flip 2026-06-22) but INERT until a
 * delta-aware CLIENT exists (WI-514 — nothing sends `_meta.delta` yet), so the
 * server capability is live ahead of the client. OFF reverts every tool to the
 * unconditionally-safe Lane-B behaviour (full | not_modified) — a real,
 * runtime-flippable kill-switch (`/admin/features`), not a no-op.
 *
 * The gate read is fail-OPEN to the flag DEFAULT: `getFlag` already returns
 * `FLAG_DEFAULTS[key]` when there's no PostHog client / stored override (the
 * embedded/dev path), and we swallow any unexpected throw back to that default
 * too, so a flag-subsystem hiccup never silently disables a shipped-ON feature.
 * Keyed on `ctx.workspaceId` (the natural delta scope) so the flag can be
 * targeted per-workspace; falls back to a stable id when absent.
 */

import { setSemanticDeltaEnabledResolver } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

const TOOL_DELTA_DEFAULT = true; // mirrors FLAG_DEFAULTS[TOOL_DELTA_PROTOCOL]

setSemanticDeltaEnabledResolver(async (ctx: unknown): Promise<boolean> => {
  const distinctId =
    (ctx as { workspaceId?: string } | null | undefined)?.workspaceId ?? 'global';
  try {
    return await getFlag(FLAGS.TOOL_DELTA_PROTOCOL, distinctId);
  } catch {
    // Fail open to the flag default — never let a flag-read fault disable a
    // shipped-ON capability (and never throw out of the delta-negotiation path).
    return TOOL_DELTA_DEFAULT;
  }
});
