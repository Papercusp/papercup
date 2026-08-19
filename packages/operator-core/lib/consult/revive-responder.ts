/**
 * revive-responder.ts — the WI-39852 revival leg's SPAWN half (plan
 * consult-revival-and-honest-min-2026-08-18 P-001; owner 2026-08-18:
 * respawn-and-consult beats retrieval-only).
 *
 * getFeedbackCore decides WHEN to revive (a dead above-floor expert beats a
 * live below-floor minimum-fill / an unfilled minimum, cap
 * MAX_REVIVALS_PER_CONSULT); this module owns HOW: carry-respawn the dead
 * expert's own session as a HEADLESS resume — the resumed CLI re-attaches its
 * ORIGINAL coord identity, and the consult brief rides the spawn-safe
 * `PAPERCUSP_KICKOFF_PROMPT` env as the session's first turn (a revived
 * session missed the conversation ping, so the brief is its only guaranteed
 * delivery).
 *
 * CONTRACT (GetFeedbackDeps.revive): MUST resolve, never throw — spawned:false
 * on any failure, and the core falls back to the pre-revival selection
 * outcome. `verified` is three-state like the launch verifier (D-004):
 * true = a live pty host registered for the identity within the wait window;
 * null = still booting (NOT a failure — the cascade expiry guards the reply);
 * spawned:false makes it meaningless.
 *
 * Reuses the launch-agent building blocks verbatim (resolveResumeTarget /
 * buildAgentLaunchCommand / buildConsoleEnvelope / spawnHeadless /
 * verifyResumeStarted) so revival cannot drift from the one audited
 * resume path — including the WI-3882 refuse-if-live rule.
 */
import { join } from 'node:path';
import {
  buildAgentLaunchCommand,
  injectLaunchedByArg,
  resolveResumeTarget,
  verifyResumeStarted,
} from '../agent-launch-core';
import { buildConsoleEnvelope } from '../console-launcher';
import { spawnHeadless } from '../console-spawn';
import { resolveSpawnHostOperatorBaseUrl } from '../mcp-base-url';
import { papercuspPathForWorkspace } from '../papercusp-root';

/** How long the reviver waits for the resumed identity's pty host to register
 * before reporting verified:null (booting). Deliberately shorter than the
 * launch-agent resume verify (30s): the consult flow is on the requester's
 * critical path, and null is an honest "still booting", not a failure. */
export const REVIVE_VERIFY_TIMEOUT_MS = 15_000;

export interface ConsultReviveContext {
  workspaceId: string;
  /** Harness slug for the console envelope (project scope of the resume);
   * null ⇒ the workspace home checkout (buildConsoleEnvelope's own fallback).
   * The resume itself lands in the session's recorded cwd when known. */
  harnessSlug: string | null;
  /** The consult requester's coord id — stamped as `--launched-by` provenance
   * on the resumed command (who revived / supervises the session). */
  launchedBy: string | null;
}

export interface ConsultReviveResult {
  spawned: boolean;
  verified: boolean | null;
  detail: string;
}

/** Injectable seams — unit tests pass fakes; production omits (real impls). */
export interface ConsultReviveDeps {
  resolveResumeTarget: typeof resolveResumeTarget;
  buildAgentLaunchCommand: typeof buildAgentLaunchCommand;
  injectLaunchedByArg: typeof injectLaunchedByArg;
  buildConsoleEnvelope: typeof buildConsoleEnvelope;
  spawnHeadless: typeof spawnHeadless;
  verifyResumeStarted: typeof verifyResumeStarted;
}

/**
 * Carry-respawn `ownerId`'s most recent session headlessly with `brief` as its
 * first turn. Resolves ALWAYS (never throws) — see the module doc for the
 * three-state `verified` contract.
 */
export async function reviveConsultResponder(
  opts: { ownerId: string; conversationId: string; brief: string },
  ctx: ConsultReviveContext,
  deps: Partial<ConsultReviveDeps> = {},
): Promise<ConsultReviveResult> {
  const d: ConsultReviveDeps = {
    resolveResumeTarget,
    buildAgentLaunchCommand,
    injectLaunchedByArg,
    buildConsoleEnvelope,
    spawnHeadless,
    verifyResumeStarted,
    ...deps,
  };
  try {
    const target = await d.resolveResumeTarget({ agentId: opts.ownerId });
    if (!target.ok) {
      return { spawned: false, verified: null, detail: `resume target unresolvable: ${target.detail}` };
    }
    if (target.live) {
      // WI-3882: an in-place resume of a LIVE identity opens a second CLI
      // against one transcript. The consult layer only revives dead-READ
      // candidates, so reaching this means liveness changed under us (or the
      // wake-failed "zombie" still holds its pty host) — refuse; the cascade
      // expiry advances past an unresponsive selectee on its own.
      return {
        spawned: false,
        verified: null,
        detail:
          `${target.ownerId ?? opts.ownerId} reads LIVE at the pty host — an in-place resume would collide ` +
          `with the running session (WI-3882), so revival was refused. If they are a false-parked zombie, ` +
          `the cascade expiry advances past them.`,
      };
    }

    let cmd = d.buildAgentLaunchCommand({ mode: 'resume', sessionId: target.sessionId, headless: true });
    cmd = d.injectLaunchedByArg(cmd, ctx.launchedBy).command;

    const base = await d.buildConsoleEnvelope({
      workspaceId: ctx.workspaceId,
      slug: ctx.harnessSlug,
      operatorBaseUrl: resolveSpawnHostOperatorBaseUrl(),
      // The revived session is an MCP-connected agent, not a bare command.
      skipMcpJson: false,
    });
    // The brief rides the ENV, never a --kickoff= value: free-form text inside
    // the console greeting one-liner breaks the shell (launch-agent P-001).
    const env = { ...base.env, PAPERCUSP_KICKOFF_PROMPT: opts.brief };
    const spawn = await d.spawnHeadless({
      envelope: { ...base, env, greetingCmd: cmd, cwd: target.cwd ?? base.cwd },
      label: `consult-revival · ${opts.ownerId.slice(0, 16)}`,
      logDir: join(papercuspPathForWorkspace(ctx.workspaceId), 'fleet-logs'),
      launchedBy: ctx.launchedBy ?? undefined,
      fleetSlug: null,
    });
    if (spawn.status !== 'ok') {
      return {
        spawned: false,
        verified: null,
        detail: `headless resume spawn failed (code ${spawn.code}): ${spawn.error}`,
      };
    }

    // The resumed session re-attaches its ORIGINAL identity, so the verify
    // polls target.ownerId. No recorded identity ⇒ nothing to poll — spawned
    // stands, verification honestly unknown (null).
    if (!target.ownerId) {
      return {
        spawned: true,
        verified: null,
        detail:
          `headless resume of session ${target.sessionId} spawned (log ${spawn.logPath ?? '?'}); ` +
          `no recorded coord identity to verify against — the cascade expiry guards the reply.`,
      };
    }
    const verify = await d.verifyResumeStarted(target.ownerId, { timeoutMs: REVIVE_VERIFY_TIMEOUT_MS });
    return {
      spawned: true,
      verified: verify.started ? true : null,
      detail: verify.started
        ? `revived ${target.ownerId}: live host registered after ${verify.waitedMs}ms (log ${spawn.logPath ?? '?'}).`
        : `revived ${target.ownerId}: spawned, no live host after ${verify.waitedMs}ms — still booting ` +
          `(NOT a failure; the cascade expiry guards the reply). Log ${spawn.logPath ?? '?'}.`,
    };
  } catch (e) {
    return {
      spawned: false,
      verified: null,
      detail: `revival threw: ${(e as Error)?.message ?? String(e)}`,
    };
  }
}

/** Bind the `GetFeedbackDeps.revive` seam for a given requester context. */
export function makeConsultReviver(
  ctx: ConsultReviveContext,
  deps: Partial<ConsultReviveDeps> = {},
): (opts: { ownerId: string; conversationId: string; brief: string }) => Promise<ConsultReviveResult> {
  return (opts) => reviveConsultResponder(opts, ctx, deps);
}
