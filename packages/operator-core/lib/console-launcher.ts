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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { resolveAgentBin, resolveBackend } from '@papercusp/papercusp-shared/agent';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import { papercuspPathForWorkspace } from './papercusp-root';
import { resolveAgentMcpBaseUrl } from './mcp-base-url';
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
   * psu-in-desktop-builds-2026-06-23 B: when set, the console runs `psu` (a
   * superuser agent session) on open instead of just dropping to a shell. Only
   * honored when FLAGS.PSU_END_USER is on (defense-in-depth — the discoverable
   * UI entry is also flag-gated). psu is on PATH via the ~/.papercusp/bin shim.
   */
  runPsu?: boolean;
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
    PAPERCUSP_OPERATOR_URL: opts.operatorBaseUrl,
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
  const token = readSuperuserToken();
  const needsSuperuserBootstrap = token === null;
  // Workspace-scoped by default — superuser ctx.workspaceId defaults to
  // '*' which most first-party tools reject. Baking &workspace=<slug>
  // gives the user's agent useful defaults; tool-by-tool override via
  // args still works.
  const mcpUrl = buildSuperuserMcpUrl(opts.operatorBaseUrl, opts.workspaceId, opts.allWorkspaces);
  const mcpJsonContents = JSON.stringify(
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

  // plan-agent-launch P-023: a resume launch reuses the same shell
  // shape (cwd, env, .mcp.json, superuser bootstrap), but lands the
  // user in the live agent CLI via `-r <sessionId>` instead of a
  // plain shell. Default greeting stays unchanged for normal launches.
  let greetingCmd = 'papercup status 2>/dev/null || true';
  // psu-in-desktop-builds B: a "superuser session" launch runs psu directly.
  // Gated server-side on PSU_END_USER (the UI entry is also flag-gated). psu
  // runs in the greeting subshell; when its agent session exits the user drops
  // to the normal shell (still superuser-scoped). Mutually exclusive with resume.
  if (opts.runPsu && !opts.resumeSessionId && (await getFlag(FLAGS.PSU_END_USER, 'system'))) {
    greetingCmd = 'psu';
  } else if (opts.resumeSessionId) {
    // resolveBackend/resolveAgentBin take a RunAgentChatOptions with
    // `promptText` required; we only consume the env-driven branches,
    // so a stub options object is fine — cast to satisfy the type.
    const stubOpts = { promptText: '' };
    const backend = resolveBackend(stubOpts);
    const bin = resolveAgentBin(stubOpts, backend);
    // Both `claude` and `omp` accept `-r <session-id>`. The shell
    // greeting echoes the run id so a stale terminal is identifiable.
    const id = shellSafeId(opts.resumeSessionId);
    greetingCmd = `echo "resuming plan-run ${id}…"; exec ${bin} -r ${id}`;
  }

  return {
    cwd,
    env,
    mcpJsonContents,
    greetingCmd,
    needsSuperuserBootstrap,
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
