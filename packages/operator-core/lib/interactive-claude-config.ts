/**
 * interactive-claude-config.ts — materialize a per-session `CLAUDE_CONFIG_DIR`
 * for an INTERACTIVE claude session (psu su / psu --role on the claude backend).
 *
 * The EI-155 fix, and the interactive-claude leg of the EI-153 per-session
 * conversation-store isolation (unify-launch-mechanics D-002). The orchestrator
 * bee path already isolates headless spawns via `writeSpawnClaudeConfig`
 * (spawn-mcp.ts) — but that mints a DELIBERATELY MINIMAL, plugin-free config dir
 * (creds symlink only): correct for a `-p` worker that must resolve ZERO plugins
 * (the plugin-checkout-into-cwd defect), wrong for a human at the keyboard.
 *
 * An interactive session is the user's FULL environment, so a creds-only dir is
 * unsafe — verified live on claude-code 2.1.169:
 *   - `CLAUDE_CONFIG_DIR` relocates ALL of `~/.claude` **and** the sibling
 *     `~/.claude.json` into it (the older invoke.ts note that "`.claude.json`
 *     stays at $HOME" is stale for current claude). A fresh dir therefore loses:
 *   - the user-level `papercusp-su` MCP server (lives in `~/.claude.json`) → an
 *     SU session with NO tools;
 *   - the file-lock + coord Pre/PostToolUse hooks (live in
 *     `~/.claude/settings.json`) → the shared-tree lock discipline silently off;
 *   - the user's plugins/skills (`~/.claude/plugins`), slash commands, themes;
 *   - the onboarding/trust state (`~/.claude.json`) → a re-onboarding flow
 *     (theme picker / trust prompt / login) that BLOCKS an interactive launch.
 *
 * So instead of a minimal dir we build a **symlink mirror** of `~/.claude` with
 * TWO things isolated: the conversation transcript store `projects/` (EI-153),
 * and the user's PERSONAL MEMORY files (psu-isolation P-002 / D-001 — below).
 * Every other top-level entry — `.credentials.json`, `settings.json`, `plugins/`,
 * `commands/`, … — is symlinked back to the real `~/.claude/<entry>` (writes pass
 * through for in-place writers), the sibling `~/.claude.json` is symlinked in,
 * and `projects/` is a fresh real directory.
 *
 * ⚠ CREDENTIALS DO NOT STAY SYMLINKED. claude rewrites `.credentials.json` by
 * REPLACING the file (temp + rename), so the first OAuth refresh / `/login`
 * inside a session swaps the symlink for a divergent real-file fork — and with
 * Anthropic's single-use rotating refresh tokens, forks mutually invalidate
 * (the every-terminal-relogin cascade; upstream anthropics/claude-code#48786).
 * The fix is NOT here: the operator's background reconciler
 * (`claude-credential-sync.ts`) converges every fork + the global file on the
 * newest bundle. This launcher's part is the reconcile-before-mirror call in
 * `writeInteractiveClaudeConfig`, so a NEW session symlinks a global file that
 * already holds the newest family member (seed-from-newest,
 * claude-credential-sync-2026-06-10 P-002).
 *
 * ── psu prompt isolation (P-002 / D-001) ──────────────────────────────────────
 * A psu session must be governed ONLY by the psu playbook (+ the P-001 project-
 * guide splice), NOT by the launching user's personal config. But a plain mirror
 * symlinks `~/.claude/CLAUDE.md` in, and claude auto-loads `$CLAUDE_CONFIG_DIR/
 * CLAUDE.md` as global memory (on this box `CLAUDE.md` = `@AGENTS.md`, the owner's
 * memory rules / prefs) — the exact leak the owner raised. So we DON'T link the
 * personal-memory entries (`CLAUDE.md` / `AGENTS.md` / `CLAUDE.local.md`); the
 * session then has no global memory file and is steered solely by psu.
 *
 * Why this (a non-inheriting CLAUDE_CONFIG_DIR) and NOT `--bare`: the plan's
 * primary was `claude --bare` (it drops CLAUDE.md auto-discovery wholesale). But
 * `--bare` on claude-code 2.1.169 ALSO refuses to read OAuth / keychain auth
 * (`--help`: "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper") —
 * and psu Claude sessions on this box authenticate ONLY via the Claude-Max OAuth
 * in `~/.claude/.credentials.json` (no ANTHROPIC_API_KEY). So `--bare` would make
 * every interactive psu Claude session unauthenticated — the dead-end P-002's
 * fallback anticipated. This config-dir approach keeps OAuth + the file-lock hooks
 * (`settings.json`) + the `papercusp-su` MCP (`~/.claude.json`) intact while
 * killing only the personal-memory leak — the same shape Codex already uses
 * (a dedicated CODEX_HOME). RESIDUAL: the cwd-discovered PROJECT `CLAUDE.md` (the
 * repo's own guide) still auto-loads for a repo-cwd session; that's benign (it's
 * the repo guide, also delivered by the P-001 splice for non-repo cwds / non-claude
 * clients), not personal leakage.
 *
 * The session is the user's environment for AUTH + TOOLS + HOOKS, but its
 * transcripts land under `<configDir>/projects/**` and it loads NO personal memory.
 *
 * That is exactly the isolation EI-153 needs:
 *   - `/resume` and the picker no longer surface peers' sessions (transcripts are
 *     scoped to this dir);
 *   - the dir is keyed by the session's coord-owner id (`PAPERCUSP_SID`) via the
 *     ONE shared `sessionClaudeConfigDir` helper, so the wake-executor resume leg
 *     (which sets `CLAUDE_CONFIG_DIR = sessionClaudeConfigDir(coordOwnerId)` when
 *     it exists) points the woken `claude --resume <uuid>` at the SAME dir the
 *     launch wrote to — launch and resume agree by construction, not by two
 *     string literals that can drift.
 *
 * The dir is PERSISTENT (the wake-executor reads it after the launch process
 * dies); like the bee path it is not cleaned up here.
 *
 * Server-only.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { reconcileClaudeCredentials } from './claude-credential-sync';

export interface InteractiveClaudeConfig {
  /** Absolute path to set as the interactive session's `CLAUDE_CONFIG_DIR`. */
  configDir: string;
}

/** Top-level `~/.claude` entry that gets a fresh real dir (NOT a symlink) so the
 *  session's conversation transcripts are isolated from the shared store. */
const ISOLATED_ENTRY = 'projects';

/**
 * Top-level `~/.claude` entries that are the launching user's PERSONAL global
 * memory / instructions — deliberately NOT mirrored into a psu session's config
 * dir (psu-isolation P-002 / D-001). `CLAUDE.md` is claude's global-memory file
 * (here `@AGENTS.md`); skipping it (and its include target / local variant) means
 * the session loads no personal memory and is governed only by the psu playbook +
 * the P-001 project-guide splice. Auth/hooks/MCP/plugins still link through.
 */
const PERSONAL_MEMORY_ENTRIES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);

/**
 * context-trimming-tiers P-020: plugins whose tool schemas a FLEET member never
 * needs (github ~40 tools, cloudflare docs, firecrawl — ~10k+ tokens of schemas
 * per session). Matched on the plugin NAME half of `name@marketplace`. context7
 * + verdict + the LSP/review plugins stay. The playwright mcpServer (in
 * `.claude.json`) is pruned alongside.
 */
const FLEET_PRUNED_PLUGIN_NAMES = new Set(['github', 'cloudflare', 'firecrawl']);
const FLEET_PRUNED_MCP_SERVERS = new Set(['playwright']);

/**
 * WI-3280 (argv-proof playbook delivery) — file names inside the session
 * config dir. `RECOVER_HOOK` is a SessionStart hook script (registered in the
 * session settings.json by writeSessionSettings); `RECOVER_PLAYBOOK` /
 * `RECOVER_INTENT` are the parked playbook copy + launch metadata the hook
 * injects from when it detects that claude's self-re-exec dropped the argv.
 * Exported for the launcher-side writers and tests.
 */
export const RECOVER_HOOK = 'session-recover-hook.mjs';
export const RECOVER_PLAYBOOK = 'launch-playbook.md';
export const RECOVER_INTENT = 'launch-intent.json';

/**
 * The SessionStart recovery hook, written verbatim into every session config
 * dir. Dependency-free (node builtins only) so it runs under any node on the
 * box, including the WSL-mounted sidecar node on the Windows VM.
 *
 * Why it exists (WI-3278 → WI-3280, owner mandate): claude 2.1.x SELF-RE-EXECs
 * (TUI fullscreen switch / update relaunch — `relaunchInto()` → `vge()` in the
 * bundle) and the relaunch rebuilds argv as `[]` or `--resume <id>` via libc
 * execve — the original launch flags (`--system-prompt-file` playbook,
 * `--permission-mode`, `--session-id`, `--disallowedTools`) are NEVER
 * re-passed, and the binary has NO config-level system-prompt key to bake the
 * playbook into. Permissions survive via settings.json (WI-3278); this hook
 * recovers the PLAYBOOK: on every SessionStart it inspects the live claude
 * process's argv (the flag can only live there — the pty host passes args
 * in-process, never on its own argv) and, when no `*-system-prompt-file` flag
 * survives, injects the parked playbook copy as additionalContext. Silent
 * no-op when argv is intact (zero token cost) or when no playbook was parked.
 * `PSU_RECOVER_TEST_CHAIN` (JSON argv[][]) substitutes the ancestry walk for
 * tests. Errors always exit 0 — a broken hook must never block a session.
 *
 * The SAME hook also delivers the POST-COMPACTION CONTINUITY ANCHOR
 * (compaction-continuity-hardening-2026-07-07 P-004, implements WI-2537): on
 * `SessionStart[source=compact]` it injects (a) a mandate to run
 * `coord:orient { afterCompaction: true }` first, (b) a volatile-claims
 * checklist — liveness/fleet counts, service states, and quantities in the
 * compaction summary are HYPOTHESES to re-verify, never facts — and (c) the
 * session's carry brief fetched LIVE from the operator
 * (`/api/agent-mcp/session-recovery-brief`, P-003's renderCarryBriefText).
 * The static parts (a)+(b) are baked into the hook so they deliver even with
 * the operator down; the fetch is fail-soft with a short abort. A COLD
 * reset/recycle wake gets the same brief via the wake-executor injection
 * (carry-brief consumer iii) — one render path, two boundaries.
 */
export const RECOVER_HOOK_SOURCE = `#!/usr/bin/env node
// session-recover-hook.mjs — WI-3280 argv-proof playbook delivery + P-004
// post-compaction continuity anchor + P-007 identity rebind (generated by
// interactive-claude-config.ts on every session materialize; do not edit).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK = join(dir, ${JSON.stringify(RECOVER_PLAYBOOK)});
const INTENT = join(dir, ${JSON.stringify(RECOVER_INTENT)});
const FLAGS = ['--system-prompt-file', '--append-system-prompt-file'];

function cmdlineOf(pid) {
  try {
    const argv = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\u0000').filter(Boolean);
    if (argv.length) return argv;
  } catch {}
  try {
    // macOS (no /proc). Whitespace-split degrades paths with spaces, but flag
    // TOKENS are whitespace-delimited either way, which is all we test for.
    const line = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (line) return line.split(/\\s+/);
  } catch {}
  return null;
}

function ppidOf(pid) {
  try {
    const m = /^PPid:\\s*(\\d+)/m.exec(readFileSync('/proc/' + pid + '/status', 'utf8'));
    if (m) return Number(m[1]);
  } catch {}
  try {
    const n = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    if (Number.isFinite(n)) return n;
  } catch {}
  return 0;
}

function argvIntact() {
  const chain = [];
  if (process.env.PSU_RECOVER_TEST_CHAIN) {
    try { chain.push(...JSON.parse(process.env.PSU_RECOVER_TEST_CHAIN)); } catch {}
  } else {
    let pid = process.ppid;
    for (let hop = 0; hop < 10 && pid > 1; hop++) {
      const argv = cmdlineOf(pid);
      if (argv) chain.push(argv);
      pid = ppidOf(pid);
    }
  }
  const isClaude = (argv) => (argv[0] ?? '').toLowerCase().includes('claude');
  const hasFlag = (argv) => argv.some((a) => FLAGS.some((f) => a === f || a.startsWith(f + '=')));
  // The nearest claude ancestor decides; if none is identifiable (unusual
  // argv[0], e.g. a bare versioned binary), fall back to any-flag-anywhere.
  const claude = chain.find(isClaude);
  return claude ? hasFlag(claude) : chain.some(hasFlag);
}

// The claude hook input JSON ({ session_id, source, ... }) arrives on stdin.
// Raced against a short timer so a never-closing stdin can't stall the start.
async function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const read = (async () => {
      let data = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) data += chunk;
      return data;
    })();
    const data = await Promise.race([read, new Promise((r) => setTimeout(r, 3000, ''))]);
    return data && data.trim() ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

// WI-3280: the argv-drop playbook recovery — returns the injection text, or
// null when argv is intact / no playbook was parked (the silent no-op).
function playbookRecovery(intent) {
  if (!existsSync(PLAYBOOK)) return null;
  if (argvIntact()) return null;
  const playbook = readFileSync(PLAYBOOK, 'utf8');
  const banner = [
    '⚠ SESSION RECOVERED — your launch system prompt was lost; it is re-delivered below.',
    'This claude process self-relaunched (an internal claude re-exec: TUI fullscreen switch or',
    'update relaunch) and claude rebuilds argv on relaunch WITHOUT the original launch flags:',
    'the --system-prompt-file playbook, --permission-mode, --session-id and any --disallowedTools',
    'were dropped. Permissions were separately restored via this session settings.json. Notes:',
    intent.sid ? '- Your papercusp identity is ' + intent.sid + ' (env PAPERCUSP_SID) — coord/MCP identity is unaffected.' : '- Your coord/MCP identity (env PAPERCUSP_SID) is unaffected.',
    intent.nativeSessionId ? '- Your native claude session id may differ from the recorded one (' + intent.nativeSessionId + ') — psu resume/tracking of this conversation may be degraded; disclose this if coordination looks off.' : '- psu resume/tracking of this conversation may be degraded; disclose this if coordination looks off.',
    '- If the playbook below denies tools (subagents, native schedulers), honor it even though the CLI deny flags were lost.',
    '- The document below IS your operating playbook / system prompt. Follow it in full.',
  ].join('\\n');
  return banner + '\\n\\n' + playbook;
}

// P-004: fetch the session's carry brief (P-003 renderCarryBriefText) from the
// local operator. Fail-soft: null on any failure — the static anchor still lands.
async function fetchCarryBrief(intent) {
  const owner = process.env.PAPERCUSP_SID || intent.sid;
  if (!owner) return null;
  const base = (process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const res = await fetch(base + '/api/agent-mcp/session-recovery-brief?owner=' + encodeURIComponent(owner), { signal: ctl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// P-007: identity durability across relaunch. When the LIVE PAPERCUSP_SID
// differs from the sid recorded at launch, every ownerId-keyed surface (armed
// loop, loop carry-note + walls, claims, claim-spec, standing awaits, fleet
// membership, open held work-items, owner facts) is stranded under the dead
// predecessor id. Auto-rebind via the local operator (idempotent server-side);
// on refusal/failure surface the one-call manual instruction instead. Returns
// { rebound, to, text } or null when identities agree / either id is unknown.
async function rebindIdentityIfChanged(intent) {
  const live = (process.env.PAPERCUSP_SID || '').trim();
  const recorded = ((intent && intent.sid) || '').trim();
  if (!live || !recorded || live === recorded) return null;
  const head = '⚠ IDENTITY CHANGED ACROSS RELAUNCH — recorded PAPERCUSP_SID ' + recorded + ' → live ' + live + '. Your armed loop, loop carry-note (+walls), claims, claim-spec, standing awaits, fleet membership and open held work-items were keyed under the OLD id.';
  const manual = 'Run coord:rebind-identity { from: \\'' + recorded + '\\', to: \\'' + live + '\\' } NOW (add force:true only after coord:presence confirms the old id is dead), then coord:orient { afterCompaction: true }.';
  const base = (process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const res = await fetch(base + '/api/agent-mcp/rebind-identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: recorded, to: live }),
      signal: ctl.signal,
    });
    const body = res.ok ? await res.json() : null;
    if (body && body.ok) {
      const counts = (body.surfaces || [])
        .map((s) => ({ surface: s.surface, n: (s.moved || 0) + (s.dropped || 0) + (s.cancelled || 0) + (s.appended || 0) }))
        .filter((s) => s.n > 0)
        .map((s) => s.surface + ':' + s.n)
        .join(', ');
      return {
        rebound: true,
        to: live,
        text: head + ' AUTO-REBOUND to the live id just now: ' + (counts || 'nothing was keyed under the old id') + '. Verify with coord:orient { afterCompaction: true }.',
      };
    }
    if (body && body.refused === 'from_appears_live') {
      return { rebound: false, to: live, text: head + ' AUTO-REBIND REFUSED — the old id still shows a LIVE presence heartbeat (another session may hold it). If you are certain it is dead: ' + manual };
    }
    return { rebound: false, to: live, text: head + ' Auto-rebind did not complete. ' + manual };
  } catch {
    return { rebound: false, to: live, text: head + ' The operator was unreachable for auto-rebind. ' + manual };
  } finally {
    clearTimeout(timer);
  }
}

// P-004: the post-compaction continuity anchor. The mandate + volatile-claims
// checklist are static (deliver even with the operator down); the carry brief
// is the live part.
async function compactAnchor(intent) {
  const anchor = [
    '⚠ POST-COMPACTION CONTINUITY ANCHOR — injected by the SessionStart[source=compact] hook. Live reads below, not summary prose.',
    // turn-provenance-owner-vs-agent-2026-07-11 P-004: a NATIVE auto-compaction
    // continuation cannot be pre-tagged by any injector (Claude generates it
    // internally), so the compact-source hook is the one place that can stamp it.
    '⟦turn-provenance⟧ MACHINE-GENERATED CONTINUATION — this post-compaction turn (the summary above it and any continuation prompt) was produced by the compaction machinery, NOT typed by the human owner. Never attribute its text to the owner; owner directives must trace to a turn stamped OWNER (interactive) or to the pre-compaction verbatim transcript (sessions:search).',
    'FIRST ACTION: run coord:orient { afterCompaction: true } — its recovery block re-delivers your held work-items\\u2019 checkpoints, armed-loop status, staleness warnings (what changed AFTER your summary was written), and the self-recall pointer.',
    'VOLATILE-CLAIMS CHECKLIST — your compaction summary is a STALE SNAPSHOT of a live system. Treat these summary statements as HYPOTHESES to re-verify, never facts:',
    '- liveness / fleet counts ("N members alive/working") — re-read via coord:presence + fleet:status;',
    '- service up/down states (deploys, ports, restarts, wedged/fixed) — re-probe before acting on them;',
    '- quantities and totals (queue depths, item counts, test counts) — re-measure before repeating them.',
    "Anything the summary dropped is recoverable verbatim: sessions:search { session:'self', mode:'verbatim', query:'<what you remember>' }.",
  ].join('\\n');
  const brief = await fetchCarryBrief(intent);
  return brief
    ? anchor + '\\n\\nYour carry brief (read live from the carry surfaces just now):\\n\\n' + brief
    : anchor;
}

// WI-4275-adjacent (2026-07-12): SELF-HEAL the psu-managed settings.json keys.
// Claude Code's own settings-save (e.g. /model, /effort persisting defaults)
// can REWRITE the session settings.json with only its in-memory keys — wiping
// the statusLine (fleet title goes permanently stale: the "windows desktop
// leader" frozen-title incident), the bypassPermissions grant, AND this very
// hook's SessionStart registration. Re-assert all three, non-destructively
// (merge; never touch foreign values), on every session start. Fail-open: a
// repair hiccup never blocks the start.
function selfHealSettings() {
  try {
    const path = join(dir, 'settings.json');
    if (!existsSync(path)) return null;
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return null;
    const fixed = [];
    // (a) statusLine — copy from the global settings when ours is absent and
    // the global one is the papercusp fleet statusline (never install a
    // foreign/personal statusLine on the user's behalf).
    if (!cfg.statusLine) {
      try {
        const home = process.env.HOME || '';
        const g = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
        if (g && g.statusLine && String(g.statusLine.command || '').includes('statusline-fleet.sh')) {
          cfg.statusLine = g.statusLine;
          fixed.push('statusLine');
        }
      } catch {}
    }
    // (b) the bypassPermissions grant this session type was materialized with.
    const perms = cfg.permissions && typeof cfg.permissions === 'object' ? cfg.permissions : {};
    if (perms.defaultMode !== 'bypassPermissions') {
      cfg.permissions = Object.assign({}, perms, { defaultMode: 'bypassPermissions' });
      fixed.push('permissions.defaultMode');
    }
    // (c) this hook's own SessionStart registration (without it, the next
    // relaunch loses playbook recovery AND this self-heal).
    const hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
    const groups = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const registered = JSON.stringify(groups).includes('session-recover-hook.mjs');
    if (!registered) {
      groups.push({
        hooks: [
          {
            type: 'command',
            command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(dir, 'session-recover-hook.mjs')),
            timeout: 30,
          },
        ],
      });
      hooks.SessionStart = groups;
      cfg.hooks = hooks;
      fixed.push('hooks.SessionStart');
    }
    if (!fixed.length) return null;
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return fixed;
  } catch {
    return null;
  }
}

// Same rewrite-damage class, second victim: claude's .claude.json rewrites can
// drop the session's papercusp-su MCP server definition — the session then runs
// with NO coordination tools until someone notices (2026-07-12: hours of
// checkpoints/completions queued behind a "disconnected MCP" that was really a
// missing config entry). Re-assert it from the global ~/.claude.json when the
// session copy lacks it. Non-destructive; fail-open.
function selfHealMcpConfig() {
  try {
    const path = join(dir, '.claude.json');
    if (!existsSync(path)) return null;
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    if (!cfg || typeof cfg !== 'object') return null;
    const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    if (servers['papercusp-su']) return null;
    const home = process.env.HOME || '';
    const g = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const src = g && g.mcpServers ? g.mcpServers['papercusp-su'] : null;
    if (!src) return null;
    servers['papercusp-su'] = src;
    cfg.mcpServers = servers;
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    return ['mcpServers.papercusp-su'];
  } catch {
    return null;
  }
}

try {
  const input = await readStdinJson();
  let intent = {};
  try { intent = JSON.parse(readFileSync(INTENT, 'utf8')); } catch {}
  const parts = [];
  try { selfHealSettings(); } catch {}
  try { selfHealMcpConfig(); } catch {}
  try {
    const p = playbookRecovery(intent);
    if (p) parts.push(p);
  } catch {}
  try {
    const rb = await rebindIdentityIfChanged(intent);
    if (rb) {
      parts.push(rb.text);
      // A successful rebind retires the old sid: rewrite the parked intent so
      // subsequent SessionStarts don't re-fire (the rebind itself is idempotent).
      if (rb.rebound) {
        try { writeFileSync(INTENT, JSON.stringify({ ...intent, sid: rb.to }, null, 2), { mode: 0o600 }); } catch {}
      }
    }
  } catch {}
  if ((input.source || '') === 'compact') {
    try {
      const a = await compactAnchor(intent);
      if (a) parts.push(a);
    } catch {}
  }
  if (parts.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join('\\n\\n'),
      },
    }));
  }
  process.exit(0);
} catch {
  process.exit(0); // never block a session start
}
`;

/**
 * WI-3280: park the launch playbook + intent metadata in the config dir, and
 * (re)write the recovery hook script itself. The hook + settings entry are
 * written on EVERY materialize (inert without a parked playbook); the playbook
 * copy is written only when the caller supplies one — a resume-path
 * re-materialize without `recovery` deliberately KEEPS the original launch's
 * parked copy, so late re-execs (and raw `claude` launches in this config dir)
 * still recover the correct playbook. Best-effort throughout: a failed write
 * degrades to today's behavior (argv-only delivery), never a failed launch.
 */
function writeRecoveryArtifacts(
  configDir: string,
  recovery?: { playbookPath?: string | null; nativeSessionId?: string | null; sid?: string },
): void {
  try {
    writeFileSync(join(configDir, RECOVER_HOOK), RECOVER_HOOK_SOURCE, { mode: 0o700 });
  } catch {
    /* hook unwritable — argv delivery still stands */
  }
  if (!recovery?.playbookPath) return;
  try {
    const playbook = readFileSync(recovery.playbookPath, 'utf8');
    writeFileSync(join(configDir, RECOVER_PLAYBOOK), playbook, { mode: 0o600 });
    writeFileSync(
      join(configDir, RECOVER_INTENT),
      JSON.stringify(
        {
          sid: recovery.sid ?? null,
          nativeSessionId: recovery.nativeSessionId ?? null,
          playbookPath: recovery.playbookPath,
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch {
    /* unreadable playbook — nothing to park; the hook stays inert */
  }
}

/**
 * ASSERT `hasCompletedOnboarding` in the global `~/.claude.json` before the
 * mirror symlinks it in. The mirror's whole premise (see the header note on the
 * onboarding/trust state) is that this file says onboarding is DONE — but it
 * only ever *assumed* that, and the flag is not stable:
 *
 * - When it reads `false`, claude boots into its first-run wizard (theme
 *   picker). A psu session then NEVER reaches a prompt, so the kickoff turn can
 *   never be delivered and the agent is dead on arrival — with no error, just a
 *   terminal parked on a menu forever. It breaks EVERY interactive psu launch
 *   (`capability:launch-agent`, `capability:terminal`, `fleet:launch-on-plan`,
 *   and every resume), not one caller.
 * - And it SELF-PROPAGATES: the session's `.claude.json` is a write-through
 *   SYMLINK, so a session wedged in that wizard writes its own
 *   not-yet-onboarded state straight back to the global file — one wedged
 *   session re-arms the trap for every launch that follows.
 *
 * Live-caught 2026-07-12 by the launch-agent live-verify: the flag had flipped
 * to `false` and killed the probe on boot, while every backup of the file going
 * back months has it `true`. So assert it here instead of assuming it — the
 * same self-heal shape `selfHealSettings` / `selfHealMcpConfig` already apply to
 * the other two files claude rewrites out from under us.
 *
 * Touches ONLY this key (never a foreign value); atomic (temp + rename — peers
 * rewrite this file constantly); idempotent (no write once true); fail-open (a
 * launch must never die on a repair hiccup). Note `theme` is deliberately NOT
 * seeded: the working backups have no theme key either, so it is not what gates
 * the wizard.
 */
export function ensureOnboardingComplete(home: string): boolean {
  const path = join(home, '.claude.json');
  try {
    if (!existsSync(path)) return false;
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!cfg || typeof cfg !== 'object' || cfg.hasCompletedOnboarding === true) return false;
    cfg.hasCompletedOnboarding = true;
    const tmp = `${path}.psu-onboarding.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false; // a wizard-blocked session is louder than a failed repair
  }
}

/** True if a path already exists as a real file/dir OR as a (possibly dangling)
 *  symlink — `existsSync` returns false for a dangling link, but on resume we
 *  must still treat an existing link as "leave it". */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function linkInto(src: string, dest: string): void {
  if (present(dest)) return; // idempotent — a resume re-materialize must not double-link
  try {
    symlinkSync(src, dest);
  } catch {
    /* best-effort — claude surfaces a missing entry the same as a fresh user */
  }
}

/**
 * Build (or re-ensure, idempotently) the per-session interactive
 * `CLAUDE_CONFIG_DIR` for `sid` and return its path. The caller exports it as
 * `CLAUDE_CONFIG_DIR` on the claude child's env.
 *
 * `home` is the source environment (defaults to `homedir()`); the user's
 * `<home>/.claude/*` + `<home>/.claude.json` are mirrored from there. A box with
 * no `~/.claude` yet simply yields a dir with a fresh `projects/` (the session
 * runs as a first-run user would) — never throws.
 */
export function writeInteractiveClaudeConfig(opts: {
  /** Per-session coord-owner id (`PAPERCUSP_SID`). Keys the dir via the shared
   *  helper, so launch and the wake-executor resume leg resolve the same path. */
  sid: string;
  /** Source HOME (testability); defaults to the process home. */
  home?: string;
  /**
   * context-trimming-tiers P-020: prune the heavy plugin/MCP surface for a
   * FLEET-tier member — `plugins/installed_plugins.json` is materialized as a
   * FILTERED real file (github/cloudflare/firecrawl dropped; context7 etc.
   * kept) and `.claude.json` as a filtered real copy (the playwright
   * mcpServer dropped; papercusp-su kept). Costs those two files their
   * write-passthrough — fine for a spawned member; default off (symlinks,
   * byte-identical to today).
   */
  prunePlugins?: boolean;
  /**
   * WI-3280 (argv-proof playbook delivery): the launch playbook to PARK in the
   * config dir so the SessionStart recovery hook can re-deliver it when
   * claude's self-re-exec drops the argv (`--system-prompt-file` and all).
   * Omit on resume-path re-materializes — the original launch's parked copy is
   * kept. `nativeSessionId` is surfaced in the recovery banner so a recovered
   * session can disclose its degraded psu tracking.
   */
  recovery?: { playbookPath?: string | null; nativeSessionId?: string | null };
}): InteractiveClaudeConfig {
  const home = opts.home ?? homedir();
  const configDir = sessionClaudeConfigDir(opts.sid);
  mkdirSync(configDir, { recursive: true });

  // Seed-from-newest: converge the global file (and any forks) on the newest
  // OAuth bundle BEFORE mirroring, so the `.credentials.json` symlink below
  // points at a live token even when a peer session rotated it last.
  // Best-effort — a launch must never fail on credential reconciliation.
  // Skipped under vitest (same pattern as testing-run-store.ts): the bootstrap
  // route tests reach this with the REAL home + session root, and a unit test
  // must never rewrite the user's live credential files. The reconcile logic
  // has its own isolated tests in claude-credential-sync.test.ts.
  if (!process.env.VITEST) {
    try {
      // Ensure the global ~/.claude exists BEFORE reconciling. The credential
      // sync only PROMOTES a session-fork login to the global `.credentials.
      // json` when ~/.claude already exists (it deliberately won't materialize
      // the dir from its watcher path). On a FRESH box with no ~/.claude, a
      // `claude /login` done INSIDE a psu session writes a real `.credentials.
      // json` into the SESSION dir — and without this it is stranded there: the
      // next psu session gets a fresh dir whose `.credentials.json` symlink
      // dangles, so psu "launches logged out" even though the user logged in
      // once. Creating ~/.claude here lets reconcile lift that fork to the
      // global, so EVERY later psu session (default account) inherits the single
      // CLI login — on a fresh box too. Idempotent; an API-key-only box just
      // gets an empty dir claude would have created on first global use anyway.
      // (psu-login-inherit: fresh-box credential promotion.)
      mkdirSync(join(home, '.claude'), { recursive: true });
      reconcileClaudeCredentials({ home });
    } catch {
      /* claude surfaces a stale credential the same as before this existed */
    }
    // Same "claude rewrote a file we depend on" class as the credential fork
    // above: repair the onboarding flag the mirror is about to symlink in, or
    // this session boots into the first-run wizard and never reaches a prompt.
    ensureOnboardingComplete(home);
  }

  // Mirror every top-level `~/.claude` entry EXCEPT the transcript store.
  const srcClaude = join(home, '.claude');
  let entries: string[] = [];
  try {
    entries = readdirSync(srcClaude); // includes dotfiles (.credentials.json, …)
  } catch {
    /* no ~/.claude on this box — fall through to a fresh projects/ only */
  }
  for (const name of entries) {
    if (name === ISOLATED_ENTRY) continue;
    // psu-isolation P-002 / D-001: never mirror the user's personal global
    // memory — a psu session is steered only by the psu playbook + the P-001
    // project-guide splice, not the launching user's CLAUDE.md/AGENTS.md.
    if (PERSONAL_MEMORY_ENTRIES.has(name)) continue;
    // P-020 fleet plugin prune: `plugins` becomes a REAL dir whose children
    // symlink through, except installed_plugins.json which is a filtered copy.
    if (opts.prunePlugins && name === 'plugins') {
      writePrunedPluginsDir(join(srcClaude, name), join(configDir, name));
      continue;
    }
    // WI-3278: settings.json is a REAL merged copy with the bypassPermissions
    // grant baked in — see writeSessionSettings.
    if (name === 'settings.json') {
      writeSessionSettings(join(srcClaude, name), join(configDir, name));
      continue;
    }
    linkInto(join(srcClaude, name), join(configDir, name));
  }
  // WI-3278: a box with no global settings.json (the fresh Windows VM) still
  // needs the session-level bypass grant.
  if (!entries.includes('settings.json')) {
    writeSessionSettings(null, join(configDir, 'settings.json'));
  }

  // WI-3280: the SessionStart recovery hook (always) + the parked playbook
  // copy (when the caller supplies one) — see writeRecoveryArtifacts.
  writeRecoveryArtifacts(configDir, { ...opts.recovery, sid: opts.sid });

  // The isolated conversation-transcript store — a REAL dir, never a symlink, so
  // `/resume` + `claude --resume <uuid>` see only this session's transcripts.
  // mkdir is idempotent and never clobbers an existing (resumed) transcript.
  mkdirSync(join(configDir, ISOLATED_ENTRY), { recursive: true });

  // The sibling `~/.claude.json` also relocates under CLAUDE_CONFIG_DIR on
  // current claude — symlink it so the session keeps the user-level MCP servers
  // (claude's `papercusp-su` lives here), onboarding-complete + per-project trust
  // (no re-onboarding), theme, and MCP approvals. Writes pass through to the real
  // file, exactly as a non-isolated session shares it today.
  const srcJson = join(home, '.claude.json');
  if (existsSync(srcJson)) {
    if (opts.prunePlugins) {
      // P-020: a filtered REAL copy — the playwright mcpServer dropped
      // (papercusp-su + everything else kept verbatim).
      writePrunedClaudeJson(srcJson, join(configDir, '.claude.json'));
    } else {
      linkInto(srcJson, join(configDir, '.claude.json'));
    }
  }

  return { configDir };
}

/**
 * WI-3278: the session's `settings.json` is a REAL MERGED COPY of the user's
 * global settings with `permissions.defaultMode = 'bypassPermissions'` baked in
 * — NOT a symlink. psu grants a session its dangerous permissions via CLI argv
 * (`--permission-mode bypassPermissions` + `--dangerously-skip-permissions`),
 * but claude 2.1.20x can SELF-RE-EXEC (TUI fullscreen switch / update relaunch,
 * seen live on the Windows VM 2026-07-06: /proc showed a bare argv-less claude
 * under CLAUDE_CODE_TUI_JUST_SWITCHED=fullscreen while the psu-pty meta held
 * the full intended argv) and the re-exec DROPS the argv — the session reboots
 * in default mode and prompts for every papercusp-su call, with no playbook.
 * Settings are re-read from CLAUDE_CONFIG_DIR on every (re)boot, so the grant
 * survives here; the argv flags stay as the launch-time fast path. Costs this
 * file its write-passthrough: global hook edits reach the NEXT launch's merge,
 * not a live session — acceptable, the dir is re-materialized per launch.
 * Rewritten (not `present()`-skipped) on every materialize so resumes pick up
 * fresh global hooks; a pre-fix dir's SYMLINK is removed first so the write
 * lands in the session dir, never through the link into the user's real file.
 */
function writeSessionSettings(srcSettings: string | null, dest: string): void {
  let cfg: Record<string, unknown> = {};
  if (srcSettings) {
    try {
      cfg = JSON.parse(readFileSync(srcSettings, 'utf8')) as Record<string, unknown>;
    } catch {
      /* no/unparseable global settings — write the grant alone */
    }
  }
  const permissions = {
    ...(cfg.permissions as Record<string, unknown> | undefined),
    defaultMode: 'bypassPermissions',
  };
  // WI-3280: register the argv-drop recovery hook on SessionStart. APPENDED to
  // (never replacing) the user's global hook groups, and rebuilt from the
  // global file on every materialize, so it can't accumulate duplicates. The
  // node running the operator is the node the hook runs under (exists on every
  // box that can mint a session — the WSL-mounted sidecar node on the VM);
  // JSON.stringify-quoting keeps space-containing paths shell-safe.
  const hooks = { ...(cfg.hooks as Record<string, unknown> | undefined) };
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as unknown[])] : [];
  sessionStart.push({
    hooks: [
      {
        type: 'command',
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(dirname(dest), RECOVER_HOOK))}`,
        timeout: 30,
      },
    ],
  });
  hooks.SessionStart = sessionStart;
  try {
    if (present(dest) && lstatSync(dest).isSymbolicLink()) rmSync(dest);
    writeFileSync(dest, JSON.stringify({ ...cfg, permissions, hooks }, null, 2));
  } catch {
    /* best-effort — argv still carries the grant on a non-re-exec launch */
  }
}

/** P-020: mirror `~/.claude/plugins` as a real dir — every child symlinked
 *  through except `installed_plugins.json`, which is written as a FILTERED
 *  real copy (FLEET_PRUNED_PLUGIN_NAMES dropped). Best-effort: any failure
 *  falls back to the plain symlink (a full plugin surface, never a broken one). */
function writePrunedPluginsDir(srcPlugins: string, destPlugins: string): void {
  if (present(destPlugins)) return; // idempotent (resume)
  try {
    mkdirSync(destPlugins, { recursive: true });
    for (const child of readdirSync(srcPlugins)) {
      if (child === 'installed_plugins.json') continue;
      linkInto(join(srcPlugins, child), join(destPlugins, child));
    }
    const regPath = join(srcPlugins, 'installed_plugins.json');
    if (existsSync(regPath)) {
      const reg = JSON.parse(readFileSync(regPath, 'utf8')) as {
        plugins?: Record<string, unknown>;
      };
      if (reg.plugins && typeof reg.plugins === 'object') {
        reg.plugins = Object.fromEntries(
          Object.entries(reg.plugins).filter(([key]) => {
            const name = key.split('@')[0] ?? key;
            return !FLEET_PRUNED_PLUGIN_NAMES.has(name);
          }),
        );
      }
      writeFileSync(join(destPlugins, 'installed_plugins.json'), JSON.stringify(reg, null, 1));
    }
  } catch {
    // Fall back to the full symlink — never a broken plugins dir.
    try {
      rmSync(destPlugins, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    linkInto(srcPlugins, destPlugins);
  }
}

/** P-020: write a filtered real copy of `~/.claude.json` with the pruned
 *  mcpServers removed. Best-effort: any failure falls back to the symlink. */
function writePrunedClaudeJson(srcJson: string, destJson: string): void {
  if (present(destJson)) return; // idempotent (resume)
  try {
    const j = JSON.parse(readFileSync(srcJson, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    if (j.mcpServers && typeof j.mcpServers === 'object') {
      j.mcpServers = Object.fromEntries(
        Object.entries(j.mcpServers).filter(([name]) => !FLEET_PRUNED_MCP_SERVERS.has(name)),
      );
    }
    writeFileSync(destJson, JSON.stringify(j, null, 1));
  } catch {
    linkInto(srcJson, destJson);
  }
}
