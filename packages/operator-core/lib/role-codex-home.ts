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
import { join, resolve } from 'node:path';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';

export interface RoleCodexHome {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** The AGENTS.md (role prompt) path — diagnostics. */
  agentsPath: string;
  /** The config.toml (role-scoped MCP) path — diagnostics. */
  configPath: string;
}

// ── Shared codex-home internals (role + su) ───────────────────────────

/** codex's file-edit tool is `apply_patch` (canonical); `Edit`/`Write` are
 *  documented matcher aliases. (developers.openai.com/codex/hooks, PR #18391) */
const CODEX_LOCK_MATCHER = 'apply_patch|Edit|Write';

/**
 * TOML preamble baked into EVERY per-session codex home (psu-isolation P-004 /
 * D-001) — isolate a psu codex session from the launching user's project doc +
 * codex's native memory, so it is steered ONLY by the home's AGENTS.md (the psu
 * playbook + the P-001 project-guide splice) and uses the hybrid `memory:*` MCP.
 *
 *  - `project_doc_max_bytes = 0` — codex otherwise reads `<cwd>/AGENTS.md` (on the
 *    papercup tree that's a symlink to `CLAUDE.md` = the project guide) and merges
 *    it into instructions. Now redundant: the guide reaches the session via the
 *    home's AGENTS.md. Capping at 0 drops the cwd read — a single delivery path,
 *    consistent with the claude/omp isolation.
 *  - `[features] memory_tool = false` — disable codex's native memory tool (a
 *    codex-0.137 `[features]` flag; `[features] <flag> = false` is the documented
 *    disable) so the agent doesn't read/write the native `memories_*.sqlite` store
 *    and instead uses `memory:*`. (Cross-session that store is ALSO neutralized by
 *    `freshCodexHome` wiping the home each launch; this stops within-session use.)
 *
 * Must precede any `[table]` (TOML top-level keys before tables); the `[mcp_servers]`
 * table each writer appends comes after.
 */
const CODEX_ISOLATION_PREAMBLE = [
  '# psu prompt isolation (P-004 / D-001): no cwd AGENTS.md read; native memory off.',
  'project_doc_max_bytes = 0',
  '',
  '[features]',
  'memory_tool = false',
  '',
].join('\n');

/** Escape a value for a TOML double-quoted basic string. */
function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Single-quote a value for a shell command (env prefix). */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Workspace root the lock hooks scope to — the parent of the harness
 *  worktrees. Honors PAPERCUSP_WORKSPACE_ROOT (matches the installer's
 *  explicit set); else 4 dirs up from this module (apps/operator/lib →
 *  …/papercupai-workspace), which is also the hook script's own default. */
function resolveWorkspaceRoot(): string {
  return process.env.PAPERCUSP_WORKSPACE_ROOT || resolve(__dirname, '..', '..', '..', '..');
}

/** Rebuild a per-session codex home dir fresh + share the ChatGPT OAuth
 *  login via a SYMLINK (never a copy — a copied single-use refresh token
 *  can log the user out). Returns the home path. */
function freshCodexHome(codexHome: string): string {
  rmSync(codexHome, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
  try {
    const realAuth = join(homedir(), '.codex', 'auth.json');
    if (existsSync(realAuth)) symlinkSync(realAuth, join(codexHome, 'auth.json'));
  } catch {
    /* best-effort — codex surfaces an auth error if missing */
  }
  return codexHome;
}

/**
 * Write a fresh `hooks.json` into a per-session CODEX_HOME carrying ONLY the
 * SU-locks Pre/PostToolUse hooks (P-030). The home is recreated each launch,
 * so there is nothing to merge — we write our two entries verbatim. No-op
 * (returns false) when the shared hook scripts aren't installed at
 * `~/.papercusp/hooks/cc/`. The launcher must exec codex with
 * `--dangerously-bypass-hook-trust` (the only hooks here are ours).
 *
 * FILE NAME (D-010): codex discovers hooks at `$CODEX_HOME/hooks.json` or
 * `config.toml [[hooks.PreToolUse]]` — NOT `settings.json` (the Claude path
 * the installer §4f + an earlier version of this wrote, which codex silently
 * ignored). We write `hooks.json`.
 *
 * LOCK HOOKS CURRENTLY INERT (D-011): codex 0.135/0.136-alpha do NOT actually
 * fire PreToolUse for `apply_patch` OR `Bash` in practice (upstream openai/codex
 * #20204 / #16732 — open). So the *lock* config is *correct + ready* but
 * enforces nothing until codex's hook emission is fixed upstream. codex lock
 * coordination is SOFT meanwhile (the playbook instructs voluntary `locks:*`
 * calls). claude's user-level lock hooks DO fire — only codex is affected.
 *
 * COORD PUSH HOOK (SU only) — NOT inert. When `coordSid` is given (SU sessions
 * pass their session id), we ALSO add a PostToolUse coord-inbox hook. Unlike
 * PreToolUse, codex's PostToolUse DOES fire for Bash / `apply_patch` / MCP
 * calls (developers.openai.com/codex/hooks), so the SU agent gets new
 * coord:inbox messages injected mid-turn — the codex counterpart of the
 * Claude global-settings coord entry. We BAKE PAPERCUSP_SID=<coordSid>: codex
 * doesn't env-expand config, and the hook both gates on and addresses its
 * inbox by PAPERCUSP_SID, which must equal the `&client=<sid>` baked into the
 * SU MCP url. Role sessions get no coord hook (they coordinate via
 * messages:feature_*, not the SU coord bus).
 *
 * ACTIVITY HOOK (su + role) — NOT inert when `activitySid` is given. The codex
 * leg of the cross-CLI ACTIVITY BRIDGE (papercusp-worker-integration-2026-06-04,
 * D-002/D-003): every PostToolUse mirrors the worker's native tool call into
 * harness_shared.agent_activity → the pui fleet view + curator. codex's
 * PostToolUse fires for edits + Bash + MCP (only PreToolUse is broken — D-006),
 * so this is reliable on codex. We BAKE PAPERCUSP_SID=<activitySid> + PAPERCUSP_
 * AGENT=codex because codex hands hooks a minimal env (the same reason coord +
 * the lock hooks bake their values). Unlike the coord hook this fires for BOTH
 * su AND role sessions — role sessions ARE workers, so their activity belongs in
 * the fleet view.
 */
export function writeCodexLockHooks(
  codexHome: string,
  opts: { coordSid?: string; activitySid?: string } = {},
): boolean {
  const dir = join(homedir(), '.papercusp', 'hooks', 'cc');
  const pre = join(dir, 'pretooluse-locks-acquire.sh');
  const post = join(dir, 'posttooluse-locks-release.sh');
  if (!existsSync(pre) || !existsSync(post)) return false;
  const root = shellSingleQuote(resolveWorkspaceRoot());

  type CodexHook = { matcher: string; hooks: { type: 'command'; command: string }[] };
  const postToolUse: CodexHook[] = [
    { matcher: CODEX_LOCK_MATCHER, hooks: [{ type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=${root} ${post}` }] },
  ];

  // SU coord push hook (matcher `.*` — every PostToolUse-eligible tool, for
  // max cadence). Baked PAPERCUSP_SID = the session's coord identity.
  const coord = join(dir, 'posttooluse-coord-inbox.sh');
  if (opts.coordSid && existsSync(coord)) {
    postToolUse.push({
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_SID=${shellSingleQuote(opts.coordSid)} ${coord}`,
      }],
    });
  }

  // Activity-bridge hook (matcher `.*`). Baked PAPERCUSP_SID = the session's
  // identity (the activity owner/pane key) + PAPERCUSP_AGENT=codex.
  const activity = join(dir, 'posttooluse-activity-report.sh');
  if (opts.activitySid && existsSync(activity)) {
    postToolUse.push({
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_AGENT=codex PAPERCUSP_SID=${shellSingleQuote(opts.activitySid)} ${activity}`,
      }],
    });
  }

  const hooks = {
    hooks: {
      PreToolUse: [
        { matcher: CODEX_LOCK_MATCHER, hooks: [{ type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=${root} ${pre}` }] },
      ],
      PostToolUse: postToolUse,
    },
  };
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(hooks, null, 2), { mode: 0o600 });
  return true;
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
  /** The session's coordination identity (PAPERCUSP_SID = role-<uuid>). Baked
   *  into the activity-bridge hook so this worker's tool calls report under it.
   *  Omit → no activity hook (a role home without an identity). */
  sid?: string;
}): RoleCodexHome {
  // ONE shared codex-home key (unify-launch-mechanics P-004): both role and su
  // codex sessions live under the SAME root the wake-executor resume leg reads
  // (`codexHomeForAdvSession` → `codexHomeForSessionKey`). Previously the role
  // path wrote to a separate `role-codex-homes/` root the resume leg never
  // looked in, so a woken codex role session resumed from nothing.
  const codexHome = freshCodexHome(codexHomeForSessionKey(opts.sessionKey));

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
    CODEX_ISOLATION_PREAMBLE,
    '# Per-session codex role MCP config (managed by bootstrap-role / writeRoleCodexHome).',
    '[mcp_servers.papercusp]',
    `url = "${tomlEscape(opts.mcpUrl)}"`,
    '',
  ].join('\n');
  writeFileSync(configPath, toml, { mode: 0o600 });

  // P-030: a role codex session edits files too — install the same SU-locks
  // hooks so its edits are coordinated (the role home previously had none,
  // a silent gap). Launcher must pass --dangerously-bypass-hook-trust. A role
  // session is a WORKER, so it also reports to the activity bridge (under its
  // session identity); no coord-inbox hook (roles don't ride the SU coord bus).
  writeCodexLockHooks(codexHome, { activitySid: opts.sid });

  return { codexHome, agentsPath, configPath };
}

export interface SuCodexHome {
  /** Absolute path to set as the child's CODEX_HOME. */
  codexHome: string;
  /** The AGENTS.md (engineer playbook) path — diagnostics. */
  agentsPath: string;
  /** The config.toml (superuser MCP) path — diagnostics. */
  configPath: string;
}

/**
 * Materialize a per-session CODEX_HOME for an interactive SUPERUSER (`su`)
 * codex session (psu su --agent=codex). The codex counterpart of the
 * claude/omp raw-CLI su launch — codex has no --mcp-config/-prompt flags,
 * so the engineer playbook is AGENTS.md and the superuser MCP is declared
 * in config.toml. Per-session port of install-standalone-mcp.sh §4f
 * (the static `codex-su` home), with two differences:
 *   - the `&client=<sid>` is baked per session (codex does NOT env-expand
 *     config.toml; the static wrapper overrode it via `-c` at launch).
 *   - the SU-locks hooks are written here (writeCodexLockHooks), so the
 *     home is self-contained.
 *
 * D-006 — the superuser bearer is baked into config.toml as
 * `http_headers = { Authorization = "Bearer <tok>" }`, NOT via
 * `bearer_token_env_var`. Verified on codex 0.135: the env-var form
 * connects but does NOT deliver a valid bearer for a streamable_http
 * server (→ `isSuperuser:false`), while the baked header works
 * (→ `isSuperuser:true`, the 217-tool superuser surface). The static
 * `codex-su` wrapper uses the env-var form and shares this latent bug.
 * Baking the token is acceptable: the home is mode-0600 + ephemeral
 * (rebuilt each launch), exactly like claude's `~/.claude.json` header.
 * Launcher execs codex with `--dangerously-bypass-hook-trust`.
 */
export function writeSuCodexHome(opts: {
  sessionKey: string | number;
  /** Superuser MCP url (?superuser=1&workspace=…) from buildLaunchSpec(su). */
  mcpUrl: string;
  /** The engineer playbook — becomes AGENTS.md. */
  promptText: string;
  /** Per-session coordination identity, baked into the url's &client=. */
  sid: string;
  /** Superuser bearer token, baked as an http_headers Authorization (D-006).
   *  Omit only when no token is installed → a degraded non-superuser home. */
  token?: string | null;
}): SuCodexHome {
  const codexHome = freshCodexHome(codexHomeForSessionKey(opts.sessionKey));

  const agentsPath = join(codexHome, 'AGENTS.md');
  writeFileSync(agentsPath, opts.promptText, { mode: 0o600 });

  // Bake the per-session client identity into the url (codex can't env-expand
  // config.toml) + the superuser bearer as an http_headers Authorization
  // (D-006 — the env-var form doesn't deliver on codex 0.135).
  const sep = opts.mcpUrl.includes('?') ? '&' : '?';
  const url = `${opts.mcpUrl}${sep}client=${encodeURIComponent(opts.sid)}`;
  const configPath = join(codexHome, 'config.toml');
  const toml = [
    CODEX_ISOLATION_PREAMBLE,
    '# Per-session codex SU home config (managed by bootstrap-su / writeSuCodexHome).',
    '[mcp_servers.papercusp-su]',
    `url = "${tomlEscape(url)}"`,
    ...(opts.token
      ? [`http_headers = { Authorization = "Bearer ${tomlEscape(opts.token)}" }`]
      : []),
    '',
  ].join('\n');
  writeFileSync(configPath, toml, { mode: 0o600 });

  // SU sessions also get the coord-inbox PUSH hook (new coord:inbox messages
  // injected mid-turn, parity with the Claude global-settings coord entry) AND
  // the activity-bridge hook (an SU/engineer session is a worker too) — both
  // keyed to the session id.
  writeCodexLockHooks(codexHome, { coordSid: opts.sid, activitySid: opts.sid });

  return { codexHome, agentsPath, configPath };
}
