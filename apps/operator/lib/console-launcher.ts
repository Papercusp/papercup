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

import { resolveAgentBin, resolveBackend } from '@restart/papercup-shared/agent';

import { papercuspPath } from '@/lib/papercusp-root';
import {
  resolveContextEnv,
  resolveProjectDir,
  resolveStateDir,
} from '@/lib/spawn-config';
// (Removed: getSessionUserOrDefault / createPowerUserSession /
// mintAccessToken / mintRefreshToken — used by the old papercusp-omp
// bundle path. /adv routes OMP launches through the omp-su wrapper
// instead, which authenticates via the operator's loopback superuser
// MCP and needs no workspace-scoped tokens.)

/**
 * `shell` — the engineer path: a superuser console with a `.mcp.json`.
 * `omp`   — the power-user path: launch `papercusp-omp connect`, which
 *           seeds a workspace-scoped OMP agent. See
 *           docs/plans/omp-power-user-bundle-2026-05-20.md §4.4.
 */
export type ConsoleMode = 'shell' | 'omp';

export interface ConsoleEnvelope {
  /** Working directory the terminal opens in. */
  cwd: string;
  /**
   * Non-secret env vars. The launcher inline-`export`s these into the
   * oneliner — so they must NOT contain secrets (the oneliner is the
   * spawned shell's argv and is visible in `ps`).
   */
  env: Record<string, string>;
  /** Pretty-printed .mcp.json contents. Empty in `omp` mode (the OMP
   *  plugin writes its own .mcp.json). */
  mcpJsonContents: string;
  /** Greeting command the launcher runs before exec'ing the user's shell. */
  greetingCmd: string;
  /** True iff ~/.papercusp/superuser-token is missing. Tauri side
   *  should run install-standalone-mcp.sh before launching. */
  needsSuperuserBootstrap: boolean;
  /** Which launch flavour this envelope describes. */
  mode: ConsoleMode;
  /**
   * `omp` mode only — secret env (the power-user access + refresh
   * tokens). Passed to the terminal via the spawn `env` option ONLY,
   * never inline-`export`ed into the oneliner: argv leaks to `ps`,
   * shell history, and kernel audit (D-006). Env is visible only via
   * `/proc/<pid>/environ` to the same user — the accepted middle.
   */
  secretEnv?: Record<string, string>;
  /**
   * `omp` mode only — the command the terminal `exec`s in place of the
   * user's `$SHELL` (e.g. `papercusp-omp connect`).
   */
  launchCommand?: string;
}

export interface BuildEnvelopeOpts {
  /** Active workspace id (e.g. 'default'). */
  workspaceId: string;
  /** Active harness slug, if any. Null = workspace-only launch. */
  slug: string | null;
  /** The operator's own base URL (e.g. http://localhost:3070). */
  operatorBaseUrl: string;
  /** Launch flavour. Default `'shell'` (preserves the engineer path). */
  mode?: ConsoleMode;
  /**
   * plan-agent-launch P-023: when set, the terminal resumes an existing
   * session instead of opening fresh — `<agent-cli> -r <sessionId>` in
   * shell mode, `omp-su -r <sessionId>` in OMP mode.
   */
  resumeSessionId?: string;
  /** Optional OMP model fuzzy-match argument for `omp-su --model`. */
  ompModel?: string;
}

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
  const candidates = [
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
    const projectDir = await resolveProjectDir(opts.slug);
    if (!projectDir) throw new Error(`unknown harness slug: ${opts.slug}`);
    cwd = projectDir;
    stateDir = await resolveStateDir(opts.slug);
  } else {
    cwd = papercuspPath();
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
    PAPERCUSP_HOME: papercuspPath(),
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

  // 2c. omp mode — mint a power-user session + tokens and return an
  //     envelope that launches `papercusp-omp connect`. The tokens go
  //     in secretEnv (spawn-env only, never the oneliner). No .mcp.json
  //     here: the OMP plugin writes its own, scoped to the workspace.
  if ((opts.mode ?? 'shell') === 'omp') {
    // Route OMP launches through the `omp-su` wrapper installed by
    // apps/operator/scripts/install-standalone-mcp.sh — it adds the
    // engineer-collaborator playbook + the papercusp coord extension
    // and registers the superuser MCP server in ~/.omp/agent/. Any
    // extra args (e.g. `-r <id>` for resume) pass straight through
    // to the underlying `omp`. We deliberately bypass the
    // `papercusp-omp connect` bundle/token machinery for /adv
    // launches — that path is for workspace-user OMP sessions; /adv
    // is the engineer-collaborator surface.
    const launchParts = ['omp-su'];
    if (opts.ompModel) launchParts.push('--model', shellSafeOmpModel(opts.ompModel));
    if (opts.resumeSessionId) launchParts.push('-r', shellSafeId(opts.resumeSessionId));
    const launchCommand = launchParts.join(' ');
    return {
      cwd,
      env,
      mcpJsonContents: '',
      greetingCmd: '',
      needsSuperuserBootstrap: false,
      mode: 'omp',
      launchCommand,
    };
  }

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
  const mcpUrl = new URL(`${opts.operatorBaseUrl}/api/mcp`);
  mcpUrl.searchParams.set('superuser', '1');
  mcpUrl.searchParams.set('workspace', opts.workspaceId);
  const mcpJsonContents = JSON.stringify(
    {
      mcpServers: {
        papercusp: {
          url: mcpUrl.toString(),
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
  if (opts.resumeSessionId) {
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
    mode: 'shell',
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

/**
 * Validate an OMP model fuzzy-match value before embedding it in an
 * `omp-su --model <value>` shell command. OMP model names/patterns use
 * provider slashes plus URL-ish model ids; spaces and shell metachars
 * are not valid model selectors and should never reach the shell.
 */
export function shellSafeOmpModel(model: string): string {
  const trimmed = model.trim();
  if (!/^[A-Za-z0-9._:/+-]+$/.test(trimmed)) {
    throw new Error(`refusing to embed unsafe OMP model: ${trimmed.slice(0, 32)}`);
  }
  return trimmed;
}
