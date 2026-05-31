/**
 * role-codex-home.ts — materialize a per-session CODEX_HOME for an
 * INTERACTIVE codex role session (psu --role=<role> --agent=codex).
 *
 * codex has no `--append-system-prompt` / `--mcp-config` flags: its system
 * prompt is `$CODEX_HOME/AGENTS.md` and its MCP servers are declared in
 * `$CODEX_HOME/config.toml`. So a codex role session needs a dedicated
 * CODEX_HOME, exactly like the `codex-su` wrapper uses for the SU playbook
 * (install-standalone-mcp.sh §4f) — but per-session and role-scoped.
 *
 * This mirrors the orchestrator's `writeSignedSpawnCodexHome`
 * (libs/papercusp/.../spawn-mcp.ts) with one deliberate difference: it
 * consumes an ALREADY-SIGNED url (from `buildRoleLaunchSpec`, the same
 * signed role-scoped url claude/omp role sessions get) instead of signing
 * its own params. All three backends therefore share one signed url per
 * session — the dispatch layer enforces the role allowlist identically
 * (D-001).
 *
 * Layout:
 *   $CODEX_HOME/AGENTS.md     — the role prompt (codex's instruction file)
 *   $CODEX_HOME/config.toml   — [mcp_servers.papercusp] url = "<signed>"
 *                               (sig-auth; no bearer, unlike codex-su)
 *   $CODEX_HOME/auth.json     — symlink → ~/.codex/auth.json (shared
 *                               ChatGPT OAuth; a SYMLINK so token rotation
 *                               happens in-place and never diverges from
 *                               the real login — copying would risk a
 *                               single-use refresh-token logout).
 *
 * Server-only.
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RoleCodexHome {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** The AGENTS.md (role prompt) path — diagnostics. */
  agentsPath: string;
  /** The config.toml (role-scoped MCP) path — diagnostics. */
  configPath: string;
}

/**
 * Build (or rebuild) a per-session CODEX_HOME under
 * `~/.papercusp/role-codex-homes/session-<key>`. Idempotent: the dir is
 * recreated fresh each launch so a re-launch can't inherit a stale prompt
 * or url.
 */
export function writeRoleCodexHome(opts: {
  sessionKey: string | number;
  /** Already-signed, role-scoped MCP url (from buildRoleLaunchSpec). */
  mcpUrl: string;
  /** The role prompt — becomes AGENTS.md. */
  promptText: string;
}): RoleCodexHome {
  const codexHome = join(
    homedir(),
    '.papercusp',
    'role-codex-homes',
    `session-${opts.sessionKey}`,
  );
  // Fresh each launch — a stale AGENTS.md / url must never leak in.
  rmSync(codexHome, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });

  // Share the ChatGPT OAuth login via a SYMLINK (codex resolves auth from
  // $CODEX_HOME/auth.json). Symlink, not copy: codex rotates the refresh
  // token in place against the real file — a copy would strand a
  // single-use token and can log the user out.
  try {
    const realAuth = join(homedir(), '.codex', 'auth.json');
    if (existsSync(realAuth)) symlinkSync(realAuth, join(codexHome, 'auth.json'));
  } catch {
    /* best-effort — codex surfaces an auth error if missing */
  }

  // AGENTS.md = the role prompt. codex has no per-launch system-prompt
  // flag; its instruction file is $CODEX_HOME/AGENTS.md (same mechanism
  // codex-su uses for the engineer playbook).
  const agentsPath = join(codexHome, 'AGENTS.md');
  writeFileSync(agentsPath, opts.promptText, { mode: 0o600 });

  // config.toml: the role-scoped MCP server. The url is already signed
  // (sig-auth), so — unlike the codex-su home — there is no
  // bearer_token_env_var. codex does NOT env-expand config.toml, so the
  // url is baked verbatim.
  const configPath = join(codexHome, 'config.toml');
  const toml = [
    '# Per-session codex role MCP config (managed by bootstrap-role / writeRoleCodexHome).',
    '[mcp_servers.papercusp]',
    `url = "${opts.mcpUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    '',
  ].join('\n');
  writeFileSync(configPath, toml, { mode: 0o600 });

  return { codexHome, agentsPath, configPath };
}
