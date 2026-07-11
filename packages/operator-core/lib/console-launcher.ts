/**
 * console-launcher.ts — build the envelope the Tauri Rust side needs to
 * open an OS-native terminal in the right cwd, with the right env, and
 * with a `.mcp.json` already configured for superuser MCP access.
 *
 * The "+" button in ChromeShell calls `/api/agent-mcp/console/resolve`
 * which calls this. The Tauri command then writes the .mcp.json and
 * spawns the user's terminal.
 *
 * MCP integration: the .mcp.json points at the existing superuser
 * door at `/api/mcp?superuser=1` with the bearer from
 * `~/.papercusp/superuser-token`. That endpoint bypasses role + quota
 * gates per the existing superuser-mode design — see
 * /docs/endpoint-system/superuser-mode. We don't invent a new role.
 *
 * Server-only.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { resolveBackend } from '@papercusp/papercusp-shared/agent';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import { papercuspPathForWorkspace } from './papercusp-root';
import { resolveAgentMcpBaseUrl } from './mcp-base-url';
import { advSessionsByTranscriptHandles } from './adv-sessions';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import {
  resolveContextEnv,
  resolveProjectDir,
  resolveStateDir,
} from './spawn-config';
// (Removed: getSessionUserOrDefault / createPowerUserSession /
// mintAccessToken / mintRefreshToken — used by the old papercusp-omp
// bundle path. /adv routes OMP launches through the omp-su wrapper
// instead, which authenticates via the operator's loopback superuser
// MCP and needs no workspace-scoped tokens.)

/**
 * `shell` — the engineer path: a superuser console with a `.mcp.json`.
 * `omp`   — the engineer OMP path: launch `omp` directly with the
 *           Papercusp engineer playbook + coordination extension,
 *           scoped to the local superuser MCP surface.
 */
export interface ConsoleEnvelope {
  /** Working directory the terminal opens in. */
  cwd: string;
  /**
   * Non-secret env vars. The launcher inline-`export`s these into the
   * oneliner — so they must NOT contain secrets (the oneliner is the
   * spawned shell's argv and is visible in `ps`).
   */
  env: Record<string, string>;
  /** Pretty-printed .mcp.json contents the engineer's claude/codex agent
   *  auto-discovers when they cd into `cwd`. */
  mcpJsonContents: string;
  /** Greeting command the launcher runs before exec'ing the user's shell. */
  greetingCmd: string;
  /** True iff ~/.papercusp/superuser-token is missing. Tauri side
   *  should run install-standalone-mcp.sh before launching. */
  needsSuperuserBootstrap: boolean;
  /**
   * windows-desktop-feature-parity-2026-07-02 P-010: a fresh UUID minted per
   * console launch — the WINDOW's own identity, distinct from
   * `resumeSessionId` (an agent CLI session to resume) and adv_sessions'
   * `session_id` (the agent's native session id). Every spawner titles the OS
   * window `Papercup — <sessionId>` (native_console.rs / console-spawn.ts) so
   * a launched terminal can be found + focused by TITLE. This matters most on
   * Windows: the agent/session runs inside the `papercup-runtime` WSL2
   * distro while the terminal window is a native Win32 process, so there is
   * no Windows window-ancestor for a WSL pid and pid→window mapping (the
   * Linux wmctrl path) is structurally impossible — title is the only durable
   * link. See packages/operator-core/lib/windows-desktop-windows.ts.
   */
  sessionId: string;
}

export interface BuildEnvelopeOpts {
  /** Active workspace id (e.g. 'default'). */
  workspaceId: string;
  /** Active harness slug, if any. Null = workspace-only launch. */
  slug: string | null;
  /** The operator's own base URL (e.g. http://localhost:3070). */
  operatorBaseUrl: string;
  /**
   * scoped-superuser-workspace-clamp D-004 — deliberate cross-workspace ("god
   * mode") console. Default false ⇒ the MCP url bakes the concrete `&workspace=`
   * (scoped-by-default; the flag-gated dispatch clamp then confines the session).
   * true ⇒ bake `&workspace=*` (UNSCOPED) — the explicit opt-in that spans
   * workspaces past the clamp. The caller (Tauri launch UI / psu CLI) sets this.
   */
  allWorkspaces?: boolean;
  /**
   * plan-agent-launch P-023: when set, the shell console resumes an existing
   * session (`<agent-cli> -r <sessionId>`) instead of opening fresh.
   */
  resumeSessionId?: string;
  /**
   * WI-3882 (adv-sessions-live-roster P-012): FORK the resumed session into a
   * fresh branch instead of resuming it in place. Only meaningful together with
   * `resumeSessionId`. For a still-LIVE source session a plain resume would open
   * a SECOND CLI against the same session transcript and collide with the
   * still-running original; forking branches into a new session id (claude
   * `--fork-session`), leaving the original's id + transcript untouched — the
   * exact flag psu-launcher's resumeArgsFor emits for a claude fork. Honored
   * only for claude sessions reachable via this direct-CLI `-r` path (codex is
   * not routed here; omp has no branch command → refused rather than silently
   * plain-resuming into a collision).
   */
  fork?: boolean;
  /**
   * psu-in-desktop-builds-2026-06-23 B: when set, the console runs `psu` (a
   * superuser agent session) on open instead of just dropping to a shell. Only
   * honored when FLAGS.PSU_END_USER is on (defense-in-depth — the discoverable
   * UI entry is also flag-gated). psu is on PATH via the ~/.papercusp/bin shim.
   */
  runPsu?: boolean;
  /**
   * capability:terminal — run this EXACT command in the opened terminal. It
   * becomes the greetingCmd, executed in a subshell before the terminal drops
   * to an interactive login shell — so the command runs and the window stays
   * open. Mutually exclusive with runPsu / resumeSessionId (runCommand wins).
   * Arbitrary by design: same trust model as capability:bash.
   */
  runCommand?: string;
  /**
   * Skip the superuser `.mcp.json` setup entirely. capability:terminal opens a
   * terminal to RUN a command, not to host an MCP-connected agent console, so
   * it must not displace the project's real .mcp.json. Sets mcpJsonContents to
   * '' (the spawner then skips writing it) and needsSuperuserBootstrap to false.
   */
  skipMcpJson?: boolean;
}

// (kickoff-kind allowlist moved to @/lib/agent-kickoff/kickoff-kind in P-032,
//  when the omp launch flavour was retired from this module.)
const TOKEN_PATH = join(homedir(), '.papercusp', 'superuser-token');

/**
 * Where the bundled `papercup` shim + `papercup-status.mjs` live so the
 * Tauri launcher can prepend it to PATH. We try a few candidates so
 * dev (`npm run dev` from apps/operator) and prod-standalone (sidecar
 * bundle layout) both resolve correctly. Returns null when neither
 * exists — the launcher just runs without the greeting on PATH.
 */
function resolveScriptsDir(): string | null {
  const cwd = process.cwd();
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
  const candidates = [
    // Release-gate cutover (2026-06-05): the operator may run from the
    // RELEASE checkout, but a spawned console is an integration-tree
    // context — prefer the integration tree's scripts when declared.
    ...(integrationRoot
      ? [resolvePath(integrationRoot, 'apps', 'operator', 'scripts')]
      : []),
    // dev: started from apps/operator/, scripts is a sibling of lib/
    resolvePath(cwd, 'scripts'),
    // dev from monorepo root: papercup/
    resolvePath(cwd, 'apps', 'operator', 'scripts'),
    // standalone build: server runs from sidecar/apps/operator/
    resolvePath(cwd, '..', '..', 'scripts'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'papercup-status.mjs'))) return c;
  }
  return null;
}

/**
 * Build the superuser MCP url the engineer console's agent connects to.
 * scoped-superuser-workspace-clamp D-004: scoped-by-default bakes the concrete
 * `&workspace=`; `allWorkspaces` opts into `&workspace=*` (UNSCOPED — the only
 * door past the flag-gated dispatch clamp). Exported for unit tests.
 */
export function buildSuperuserMcpUrl(
  operatorBaseUrl: string,
  workspaceId: string,
  allWorkspaces = false,
): string {
  // WI-573: route the console's superuser MCP through the resilient proxy when the env opts in
  // (PAPERCUSP_MCP_PROXY_BASE) so it survives a :3070 deploy restart; else the operator base.
  const url = new URL(`${resolveAgentMcpBaseUrl(operatorBaseUrl)}/api/mcp`);
  url.searchParams.set('superuser', '1');
  url.searchParams.set('workspace', allWorkspaces ? '*' : workspaceId);
  return url.toString();
}

/** Read the superuser bearer token. Returns null if not yet installed. */
function readSuperuserToken(): string | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const t = readFileSync(TOKEN_PATH, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export async function buildConsoleEnvelope(
  opts: BuildEnvelopeOpts,
): Promise<ConsoleEnvelope> {
  // 1. Resolve cwd: harness's project dir if slug given, else workspace root.
  let cwd: string;
  let stateDir: string | null = null;
  if (opts.slug) {
    const projectDir = await resolveProjectDir(opts.slug, opts.workspaceId);
    if (!projectDir) throw new Error(`unknown harness slug: ${opts.slug}`);
    cwd = projectDir;
    stateDir = await resolveStateDir(opts.slug, opts.workspaceId);
  } else {
    // Workspace-only launch: open at the SELECTED workspace's root, not the
    // global active one (opts.workspaceId may differ from activeWorkspaceId()).
    cwd = papercuspPathForWorkspace(opts.workspaceId);
  }

  // 2. Build env — same shape as the Pi pty (PI_CODING_AGENT_DIR if
  //    we have a state dir, PAPERCUSP_HARNESS_SLUG if we have a slug,
  //    PAPERCUSP_API_BASE for callbacks), plus workspace + home so a
  //    user typing `papercup status` doesn't need to guess.
  const env: Record<string, string> = {
    ...resolveContextEnv({
      slug: opts.slug ?? '',
      stateDir,
      requestUrl: opts.operatorBaseUrl,
    }),
    PAPERCUSP_WORKSPACE: opts.workspaceId,
    // WI-1773 follow-up: route through the resilient-proxy resolver, same as
    // buildSuperuserMcpUrl below. Previously this baked the RAW operatorBaseUrl
    // (e.g. direct :3070) into the child's env unconditionally — psu-launcher's
    // resolveOperatorUrl() treats an explicit PAPERCUSP_OPERATOR_URL as the
    // highest-precedence override, so every console/fleet/capability:terminal
    // -spawned session inherited a permanent :3070 pin and silently bypassed the
    // proxy-first default that bare `psu` CLI launches already get (WI-1457).
    // Confirmed live 2026-07-03: a backlog-clearance fleet member's env carried
    // PAPERCUSP_OPERATOR_URL=http://localhost:3070 despite papercup-mcp-proxy
    // being active+healthy on :9071 at launch time.
    PAPERCUSP_OPERATOR_URL: resolveAgentMcpBaseUrl(opts.operatorBaseUrl),
    // Scope HOME to the SELECTED workspace — using the global papercuspPath()
    // here was the latent bug that let a spawned agent carry
    // PAPERCUSP_WORKSPACE=<picked> alongside PAPERCUSP_HOME=<active>.
    PAPERCUSP_HOME: papercuspPathForWorkspace(opts.workspaceId),
  };
  // If no slug, resolveContextEnv set PAPERCUSP_HARNESS_SLUG=''; drop
  // that — empty value is worse than absent for "is this harness-scoped?".
  if (!opts.slug) delete env.PAPERCUSP_HARNESS_SLUG;

  // 2b. Pass the operator's scripts dir so the launcher one-liner can
  //     run `papercup status` without the user having anything on PATH
  //     yet. The Tauri spawner prepends this to PATH when invoking the
  //     terminal one-liner. Skipped when not resolvable (the terminal
  //     just opens without the greeting CLI in PATH).
  const scriptsDir = resolveScriptsDir();
  if (scriptsDir) env.PAPERCUSP_SCRIPTS_DIR = scriptsDir;
  // The psu/ptool shims (installPapercuspFiles) live in ~/.papercusp/bin. Pass
  // it so the spawner can prepend it to PATH — that's what makes `psu` runnable
  // from the in-app terminal (psu-in-desktop-builds-2026-06-23 A2b).
  env.PAPERCUSP_BIN_DIR = join(homedir(), '.papercusp', 'bin');


  // 3. Build the .mcp.json that the user's claude/codex agent will
  //    auto-discover when they cd here. Points at the superuser door.
  //    If the token is missing the Tauri side will install it before
  //    using this. We still emit the file shape so callers can write
  //    it after bootstrap.
  // capability:terminal passes skipMcpJson — it opens a terminal to RUN a
  // command, not to host an MCP-connected agent console, so it must not
  // displace the project's real .mcp.json. Empty contents ⇒ the spawner skips
  // writing it.
  let mcpJsonContents = '';
  let needsSuperuserBootstrap = false;
  if (!opts.skipMcpJson) {
    const token = readSuperuserToken();
    needsSuperuserBootstrap = token === null;
    // Workspace-scoped by default — superuser ctx.workspaceId defaults to
    // '*' which most first-party tools reject. Baking &workspace=<slug>
    // gives the user's agent useful defaults; tool-by-tool override via
    // args still works.
    const mcpUrl = buildSuperuserMcpUrl(opts.operatorBaseUrl, opts.workspaceId, opts.allWorkspaces);
    mcpJsonContents = JSON.stringify(
      {
        mcpServers: {
          papercusp: {
            url: mcpUrl,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          },
        },
      },
      null,
      2,
    );
  }

  // plan-agent-launch P-023: a resume launch reuses the same shell
  // shape (cwd, env, .mcp.json, superuser bootstrap), but lands the
  // user in the live agent CLI via `-r <sessionId>` instead of a
  // plain shell. Default greeting stays unchanged for normal launches.
  let greetingCmd = 'papercup status 2>/dev/null || true';
  if (opts.runCommand) {
    // capability:terminal — run the caller's command verbatim, arbitrary by
    // design (same trust model as capability:bash). buildConsoleOneliner
    // single-quote-escapes + subshell-wraps it, so quotes/pipes/multiline
    // survive into `bash -lc '…'`. Wins over runPsu/resume when set.
    greetingCmd = opts.runCommand;
  } else if (opts.runPsu && !opts.resumeSessionId && (await getFlag(FLAGS.PSU_END_USER, 'system'))) {
    greetingCmd = 'psu';
  } else if (opts.resumeSessionId) {
    const id = shellSafeId(opts.resumeSessionId);
    // Resolve THIS session's backend from its OWN adv_sessions row — NOT the
    // operator's AGENT_CMD/AGENT_BACKEND env. Those env vars describe how the
    // operator spawns HEADLESS agents and are irrelevant to which CLI a given
    // recorded session belongs to. TWO owner-hit bugs (2026-07-11, resume+fork
    // "still failed") both traced to the old env-based resolution:
    //   1. resolveAgentBin() returned AGENT_CMD VERBATIM — here "claude -p
    //      [--model haiku]". The "-p" is PRINT / non-interactive mode, so the
    //      greeting `claude -p … -r <id>` printed once and EXITED — the resumed
    //      terminal died on the spot (and on the wrong model). An INTERACTIVE
    //      resume must exec the BARE binary with no -p / automation flags.
    //   2. a codex/omp session would have resumed under whatever CLI the env
    //      named rather than its own.
    const agentToBackend = (
      agent: string | null | undefined,
    ): ReturnType<typeof resolveBackend> | null => {
      switch ((agent ?? '').toLowerCase()) {
        case 'claude':
        case 'claude-code':
          return 'claude-code';
        case 'omp':
        case 'pi':
          return 'omp';
        case 'codex':
          return 'codex';
        default:
          return null;
      }
    };
    // Fetch the row up-front — it drives BOTH the backend choice and the
    // CLAUDE_CONFIG_DIR/cwd resolution below.
    let row: Awaited<ReturnType<typeof advSessionsByTranscriptHandles>>[number] | undefined;
    try {
      const rows = await advSessionsByTranscriptHandles({ sessionIds: [opts.resumeSessionId] });
      row = rows[0];
    } catch { /* best-effort — fall back to env-derived backend below */ }
    // The session's OWN agent wins; env is only a fallback when the row is gone.
    const backend = agentToBackend(row?.agent) ?? resolveBackend({ promptText: '' });
    // BARE interactive binary for the backend — deliberately NOT resolveAgentBin
    // (that returns the operator's "-p"/automation-model AGENT_CMD).
    const bin = backend === 'omp' ? 'omp' : backend === 'codex' ? 'codex' : 'claude';
    // WI-3882: forking a LIVE session must NOT resume it in place — that opens a
    // second CLI on the SAME transcript and collides with the still-running
    // original. Only claude has `--fork-session`; omp/codex refuse a fork rather
    // than silently degrade to a colliding plain resume.
    if (opts.fork && backend !== 'claude-code') {
      throw new Error(
        `cannot fork a ${bin} session: only claude sessions support --fork-session on the console resume path`,
      );
    }
    // WI-3988/WI-3989: `claude -r <id>` only finds the conversation with the SAME
    // CLAUDE_CONFIG_DIR + cwd the original agent used. papercusp runs each claude
    // agent in a per-session ISOLATION home (~/.papercusp/session-claude/<owner>,
    // keyed by coord owner id), and the move-inactive-to-PG lifecycle archives +
    // deletes an ended session's on-disk jsonl. So point claude at the session's
    // isolation home + original cwd, rematerializing an archived transcript from
    // PG first. Best-effort — on any miss we fall through to a bare -r.
    if (backend === 'claude-code' && row) {
      // Point claude at the session's isolation config dir so `-r` reads the
      // right conversation store (not the default ~/.claude).
      if (row.coordOwnerId) env.CLAUDE_CONFIG_DIR = sessionClaudeConfigDir(row.coordOwnerId);
      // Land in the session's ORIGINAL project dir — claude scopes resume by cwd.
      // Only override when it still exists (an ended session's cwd may be gone).
      if (row.cwd && existsSync(row.cwd)) cwd = row.cwd;
      // An ENDED session's jsonl was archived + deleted after death — rematerialize
      // it from PG (session_archives) first. Lazy import: session-archive fails
      // LOUD at import when zstd is unavailable, so keep that off this module's
      // load path. A LIVE session isn't archived → rematerialize is a no-op miss.
      try {
        const { pgSessionArchiveStore, rematerializeSession } = await import('./session-archive');
        await rematerializeSession(
          { sourceKind: 'claude', sessionId: opts.resumeSessionId },
          pgSessionArchiveStore(),
        );
      } catch { /* best-effort — nothing to restore / archive unavailable */ }
    }
    // Permission mode is per-INVOCATION, not inherited from the resumed session:
    // a bare `claude -r` lands in default ask-per-tool mode (owner-hit on the
    // Windows app, 2026-07-07). Re-assert the frictionless posture psu-launcher
    // uses.
    const bypass =
      backend === 'claude-code'
        ? '--dangerously-skip-permissions --permission-mode bypassPermissions '
        : backend === 'omp'
          ? '--approval-mode yolo '
          : '';
    // `--fork-session` goes AFTER `-r <id>` to match psu-launcher's proven claude
    // fork argv order (`--resume <id> … --fork-session`); claude branches the
    // resumed conversation into a fresh auto-minted id (no forced --session-id
    // needed — this console path doesn't track forks in the psu picker).
    const forkSuffix = opts.fork ? ' --fork-session' : '';
    const verb = opts.fork ? 'forking' : 'resuming';
    greetingCmd = `echo "${verb} plan-run ${id}…"; exec ${bin} ${bypass}-r ${id}${forkSuffix}`;
  }

  return {
    cwd,
    env,
    mcpJsonContents,
    greetingCmd,
    needsSuperuserBootstrap,
    sessionId: randomUUID(),
  };
}

/**
 * Validate a session id is safe to embed in a shell greeting. We
 * mint these as `crypto.randomUUID()` so the alphabet is
 * `[0-9a-f-]`. Reject anything else rather than try to escape — a
 * malformed id is a bug to fix, not data to sanitise. Exported for
 * unit testing.
 */
export function shellSafeId(id: string): string {
  if (!/^[0-9a-f-]+$/i.test(id)) {
    throw new Error(`refusing to embed unsafe session id: ${id.slice(0, 32)}`);
  }
  return id;
}
