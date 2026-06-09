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
 * exactly ONE thing isolated: the conversation transcript store, `projects/`.
 * Every other top-level entry — `.credentials.json`, `settings.json`, `plugins/`,
 * `commands/`, … — is symlinked back to the real `~/.claude/<entry>` (writes pass
 * through, so an OAuth refresh / settings change is never divergent), the sibling
 * `~/.claude.json` is symlinked in, and `projects/` is a fresh real directory.
 * The session is byte-for-byte the user's environment, but its transcripts land
 * under `<configDir>/projects/**` instead of the shared `~/.claude/projects/**`.
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
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';

export interface InteractiveClaudeConfig {
  /** Absolute path to set as the interactive session's `CLAUDE_CONFIG_DIR`. */
  configDir: string;
}

/** Top-level `~/.claude` entry that gets a fresh real dir (NOT a symlink) so the
 *  session's conversation transcripts are isolated from the shared store. */
const ISOLATED_ENTRY = 'projects';

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
}): InteractiveClaudeConfig {
  const home = opts.home ?? homedir();
  const configDir = sessionClaudeConfigDir(opts.sid);
  mkdirSync(configDir, { recursive: true });

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
    linkInto(join(srcClaude, name), join(configDir, name));
  }

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
  if (existsSync(srcJson)) linkInto(srcJson, join(configDir, '.claude.json'));

  return { configDir };
}
