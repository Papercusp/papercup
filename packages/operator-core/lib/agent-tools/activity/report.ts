/**
 * activity:report — ingest one worker-activity event (a native tool call /
 * lifecycle transition / todo snapshot) into harness_shared.agent_activity.
 *
 * The sink of the cross-CLI activity bridge (papercusp-worker-integration-2026-06-04,
 * D-003). The per-CLI hooks call this on every native tool call:
 *   - Claude + Codex: the shared `posttooluse-activity-report.sh` PostToolUse hook.
 *   - OMP: the in-process `coord-hook.ts` tool_call port.
 * The migration-143 trigger fires NOTIFY agent_activity, which the pui fleet view
 * rides over /api/activity/stream — so this write is the whole "tell the fleet view
 * what each worker is doing" path. The curator + the event-reaction system read the
 * same table.
 *
 * Design: cheap + non-blocking. The hooks call it fire-and-forget (detached / void),
 * so the handler does ONE bounded INSERT and returns. The display `summary` is
 * derived server-side (summariseActivity) when the hook didn't pre-format one, so
 * there is a single formatter shared across every CLI. detail is payload-capped.
 *
 * `owner_id` is the worker's coordination identity (PAPERCUSP_SID, the same id baked
 * into its MCP `?client=`) — passed explicitly because the hook is the source of
 * truth for it. Falls back to the request's client/principal when omitted.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { recordActivity, type TodoItem, type ToolInput } from '@papercusp/activity-bridge';
import { createPgTelemetryStore } from '../../activity-pg-store';
import {
  armInboxWake,
  cancelInboxWake,
  ensureInboxWakeArmedForActiveSession,
} from '../../events/await/inbox-wake-arm';
import { writeWatermark } from '../coordination/watermarks';
import { isWorkspaceContended } from '../locks/contention-retry';

/** Map a lifecycle-report summary to a session phase. The shared cc/ lifecycle
 *  hook sends '▶ session started' (SessionStart) and '■ session ended'
 *  (SessionEnd/Stop); key off the stable word, default to a no-op. */
function lifecyclePhase(summary?: string | null): 'start' | 'end' | null {
  if (!summary) return null;
  if (/start/i.test(summary)) return 'start';
  if (/end/i.test(summary)) return 'end';
  return null;
}

/** A todo item shape the CLIs emit (TodoWrite / TaskCreate / todo_write). */
const todoSchema = z
  .object({
    content: z.string().optional(),
    status: z.string().optional(),
    activeForm: z.string().optional(),
  })
  .passthrough();

export default defineTool({
  name: 'activity:report',
  description:
    "Report one worker-activity event (a native tool call, lifecycle transition, or todo snapshot) to the cross-CLI activity bridge sink (harness_shared.agent_activity). Called by the per-CLI hooks on every tool call; feeds the pui fleet view + curator. The display summary is derived server-side from tool_name+tool_input when not supplied. Fire-and-forget: returns { ok, id } and never blocks.",
  capability: 'activity:report',
  guidance: {
    when: 'Almost never call this by hand — the per-CLI hooks (posttooluse-activity-report.sh / the OMP coord-hook port) call it automatically to mirror each worker\'s native tool stream into the fleet view. Call directly only to inject a synthetic activity marker (e.g. a custom lifecycle note).',
    notWhen: 'To READ the activity stream use `activity:recent` (or the /api/activity/stream SSE). To coordinate with peers use `coord:send`. To drive a pui use `tui:dispatch`.',
    seeAlso: [
      'activity:recent (READ the activity stream)',
      'coord:send (coordinate with peers)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** The reporting worker's coordination identity (PAPERCUSP_SID). */
    owner: z.string().min(1).max(256).optional(),
    /** Which CLI produced it: 'claude' | 'codex' | 'omp'. Best-effort. */
    agent: z.string().max(32).optional(),
    /** The CLI's native session id (for resume correlation). */
    session_id: z.string().max(256).optional(),
    /** The harness the worker is in (its cwd's repo), when known. */
    harness_slug: z.string().max(256).optional(),
    /** Override the derived kind; otherwise inferred (todos > tool > lifecycle). */
    kind: z.enum(['tool', 'lifecycle', 'todos']).optional(),
    /** The native tool name (Edit / Bash / apply_patch / …). */
    tool_name: z.string().max(128).optional(),
    /** 'pre' (PreToolUse/tool_call) | 'post' (PostToolUse/tool_result). */
    phase: z.enum(['pre', 'post']).optional(),
    /** The CLI's per-call id, correlating a pre/post pair. */
    tool_use_id: z.string().max(256).optional(),
    /** Raw (hook-capped) native tool input — summarised server-side. */
    tool_input: z.record(z.string(), z.unknown()).optional(),
    /** A TodoWrite/TaskCreate/TaskUpdate snapshot — summarised server-side. */
    todos: z.array(todoSchema).max(100).optional(),
    /** A pre-formatted one-liner; overrides the server-derived summary. */
    summary: z.string().max(512).optional(),
    /** 'ok' | 'error' when the report carries an outcome. */
    status: z.string().max(32).optional(),
    /** The worker's cwd at report time. */
    cwd: z.string().max(1024).optional(),
  }),
  async handler(args, ctx) {
    // owner_id is the load-bearing grouping key — prefer the explicit arg (the hook
    // knows it), else the request's client identity, else the principal slug.
    const owner =
      (args.owner && args.owner.trim()) ||
      (ctx as { clientId?: string }).clientId ||
      ctx.principal?.slug ||
      (ctx.isSuperuser ? 'system:operator' : `agent:${ctx.role ?? 'unknown'}`);
    if (!owner) {
      return { isError: true, content: [{ type: 'text', text: 'owner_required: pass the worker owner id (PAPERCUSP_SID).' }] };
    }

    // Normalize the raw cross-CLI report + append it through the PG-backed
    // TelemetryStore seam (@papercusp/activity-bridge). The host-domain `scope`
    // maps to the harness the worker is in; everything else is the worker's
    // coordination identity. The migration-143 NOTIFY trigger does the fleet-view push.
    //
    // FIRE-AND-FORGET (the tool's documented contract: "never blocks"): a TRANSIENT
    // PG contention on this telemetry INSERT — a `lock_timeout` (55P03) or
    // `statement_timeout` (57014), which the harness_admin org pool caps at 15s — must
    // NOT surface as a hard tool error. The per-CLI hooks call this detached on EVERY
    // native tool call (~45k/day); a single dropped fleet-view row self-heals on the
    // worker's next report, so a rare contention dip is a benign no-op, never a fleet-
    // wide "tool activity:report is failing" watchdog signal (EI-7439). This mirrors the
    // best-effort/swallowed treatment of every other write in this handler (the inbox-wake
    // arm + watermark below). Non-contention errors (a genuine bug / DB-down) still surface.
    let result: Awaited<ReturnType<typeof recordActivity>>;
    try {
      result = await recordActivity(createPgTelemetryStore(), {
        owner,
        agent: args.agent ?? null,
        sessionId: args.session_id ?? null,
        scope: args.harness_slug ?? null,
        kind: args.kind,
        toolName: args.tool_name ?? null,
        phase: args.phase,
        toolUseId: args.tool_use_id ?? null,
        toolInput: args.tool_input as ToolInput,
        todos: args.todos as TodoItem[] | undefined,
        summary: args.summary ?? null,
        status: args.status ?? null,
        cwd: args.cwd ?? null,
        workspaceId: ctx.principal?.workspaceId ?? '*',
      });
    } catch (e) {
      if (!isWorkspaceContended(e)) throw e; // a real fault must still surface
      // Dropped-under-contention: report a soft, honest result (id null + dropped
      // marker) rather than a handler error. The side-effect arms below are throttled
      // + best-effort and will re-run on the next report, so skipping them here is safe.
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, id: null, dropped: 'contention' }) }],
      };
    }

    // turn-lifecycle-control P-003/P-004: a session's lifecycle transition is the
    // universal, client-agnostic moment to (un)arm its inbox-wake watch — so EVERY
    // psu/Queen-launched agent is wakeable WITHOUT having to call coord:await-inbox
    // (D-001). Idempotent upsert / cancel; never let it break the report.
    const phase = args.kind === 'lifecycle' ? lifecyclePhase(args.summary) : null;
    if (phase) {
      try {
        if (phase === 'start') {
          // presence-v2 P-010 (D-007): a fresh context / resume means the agent's
          // cached roster baseline is gone while its durable coord cursor kept
          // advancing — mark a re-bootstrap so the next coord:inbox re-injects the
          // presence snapshot ONCE. Independent best-effort (its own catch) so an
          // inbox-wake hiccup never skips it, and vice-versa.
          await writeWatermark(owner, { snapshot_rebootstrap_pending: true }).catch(() => {});
          await armInboxWake({ ownerId: owner, workspaceId: ctx.principal?.workspaceId });
        } else {
          await cancelInboxWake(owner, ctx.principal?.workspaceId); // D-003: cancel on clean end
        }
      } catch (e) {
        console.warn(
          `[activity:report] inbox-wake ${phase} for ${owner} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    } else if (args.kind !== 'lifecycle') {
      // SELF-HEAL (launch-wakeability): a genuine non-lifecycle report is a native
      // tool call from a running session. If that session's SessionStart arm was lost
      // (the detached, fail-open lifecycle hook POST can drop at launch — leaving a
      // live agent un-wakeable for its whole life), re-arm so it becomes a dispatch
      // target from its first tool call onward. Throttled + best-effort + scoped to a
      // live tracked adv_sessions row (see ensureInboxWakeArmedForActiveSession). Gated
      // on kind!=='lifecycle' so an UNRECOGNIZED lifecycle summary stays a no-op and a
      // clean SessionEnd (cancel, above) is never resurrected.
      await ensureInboxWakeArmedForActiveSession({
        ownerId: owner,
        workspaceId: ctx.principal?.workspaceId ?? undefined,
      }).catch(() => {});
    }

    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }) }] };
  },
});
