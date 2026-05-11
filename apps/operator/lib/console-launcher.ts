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

import { papercuspPath } from '@/lib/papercusp-root';
import {
  resolveContextEnv,
  resolveProjectDir,
  resolveStateDir,
} from '@/lib/spawn-config';

export interface ConsoleEnvelope {
  /** Working directory the terminal opens in. */
  cwd: string;
  /** Env vars to inject into the spawned shell. */
  env: Record<string, string>;
  /** Pretty-printed .mcp.json contents. Tauri side writes this to cwd. */
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
}

const TOKEN_PATH = join(homedir(), '.papercusp', 'superuser-token');

/**
 * Where the bundled `papercup` shim + `papercup-status.mjs` live so the
 * Tauri launcher can prepend it to PATH. In standalone builds the
 * sidecar bundler should copy these into `sidecar/bin/`; in dev we
 * resolve relative to this module.
 */
function resolveScriptsDir(): string {
  // Standalone build: SIDECAR root contains apps/operator/scripts/.
  // The lib/ file lives at <root>/apps/operator/lib/console-launcher.js
  // post-build, so scripts is a sibling. We resolve via __dirname when
  // available (Node) and fall back to a known relative path.
  try {
    // @ts-ignore — __dirname is a Node global in CJS modules
    if (typeof __dirname === 'string') return resolvePath(__dirname, '..', 'scripts');
  } catch { /* fall through */ }
  // Last resort: use the operator app root via papercuspPath. This is
  // brittle in non-standard layouts but covers the dev-server case.
  return resolvePath(papercuspPath('..', 'apps', 'operator', 'scripts'));
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
  //     terminal one-liner.
  // __dirname-equivalent in CommonJS-compiled Next.js routes resolves
  // here; if the file is bundled differently in standalone build we
  // fall back to the repo-relative scripts path.
  env.PAPERCUSP_SCRIPTS_DIR = resolveScriptsDir();

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

  return {
    cwd,
    env,
    mcpJsonContents,
    greetingCmd: 'papercup status 2>/dev/null || true',
    needsSuperuserBootstrap,
  };
}
