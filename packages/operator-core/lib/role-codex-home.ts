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
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { codexGatewayConfigToml, tomlEscape } from '@papercusp/orchestrator/codex-gateway-config';


import { dirname as __esmDirname } from 'node:path';
import { fileURLToPath as __esmFileURLToPath } from 'node:url';

// ESM-safe __dirname (plugin-host-runtime.ts pattern): bare __dirname is
// UNDEFINED under tsx file-mode in this type:module package — referencing it
// throws at import (top-level) or call time. This class of bug killed DBOS
// routines fleet-wide on the 2026-06-12 05:30 deploy (change-ledger-scan).
const __dirname = __esmDirname(__esmFileURLToPath(import.meta.url));

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
 *  - `[features] memories = false` — disable codex's native memory tool so the
 *    agent doesn't read/write the native `memories_*.sqlite` store and instead uses
 *    `memory:*`. (Cross-session that store is ALSO neutralized by `freshCodexHome`
 *    wiping the home each launch; this stops within-session use.) The flag was
 *    `memory_tool` through codex 0.137; codex 0.142 renamed it to `memories` and
 *    `memory_tool` is now a deprecated legacy alias that prints a boot warning
 *    (`codex doctor`: "legacy alias memory_tool -> memories"). We write the modern
 *    `memories` key — verified valid under `codex --strict-config` on 0.142.5.
 *
 * Must precede any `[table]` (TOML top-level keys before tables); the `[mcp_servers]`
 * table each writer appends comes after.
 */
const CODEX_ISOLATION_PREAMBLE = [
  '# psu prompt isolation (P-004 / D-001): no cwd AGENTS.md read; native memory off.',
  'project_doc_max_bytes = 0',
  '',
  '[features]',
  'memories = false',
  '',
].join('\n');

const CODEX_LOCK_ENFORCEMENT_NOTE = [
  '---',
  '## Codex Lock Enforcement Status',
  '',
  'Papercusp installs per-session Codex hooks when local hook scripts are present: PreToolUse acquires file locks for apply_patch/Edit/Write and gates shell resource conflicts, while PostToolUse releases locks and reports coordination/activity. If diagnostics show hooks missing or offline, explicitly acquire Papercusp locks with locks:acquire before writing and release them with locks:release.',
  '',
].join('\n');

// The gateway config-TOML builder + tomlEscape are SHARED with the spawned-agent path
// (orchestrator's spawn-mcp.ts writeSignedSpawnCodexHome) via the package's
// `@papercusp/orchestrator/codex-gateway-config` subpath export (imported above) — WI-3645:
// the two local copies had drifted (this one still REQUIRED an account pin, which is why
// interactive `auto` stayed unwired for codex). One builder, one behavior: a pin renders the
// x-papercusp-account header; `gatewayOn` without a pin renders the SAME provider block with
// the header omitted (the gateway auto-selects); neither renders nothing.

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
  inheritUserCodexHome(codexHome);
  return codexHome;
}

const CODEX_HOME_INHERIT_DIRS = ['skills', 'plugins', 'prompts'] as const;
const CODEX_HOME_INHERIT_FILES = ['auth.json'] as const;

/**
 * Carry user-installed Codex capabilities into an isolated per-session home
 * without copying volatile session state. Symlinks are intentional: auth token
 * rotation and skill/plugin updates stay live, and the per-session home remains
 * small enough to recreate every launch.
 */
function inheritUserCodexHome(codexHome: string): void {
  const realHome = join(homedir(), '.codex');
  try {
    if (!existsSync(realHome)) return;
    for (const name of CODEX_HOME_INHERIT_FILES) {
      const src = join(realHome, name);
      const dst = join(codexHome, name);
      if (existsSync(src)) symlinkSync(src, dst);
    }
    for (const name of CODEX_HOME_INHERIT_DIRS) {
      const src = join(realHome, name);
      const dst = join(codexHome, name);
      if (existsSync(src) && lstatSync(src).isDirectory()) symlinkSync(src, dst, 'dir');
    }
  } catch {
    /* best-effort — codex surfaces missing auth/config issues itself */
  }
}

/**
 * tui-status-parity-single-source-2026-07-05 follow-up (live-window verify):
 * codex's TUI writes its OWN OSC-0 terminal title every turn (default items
 * `["activity","project"]`), which CLOBBERS the display.title our
 * posttooluse-objective-title.sh hook writes — verified live 2026-07-05: a
 * hook/manual title was reset to the project name within one turn. An EMPTY
 * `tui.terminal_title` item list stops codex writing titles entirely
 * (verified: a pre-set sentinel title survived boot + a full turn), so the
 * hook owns the title — same single-source display.title as claude/omp.
 */
// codex `[tui]` table. Two knobs, one emission point (TOML forbids duplicate
// table headers):
//  - terminal_title = [] — the objective-title hook owns the title
//    (single-source display.title); an empty item list stops codex writing its
//    OWN OSC-0 title each turn (see the doc comment above).
//  - status_line — gives codex a native BOTTOM status pane (tui-status-parity
//    stopgap D, 2026-07-06). codex 0.142.5 has NO command-backed status item
//    (openai/codex#17827 is unmerged) so we can't render the papercusp fleet
//    chips here — these are codex's OWN native items instead: run-state
//    (Ready/Working/Thinking) · model+reasoning · context% remaining · git
//    branch. All are canonical rust-v0.142.5 StatusLineItem IDs; an unknown id
//    only warns-once + is ignored (codex `doctor` validates TOML structure, not
//    item membership), so a bad id can never break boot. NOT true fleet parity
//    — that needs the upstream command-item PR (B).
const CODEX_TUI_TOML = [
  '# The papercusp objective-title hook owns the terminal title (coord:glance',
  '# display.title); an empty item list stops codex clobbering it each turn.',
  '# status_line: a native bottom status pane (codex-own items — codex 0.142 has',
  '# no command-backed status item, openai/codex#17827; stopgap, not fleet chips).',
  '[tui]',
  'terminal_title = []',
  'status_line = ["run-state", "model-with-reasoning", "context-remaining", "git-branch"]',
  '',
] as const;

// WI-3278: bake the approvals/sandbox bypass into config.toml so it survives any
// codex relaunch that drops the CLI flags (the claude twin lost its ENTIRE argv
// to a 2.1.20x self-re-exec on the Windows VM — same argv-proofing here). The
// launcher's --dangerously-bypass-approvals-and-sandbox stays as the fast path.
// ROOT-LEVEL keys — must be emitted before the first [table] header.
const CODEX_DANGER_TOML = [
  '# psu/role sessions run with full approvals/sandbox bypass (owner mandate:',
  '# psu-launched agents get the most dangerous permissions — WI-3278). Config-',
  '# level so the grant survives a relaunch that drops the CLI flags.',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
] as const;

/** Trust state for the generated home's config.toml.
 *
 *  Two sources, one emission point (TOML forbids duplicate table headers):
 *  1. INHERITED — the user's real ~/.codex/config.toml trust tables. Modern
 *     codex records directory trust as `[projects."<path>"] trust_level`
 *     (ProjectConfig); `[trusted_workspaces]` is the legacy shape we used to
 *     inherit EXCLUSIVELY — which silently became a no-op once codex moved to
 *     `projects.*`, so every fresh per-session home booted untrusted and the
 *     TUI blocked on "Do you trust the contents of this directory?"
 *     (live-caught 2026-07-05, psu codex session-10753).
 *  2. SEEDED — `trustDir`, the directory the operator is launching the agent
 *     into. A psu/role launch is trusted by definition (the launcher already
 *     passes --dangerously-bypass-hook-trust + YOLO permissions), and a fresh
 *     CODEX_HOME never carries an answer forward — without the seed, every
 *     scripted codex launch hangs at the trust prompt.
 */
function inheritedCodexTrustToml(trustDir?: string | null): string[] {
  const source = join(homedir(), '.codex', 'config.toml');
  const out: string[] = [];
  if (existsSync(source)) {
    let keep = false;
    for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
      const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (table) {
        keep =
          table[1] === 'trusted_workspaces' ||
          table[1].startsWith('trusted_workspaces.') ||
          table[1] === 'projects' ||
          table[1].startsWith('projects.');
      }
      if (keep) out.push(line);
    }
  }
  const inherited = out.length > 0 ? ['# Inherited trust state from ~/.codex/config.toml.', ...out, ''] : [];
  if (trustDir) {
    const header = `[projects."${tomlEscape(trustDir)}"]`;
    const alreadyInherited = inherited.some((l) => l.trim() === header);
    if (!alreadyInherited) {
      inherited.push(
        '# Launch-dir trust seeded by the operator (a psu/role launch is trusted by',
        '# definition) — a fresh CODEX_HOME otherwise blocks on the trust prompt.',
        header,
        'trust_level = "trusted"',
        '',
      );
    }
  }
  return inherited;
}

function copyInheritedCodexPrompts(codexHome: string): boolean {
  const prompts = join(codexHome, 'prompts');
  if (!existsSync(prompts)) return false;
  try {
    if (lstatSync(prompts).isSymbolicLink()) {
      const managed = join(codexHome, 'prompts.user');
      unlinkSync(prompts);
      cpSync(join(homedir(), '.codex', 'prompts'), managed, { recursive: true, force: true, dereference: true });
      symlinkSync(managed, prompts, 'dir');
      return true;
    }
  } catch {
    /* saved-prompt materialization can recreate prompts if inheritance fails */
  }
  return false;
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
 * TURN PROVENANCE (turn-provenance-owner-vs-agent-2026-07-11 P-004): codex fires
 * ONLY PreToolUse/PostToolUse — no UserPromptSubmit-equivalent event exists in
 * its hooks.json, so the trust-layer classification hook cannot attach here.
 * Codex sessions run LAYER-1 ONLY: injected turns still carry the
 * `⟦turn-origin:… nonce:…⟧` envelope (tagged operator-side, backend-agnostic),
 * visible to the model but not ledger-VERIFIED. Revisit if codex adds a
 * prompt-submit hook event.
 *
 * LOCK HOOKS: current Codex discovers this per-session `hooks.json` and fires
 * PreToolUse/PostToolUse for `apply_patch` (plus the Edit/Write aliases) and
 * shell/MCP tool names. The launcher passes `--dangerously-bypass-hook-trust`
 * because this home contains only Papercusp-managed hooks.
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
 * PostToolUse fires for edits + Bash + MCP, so this is reliable on codex. We
 * BAKE PAPERCUSP_SID=<activitySid> + PAPERCUSP_
 * AGENT=codex because codex hands hooks a minimal env (the same reason coord +
 * the lock hooks bake their values). Unlike the coord hook this fires for BOTH
 * su AND role sessions — role sessions ARE workers, so their activity belongs in
 * the fleet view.
 *
 * OBJECTIVE-TITLE HOOK (su + role) — NOT inert when `objectiveSid` is given. The
 * codex leg of the SESSION-OBJECTIVE DISPLAY (session-objective-display-2026-06-22,
 * P-003): codex has no statusline, but it owns a tty, so each PostToolUse sets the
 * terminal TITLE to this session's `coord:glance` self.objective via an OSC-0
 * escape — the same objective the Claude statusline renders as its leading 🔭
 * segment. Fires for su AND role (both want their tab/window title to say what
 * they're doing). PAPERCUSP_SID=<objectiveSid> is baked (codex's minimal hook env).
 */
export function writeCodexLockHooks(
  codexHome: string,
  opts: { coordSid?: string; activitySid?: string; objectiveSid?: string; agentSession?: boolean } = {},
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

  // Objective-title hook (matcher `.*`): set the terminal title to this session's
  // coord:glance self.objective (session-objective-display-2026-06-22). Baked
  // PAPERCUSP_SID = the session's coord identity (the glance read keys off it).
  const objective = join(dir, 'posttooluse-objective-title.sh');
  if (opts.objectiveSid && existsSync(objective)) {
    postToolUse.push({
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_SID=${shellSingleQuote(opts.objectiveSid)} ${objective}`,
      }],
    });
  }

  const preToolUse: CodexHook[] = [
    { matcher: CODEX_LOCK_MATCHER, hooks: [{ type: 'command', command: `PAPERCUSP_WORKSPACE_ROOT=${root} ${pre}` }] },
  ];

  // Native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010):
  // AGENT homes (role sessions — never the human su home, D-003) get the
  // bash-resource-gate with the agent marker BAKED (codex hands hooks a
  // minimal env, same reason the coord/activity hooks bake PAPERCUSP_SID), so
  // shell-created OS schedules (crontab/at/batch/systemd-run) are denied and
  // wakes can only live in the harness routines table.
  const gate = join(dir, 'pretooluse-bash-resource-gate.sh');
  if (opts.agentSession && existsSync(gate)) {
    preToolUse.push({
      matcher: 'Bash|exec_command|local_shell|shell',
      hooks: [{
        type: 'command',
        command: `PAPERCUSP_WORKSPACE_ROOT=${root} PAPERCUSP_AGENT_SESSION=1 ${gate}`,
      }],
    });
  }

  const hooks = {
    hooks: {
      PreToolUse: preToolUse,
      PostToolUse: postToolUse,
    },
  };
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify(hooks, null, 2), { mode: 0o600 });
  return true;
}

function writeCodexHomeDiagnostics(
  codexHome: string,
  opts: { hooksInstalled: boolean; inheritedPromptsCopied: boolean },
): void {
  const body = {
    lockEnforcement: opts.hooksInstalled ? 'hooks-configured' : 'hooks-missing',
    codexPreToolUseStatus: opts.hooksInstalled ? 'codex-hooks-stable-pretooluse' : 'hooks-not-installed',
    requiresExplicitPapercuspLocks: !opts.hooksInstalled,
    inheritedPromptsCopied: opts.inheritedPromptsCopied,
  };
  writeFileSync(join(codexHome, 'papercusp-diagnostics.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

function codexAgentsPrompt(promptText: string): string {
  return `${promptText.replace(/\n+$/, '')}\n\n${CODEX_LOCK_ENFORCEMENT_NOTE}`;
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
  /** Optional Codex account pin; writes a custom model provider that points Codex at the inference gateway. */
  codexGatewayAccountId?: string | null;
  /** Route through the gateway with NO pin (explicit-auto, WI-3645): writes the SAME provider
   *  block with the x-papercusp-account header omitted — the gateway auto-selects. Ignored
   *  when codexGatewayAccountId is set. */
  codexGatewayAuto?: boolean;
  /** The directory the operator is launching this agent into (spec.cwd). Seeded
   *  as `[projects."<dir>"] trust_level = "trusted"` so a fresh CODEX_HOME does
   *  not block at codex's "Do you trust this directory?" boot prompt. */
  trustDir?: string | null;
}): RoleCodexHome {
  // ONE shared codex-home key (unify-launch-mechanics P-004): both role and su
  // codex sessions live under the SAME root the wake-executor resume leg reads
  // (`codexHomeForAdvSession` → `codexHomeForSessionKey`). Previously the role
  // path wrote to a separate `role-codex-homes/` root the resume leg never
  // looked in, so a woken codex role session resumed from nothing.
  const codexHome = freshCodexHome(codexHomeForSessionKey(opts.sessionKey));
  const inheritedPromptsCopied = copyInheritedCodexPrompts(codexHome);

  // AGENTS.md = the role prompt. codex has no per-launch system-prompt
  // flag; its instruction file is $CODEX_HOME/AGENTS.md (same mechanism
  // codex-su uses for the engineer playbook).
  const agentsPath = join(codexHome, 'AGENTS.md');
  writeFileSync(agentsPath, codexAgentsPrompt(opts.promptText), { mode: 0o600 });

  // config.toml: the role-scoped MCP server. The url is already signed
  // (sig-auth), so — unlike the codex-su home — there is no
  // bearer_token_env_var. codex does NOT env-expand config.toml, so the
  // url is baked verbatim.
  const configPath = join(codexHome, 'config.toml');
  const gatewayConfig = codexGatewayConfigToml(opts.codexGatewayAccountId, { gatewayOn: opts.codexGatewayAuto });
  const toml = [
    ...gatewayConfig.root,
    ...CODEX_DANGER_TOML,
    CODEX_ISOLATION_PREAMBLE,
    ...inheritedCodexTrustToml(opts.trustDir),
    ...gatewayConfig.tables,
    ...CODEX_TUI_TOML,
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
  const hooksInstalled = writeCodexLockHooks(codexHome, {
    activitySid: opts.sid,
    objectiveSid: opts.sid,
    agentSession: true,
  });
  writeCodexHomeDiagnostics(codexHome, { hooksInstalled, inheritedPromptsCopied });

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

export interface CodexPapercuspDiagnostics {
  lockEnforcement?: string;
  codexPreToolUseStatus?: string;
  requiresExplicitPapercuspLocks?: boolean;
  inheritedPromptsCopied?: boolean;
}

export interface CodexHomeDiagnostics {
  codexHome: string;
  exists: boolean;
  agentsPath: string;
  agentsExists: boolean;
  configPath: string;
  configExists: boolean;
  hooksPath: string;
  hooksExists: boolean;
  promptsPath: string;
  promptsExists: boolean;
  authPath: string;
  authExists: boolean;
  diagnosticsPath: string;
  diagnosticsExists: boolean;
  diagnostics: CodexPapercuspDiagnostics | null;
  latestRolloutId: string | null;
  latestRolloutPath: string | null;
  resumeStrategy: 'codex-resume-last-in-code-home';
  resumeCommand: string;
  error: string | null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function coerceCodexPapercuspDiagnostics(raw: Record<string, unknown> | null): CodexPapercuspDiagnostics | null {
  if (!raw) return null;
  return {
    ...(typeof raw.lockEnforcement === 'string' ? { lockEnforcement: raw.lockEnforcement } : {}),
    ...(typeof raw.codexPreToolUseStatus === 'string' ? { codexPreToolUseStatus: raw.codexPreToolUseStatus } : {}),
    ...(typeof raw.requiresExplicitPapercuspLocks === 'boolean'
      ? { requiresExplicitPapercuspLocks: raw.requiresExplicitPapercuspLocks }
      : {}),
    ...(typeof raw.inheritedPromptsCopied === 'boolean'
      ? { inheritedPromptsCopied: raw.inheritedPromptsCopied }
      : {}),
  };
}

function latestCodexRollout(codexHome: string): { id: string; path: string } | null {
  const root = join(codexHome, 'sessions');
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p, depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        let mtimeMs = 0;
        try {
          mtimeMs = lstatSync(p).mtimeMs;
        } catch {
          // keep deterministic enough if stat races with session cleanup
        }
        files.push({ path: p, mtimeMs });
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  const latest = files[0];
  if (!latest) return null;
  const match = latest.path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return { id: match?.[1] ?? latest.path.split('/').pop()!.replace(/^rollout-/, '').replace(/\.jsonl$/, ''), path: latest.path };
}

export function readCodexHomeDiagnostics(sessionKey: string | number): CodexHomeDiagnostics {
  const codexHome = codexHomeForSessionKey(sessionKey);
  const agentsPath = join(codexHome, 'AGENTS.md');
  const configPath = join(codexHome, 'config.toml');
  const hooksPath = join(codexHome, 'hooks.json');
  const promptsPath = join(codexHome, 'prompts');
  const authPath = join(codexHome, 'auth.json');
  const diagnosticsPath = join(codexHome, 'papercusp-diagnostics.json');
  try {
    const rollout = latestCodexRollout(codexHome);
    return {
      codexHome,
      exists: existsSync(codexHome),
      agentsPath,
      agentsExists: existsSync(agentsPath),
      configPath,
      configExists: existsSync(configPath),
      hooksPath,
      hooksExists: existsSync(hooksPath),
      promptsPath,
      promptsExists: existsSync(promptsPath),
      authPath,
      authExists: existsSync(authPath),
      diagnosticsPath,
      diagnosticsExists: existsSync(diagnosticsPath),
      diagnostics: coerceCodexPapercuspDiagnostics(readJsonObject(diagnosticsPath)),
      latestRolloutId: rollout?.id ?? null,
      latestRolloutPath: rollout?.path ?? null,
      resumeStrategy: 'codex-resume-last-in-code-home',
      resumeCommand: `CODEX_HOME=${shellSingleQuote(codexHome)} codex resume --last`,
      error: null,
    };
  } catch (e) {
    return {
      codexHome,
      exists: false,
      agentsPath,
      agentsExists: false,
      configPath,
      configExists: false,
      hooksPath,
      hooksExists: false,
      promptsPath,
      promptsExists: false,
      authPath,
      authExists: false,
      diagnosticsPath,
      diagnosticsExists: false,
      diagnostics: null,
      latestRolloutId: null,
      latestRolloutPath: null,
      resumeStrategy: 'codex-resume-last-in-code-home',
      resumeCommand: `CODEX_HOME=${shellSingleQuote(codexHome)} codex resume --last`,
      error: e instanceof Error ? e.message : String(e),
    };
  }
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
  /** Optional Codex account pin; writes a custom model provider that points Codex at the inference gateway. */
  codexGatewayAccountId?: string | null;
  /** Route through the gateway with NO pin (explicit-auto, WI-3645): writes the SAME provider
   *  block with the x-papercusp-account header omitted — the gateway auto-selects. Ignored
   *  when codexGatewayAccountId is set. */
  codexGatewayAuto?: boolean;
  /** The directory the operator is launching this SU session into (resolveSuLaunchCwd).
   *  Seeded as `[projects."<dir>"] trust_level = "trusted"` so a fresh CODEX_HOME
   *  does not block at codex's "Do you trust this directory?" boot prompt. */
  trustDir?: string | null;
}): SuCodexHome {
  const codexHome = freshCodexHome(codexHomeForSessionKey(opts.sessionKey));
  const inheritedPromptsCopied = copyInheritedCodexPrompts(codexHome);

  const agentsPath = join(codexHome, 'AGENTS.md');
  writeFileSync(agentsPath, codexAgentsPrompt(opts.promptText), { mode: 0o600 });

  // Bake the per-session client identity into the url (codex can't env-expand
  // config.toml) + the superuser bearer as an http_headers Authorization
  // (D-006 — the env-var form doesn't deliver on codex 0.135).
  const sep = opts.mcpUrl.includes('?') ? '&' : '?';
  const url = `${opts.mcpUrl}${sep}client=${encodeURIComponent(opts.sid)}`;
  const configPath = join(codexHome, 'config.toml');
  const gatewayConfig = codexGatewayConfigToml(opts.codexGatewayAccountId, { gatewayOn: opts.codexGatewayAuto });
  const toml = [
    ...gatewayConfig.root,
    ...CODEX_DANGER_TOML,
    CODEX_ISOLATION_PREAMBLE,
    ...inheritedCodexTrustToml(opts.trustDir),
    ...gatewayConfig.tables,
    ...CODEX_TUI_TOML,
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
  const hooksInstalled = writeCodexLockHooks(codexHome, {
    coordSid: opts.sid,
    activitySid: opts.sid,
    objectiveSid: opts.sid,
  });
  writeCodexHomeDiagnostics(codexHome, { hooksInstalled, inheritedPromptsCopied });

  return { codexHome, agentsPath, configPath };
}
