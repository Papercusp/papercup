/**
 * session-config-integrity.ts — WI-4562.
 *
 * Claude Code persists its OWN config (/model, /effort, theme, the dangerous-mode
 * prompt) by REWRITING the session's `settings.json` from its in-memory keys — and
 * the rewrite drops every key it does not own. The same class of rewrite drops
 * `mcpServers` from the session's `.claude.json`. A psu session therefore silently
 * loses, mid-flight and permanently for the life of the process:
 *
 *   - PreToolUse  pretooluse-locks-acquire.sh   → edits on the FLEET-SHARED tree take NO lock
 *   - PostToolUse posttooluse-coord-inbox.sh    → directed peer messages are never delivered
 *   - UserPromptSubmit userpromptsubmit-memory.sh     → no turn-start memory recall
 *   - UserPromptSubmit userpromptsubmit-provenance.sh → no owner-vs-agent turn-provenance stamps
 *   - SessionStart (the recover hook)           → no post-compaction epoch bump, so the dedup
 *                                                 ledger keeps SUPPRESSING memories for a context
 *                                                 that no longer contains them (re-prime dead)
 *   - mcpServers['papercusp-su']                → the coordination MCP is simply gone
 *
 * WHY THIS MODULE EXISTS RATHER THAN A SELF-HEAL IN THE HOOK. Two self-heals already
 * existed (selfHealSettings / selfHealMcpConfig in interactive-claude-config.ts) and
 * repaired exactly this — but they are invoked from INSIDE the generated SessionStart
 * hook, and the damage they repair INCLUDES the deletion of that hook's own
 * registration. Once `hooks` is wiped the hook never fires again, so neither self-heal
 * can ever run: a self-heal that requires the thing it heals to be alive. It cannot be
 * fixed in place; the detector has to live somewhere that does not depend on hooks.
 * That is the operator (see coord:orient's `configIntegrity` block).
 *
 * WHAT A REPAIR ACTUALLY DOES — measured, not assumed. I first wrote that hooks are read
 * only at startup and so could not be restored in-process. That was WRONG, and the live
 * repair disproved it: rewriting settings.json re-registered the hooks for the RUNNING
 * session, and su-5d6764f9's coord inbox immediately delivered a 40+ message backlog that
 * had been silently dropped for 27h. So a repair heals the live session, not just its
 * next boot. Two things it cannot undo: a SessionStart that already passed never fires
 * again (compactions that already happened never got their memory epoch bump, so their
 * dedup ledger stays un-re-primed), and the MCP server entry is bound at connect time, so
 * papercusp-su may need a reconnect.
 *
 * The DETECTION half is still the load-bearing one: the failure is silent and
 * self-latching, and an agent that does not know it is running without edit locks, without
 * an inbox, and without recall cannot act on any of it. Silence is the actual bug.
 *
 * The global ~/.claude/settings.json is the canonical hook block (writeSessionSettings
 * copies it in at materialize). We diff the session against it rather than hard-coding a
 * hook list — a hand-copied list is exactly what rotted in EI-10793.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The psu-owned MCP server. `playwright` is deliberately NOT restored (P-020 prunes it). */
export const PSU_MCP_SERVER = 'papercusp-su';

export interface SessionConfigState {
  /** The session's CLAUDE_CONFIG_DIR settings.json (null = unreadable/absent). */
  settings: Record<string, unknown> | null;
  /** The session's .claude.json (null = unreadable/absent). */
  claudeJson: Record<string, unknown> | null;
  /** The user's global ~/.claude/settings.json — the canonical hook block. */
  globalSettings: Record<string, unknown> | null;
  /** The user's global ~/.claude.json — the canonical MCP server definitions. */
  globalClaudeJson: Record<string, unknown> | null;
}

export interface ConfigIntegrityVerdict {
  /** True when nothing psu-owned is missing. */
  ok: boolean;
  /** Hook events present in the global block but MISSING from the session (e.g. ['PreToolUse']). */
  missingHookEvents: string[];
  /** The papercusp-su MCP server is absent from the session's .claude.json. */
  mcpServerMissing: boolean;
  /** permissions.defaultMode is no longer the bypassPermissions grant psu materialized with. */
  permissionsDowngraded: boolean;
  /** Plain-language consequences, ordered worst-first — what is ACTUALLY broken right now. */
  consequences: string[];
}

type HookMap = Record<string, unknown>;

function hooksOf(cfg: Record<string, unknown> | null): HookMap {
  const h = cfg && typeof cfg.hooks === 'object' && cfg.hooks ? (cfg.hooks as HookMap) : {};
  return h;
}

/** A hook event counts as PRESENT only if it carries at least one group (an empty array is a wipe). */
function hasHookEvent(hooks: HookMap, event: string): boolean {
  const groups = hooks[event];
  return Array.isArray(groups) && groups.length > 0;
}

/**
 * Which psu-owned pieces of a session's config have been wiped by a Claude Code
 * config rewrite. Pure — the caller supplies the four documents.
 *
 * A session whose GLOBAL settings carry no hooks at all is reported ok: there is no
 * canonical block to be missing, and we must never invent one.
 */
export function checkSessionConfigIntegrity(state: SessionConfigState): ConfigIntegrityVerdict {
  const globalHooks = hooksOf(state.globalSettings);
  const sessionHooks = hooksOf(state.settings);

  const missingHookEvents = Object.keys(globalHooks)
    .filter((event) => hasHookEvent(globalHooks, event))
    .filter((event) => !hasHookEvent(sessionHooks, event))
    .sort();

  const globalServers =
    state.globalClaudeJson && typeof state.globalClaudeJson.mcpServers === 'object'
      ? ((state.globalClaudeJson.mcpServers as Record<string, unknown>) ?? {})
      : {};
  const sessionServers =
    state.claudeJson && typeof state.claudeJson.mcpServers === 'object'
      ? ((state.claudeJson.mcpServers as Record<string, unknown>) ?? {})
      : {};
  // Only a concern when the global actually defines it — otherwise there is nothing to restore.
  const mcpServerMissing = Boolean(globalServers[PSU_MCP_SERVER]) && !sessionServers[PSU_MCP_SERVER];

  const perms =
    state.settings && typeof state.settings.permissions === 'object'
      ? ((state.settings.permissions as Record<string, unknown>) ?? {})
      : {};
  const permissionsDowngraded = state.settings !== null && perms.defaultMode !== 'bypassPermissions';

  const consequences: string[] = [];
  // Worst first: the shared-tree lock is a DATA-LOSS hazard, not an inconvenience.
  if (missingHookEvents.includes('PreToolUse')) {
    consequences.push(
      'NO EDIT LOCKS: pretooluse-locks-acquire.sh is not registered, so your Edit/Write calls take no lock on a tree the whole fleet edits concurrently. Treat every edit as unprotected.',
    );
  }
  if (missingHookEvents.includes('PostToolUse')) {
    consequences.push(
      'NO COORD INBOX: directed peer messages are not being delivered to you. Poll them explicitly (coord:orient / coord:inbox) — do not assume silence means nobody wrote.',
    );
  }
  if (missingHookEvents.includes('UserPromptSubmit')) {
    consequences.push(
      'NO TURN-START RECALL + NO TURN-PROVENANCE: memories are not injected at turn start, and turns carry no OWNER-vs-AGENT provenance stamp (so a claimed owner directive cannot be mechanically verified).',
    );
  }
  if (missingHookEvents.includes('SessionStart')) {
    consequences.push(
      'NO POST-COMPACTION RE-PRIME: the session epoch never bumps, so the dedup ledger keeps SUPPRESSING memories already marked surfaced — for a context that no longer contains them. Recall is silently dead across compactions.',
    );
  }
  if (mcpServerMissing) {
    consequences.push(
      `NO COORDINATION MCP: mcpServers['${PSU_MCP_SERVER}'] is missing from this session's .claude.json — papercusp-su tools are unavailable in-process.`,
    );
  }
  if (permissionsDowngraded) {
    consequences.push('PERMISSIONS DOWNGRADED: the bypassPermissions grant this session was materialized with is gone.');
  }

  return {
    ok: missingHookEvents.length === 0 && !mcpServerMissing && !permissionsDowngraded,
    missingHookEvents,
    mcpServerMissing,
    permissionsDowngraded,
    consequences,
  };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Load the four documents for a psu session id from disk. Fail-soft: an unreadable
 * document reads as null, and `checkSessionConfigIntegrity` treats a null session
 * settings as "nothing to compare" rather than inventing a wipe.
 *
 * The session's CLAUDE_CONFIG_DIR is ~/.papercusp/session-claude/<ownerId>/ (see
 * interactive-claude-config.ts).
 */
export function loadSessionConfigState(ownerId: string, home = homedir()): SessionConfigState {
  const dir = join(home, '.papercusp', 'session-claude', ownerId);
  return {
    settings: readJson(join(dir, 'settings.json')),
    claudeJson: readJson(join(dir, '.claude.json')),
    globalSettings: readJson(join(home, '.claude', 'settings.json')),
    globalClaudeJson: readJson(join(home, '.claude.json')),
  };
}

export interface SessionConfigRepair {
  /** The repaired settings.json, or null when no change is needed. */
  settings: Record<string, unknown> | null;
  /** The repaired .claude.json, or null when no change is needed. */
  claudeJson: Record<string, unknown> | null;
  /** What was restored, e.g. ['hooks.PreToolUse', 'mcpServers.papercusp-su']. */
  fixed: string[];
}

/**
 * Compute the non-destructive repair: re-merge the psu-owned keys from the global
 * documents, PRESERVING every foreign key (model, theme, effortLevel, … — the keys
 * Claude Code legitimately owns). Pure; the caller writes the files.
 *
 * Restores the FULL canonical hook block, not just the SessionStart entry the old
 * in-hook self-heal knew about — a partial restore leaves the locks/inbox/memory hooks
 * dead while looking repaired.
 */
export function computeSessionConfigRepair(state: SessionConfigState): SessionConfigRepair {
  const verdict = checkSessionConfigIntegrity(state);
  if (verdict.ok) return { settings: null, claudeJson: null, fixed: [] };

  const fixed: string[] = [];
  let settings: Record<string, unknown> | null = null;
  let claudeJson: Record<string, unknown> | null = null;

  if (state.settings && (verdict.missingHookEvents.length > 0 || verdict.permissionsDowngraded)) {
    const globalHooks = hooksOf(state.globalSettings);
    const nextHooks: HookMap = { ...hooksOf(state.settings) };
    for (const event of verdict.missingHookEvents) {
      nextHooks[event] = globalHooks[event];
      fixed.push(`hooks.${event}`);
    }
    settings = { ...state.settings };
    if (verdict.missingHookEvents.length > 0) settings.hooks = nextHooks;
    if (verdict.permissionsDowngraded) {
      const perms =
        typeof state.settings.permissions === 'object' && state.settings.permissions
          ? (state.settings.permissions as Record<string, unknown>)
          : {};
      settings.permissions = { ...perms, defaultMode: 'bypassPermissions' };
      fixed.push('permissions.defaultMode');
    }
    // enableAllProjectMcpServers / statusLine are psu-materialized too; restore from
    // global only when the global HAS them (never invent a foreign statusLine).
    const g = state.globalSettings;
    if (g && settings.enableAllProjectMcpServers === undefined && g.enableAllProjectMcpServers !== undefined) {
      settings.enableAllProjectMcpServers = g.enableAllProjectMcpServers;
      fixed.push('enableAllProjectMcpServers');
    }
    if (g && settings.statusLine === undefined && g.statusLine !== undefined) {
      settings.statusLine = g.statusLine;
      fixed.push('statusLine');
    }
  }

  if (state.claudeJson && verdict.mcpServerMissing) {
    const globalServers = (state.globalClaudeJson?.mcpServers ?? {}) as Record<string, unknown>;
    const sessionServers =
      typeof state.claudeJson.mcpServers === 'object' && state.claudeJson.mcpServers
        ? (state.claudeJson.mcpServers as Record<string, unknown>)
        : {};
    claudeJson = {
      ...state.claudeJson,
      // ONLY the psu server — never re-add `playwright`, which P-020 prunes on purpose.
      mcpServers: { ...sessionServers, [PSU_MCP_SERVER]: globalServers[PSU_MCP_SERVER] },
    };
    fixed.push(`mcpServers.${PSU_MCP_SERVER}`);
  }

  return { settings, claudeJson, fixed };
}
