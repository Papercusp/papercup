/**
 * psu-claude-overlay — the Claude configuration Papercusp adds to a psu session,
 * kept in Papercusp's own home and applied ONLY to the per-session
 * CLAUDE_CONFIG_DIR psu materializes (interactive-claude-config.ts).
 *
 * Papercusp used to register these in the user's own Claude config: the
 * `papercusp-su` MCP server in `~/.claude.json`, the hooks / plugin enrollment /
 * fleet statusLine in `~/.claude/settings.json`, and a compaction import in
 * `~/.claude/CLAUDE.md`. Every plain `claude` on the machine then loaded the whole
 * Papercusp tool catalog (~1,000 tools) and ran its hooks, psu or not. Now:
 *
 *   <home>/.papercusp/claude-mcp.json       { "mcpServers": { "papercusp-su": <template> } }
 *   <home>/.papercusp/claude-settings.json  { hooks, enabledPlugins, extraKnownMarketplaces,
 *                                             statusLine, enableAllProjectMcpServers }
 *
 * The installers write these two files; psu merges them into the session's own
 * `.claude.json` and `settings.json` copies. The user's `~/.claude.json`,
 * `~/.claude/settings.json` and `~/.claude/CLAUDE.md` are never written, and
 * `stripLegacyPsuClaudeJson` / `stripLegacyPsuClaudeSettings` remove what earlier
 * installs left there.
 *
 * Plain .mjs (node builtins + plugin-rails.mjs only), so psu-launcher.mjs, the
 * operator-core TS and the bash installer's helpers share one implementation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PAPERCUSP_CLAUDE_MARKETPLACE_NAME, PAPERCUSP_CLAUDE_PLUGIN_ID } from './claude-plugin/plugin-rails.mjs';

export const PSU_CLAUDE_MCP_SERVER = 'papercusp-su';
export const PSU_CLAUDE_MCP_TEMPLATE_FILE = 'claude-mcp.json';
export const PSU_CLAUDE_SETTINGS_OVERLAY_FILE = 'claude-settings.json';

export function psuClaudeMcpTemplatePath(home) {
  return join(home, '.papercusp', PSU_CLAUDE_MCP_TEMPLATE_FILE);
}

export function psuClaudeSettingsOverlayPath(home) {
  return join(home, '.papercusp', PSU_CLAUDE_SETTINGS_OVERLAY_FILE);
}

function readJsonObject(path) {
  try {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function readJsonObjectAsync(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function mcpEntryOf(doc) {
  const entry = doc?.mcpServers?.[PSU_CLAUDE_MCP_SERVER];
  return entry && typeof entry === 'object' && typeof entry.url === 'string' ? entry : null;
}

/** The installed `papercusp-su` entry (unresolved `${VAR}` template), or null. */
export function readPsuClaudeMcpEntry(home) {
  return mcpEntryOf(readJsonObject(psuClaudeMcpTemplatePath(home)));
}

/** Async twin of readPsuClaudeMcpEntry, for the operator's launch/resume paths. */
export async function readPsuClaudeMcpEntryAsync(home) {
  return mcpEntryOf(await readJsonObjectAsync(psuClaudeMcpTemplatePath(home)));
}

/** The installed psu settings overlay, or null when none is installed. */
export function readPsuClaudeSettingsOverlay(home) {
  return readJsonObject(psuClaudeSettingsOverlayPath(home));
}

/** Async twin of readPsuClaudeSettingsOverlay, for the operator's launch/resume paths. */
export async function readPsuClaudeSettingsOverlayAsync(home) {
  return readJsonObjectAsync(psuClaudeSettingsOverlayPath(home));
}

function commandsOf(group) {
  return Array.isArray(group?.hooks)
    ? group.hooks.map((h) => (h && typeof h.command === 'string' ? h.command : null)).filter(Boolean)
    : [];
}

/**
 * Merge the psu overlay into a settings object (returns a new object; inputs are
 * not mutated). Hook groups are appended per event after dropping any existing
 * command the overlay carries, so re-applying never duplicates a hook. Plugin and
 * marketplace maps are merged key by key. `statusLine` is set only when the base
 * has none or already has ours, the same rule the old user-level merge used.
 */
export function applyPsuClaudeSettingsOverlay(base, overlay) {
  const cfg = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  if (!overlay || typeof overlay !== 'object') return cfg;
  const { hooks: overlayHooks, enabledPlugins, extraKnownMarketplaces, statusLine, ...rest } = overlay;

  if (overlayHooks && typeof overlayHooks === 'object') {
    const hooks = cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? { ...cfg.hooks } : {};
    for (const [event, groups] of Object.entries(overlayHooks)) {
      if (!Array.isArray(groups) || groups.length === 0) continue;
      const ours = new Set(groups.flatMap(commandsOf));
      const kept = (Array.isArray(hooks[event]) ? hooks[event] : [])
        .map((group) => {
          if (!group || !Array.isArray(group.hooks)) return group;
          const left = group.hooks.filter((h) => !(h && ours.has(h.command)));
          return left.length === group.hooks.length ? group : left.length ? { ...group, hooks: left } : null;
        })
        .filter(Boolean);
      hooks[event] = [...kept, ...groups];
    }
    cfg.hooks = hooks;
  }
  if (enabledPlugins && typeof enabledPlugins === 'object') {
    cfg.enabledPlugins = { ...(cfg.enabledPlugins ?? {}), ...enabledPlugins };
  }
  if (extraKnownMarketplaces && typeof extraKnownMarketplaces === 'object') {
    cfg.extraKnownMarketplaces = { ...(cfg.extraKnownMarketplaces ?? {}), ...extraKnownMarketplaces };
  }
  if (statusLine && typeof statusLine === 'object') {
    const existing = cfg.statusLine;
    const mine = existing && typeof existing === 'object' && existing.command === statusLine.command;
    if (!existing || mine) cfg.statusLine = statusLine;
  }
  Object.assign(cfg, rest);
  return cfg;
}

/**
 * Remove the legacy user-level `papercusp-su` server from a parsed `~/.claude.json`
 * (mutated). Returns true when something was removed.
 */
export function stripLegacyPsuClaudeJson(cfg) {
  const servers = cfg?.mcpServers;
  if (!servers || typeof servers !== 'object' || !(PSU_CLAUDE_MCP_SERVER in servers)) return false;
  delete servers[PSU_CLAUDE_MCP_SERVER];
  return true;
}

/**
 * Remove what earlier Papercusp installs merged into a parsed
 * `~/.claude/settings.json` (mutated): hook commands under `<home>/.papercusp/`,
 * the `papercusp` plugin enrollment and its marketplace, and a statusLine pointing
 * under `<home>/.papercusp/`. Only Papercusp-owned values are touched; every other
 * hook, plugin and key is kept. `enableAllProjectMcpServers` is left alone because
 * the user may have set it themselves. Returns the list of removed items.
 */
export function stripLegacyPsuClaudeSettings(cfg, home) {
  const removed = [];
  if (!cfg || typeof cfg !== 'object') return removed;
  const prefix = join(home, '.papercusp') + '/';
  const isOurs = (command) => typeof command === 'string' && command.includes(prefix);
  if (cfg.hooks && typeof cfg.hooks === 'object') {
    for (const [event, groups] of Object.entries(cfg.hooks)) {
      if (!Array.isArray(groups)) continue;
      let dropped = 0;
      const next = groups
        .map((group) => {
          if (!group || !Array.isArray(group.hooks)) return group;
          const left = group.hooks.filter((h) => !(h && isOurs(h.command)));
          dropped += group.hooks.length - left.length;
          return left.length === group.hooks.length ? group : left.length ? { ...group, hooks: left } : null;
        })
        .filter(Boolean);
      if (!dropped) continue;
      removed.push(`hooks.${event} (${dropped})`);
      if (next.length) cfg.hooks[event] = next;
      else delete cfg.hooks[event];
    }
    if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  }
  if (cfg.enabledPlugins && typeof cfg.enabledPlugins === 'object' && PAPERCUSP_CLAUDE_PLUGIN_ID in cfg.enabledPlugins) {
    delete cfg.enabledPlugins[PAPERCUSP_CLAUDE_PLUGIN_ID];
    removed.push(`enabledPlugins.${PAPERCUSP_CLAUDE_PLUGIN_ID}`);
  }
  if (
    cfg.extraKnownMarketplaces &&
    typeof cfg.extraKnownMarketplaces === 'object' &&
    PAPERCUSP_CLAUDE_MARKETPLACE_NAME in cfg.extraKnownMarketplaces
  ) {
    delete cfg.extraKnownMarketplaces[PAPERCUSP_CLAUDE_MARKETPLACE_NAME];
    removed.push(`extraKnownMarketplaces.${PAPERCUSP_CLAUDE_MARKETPLACE_NAME}`);
  }
  if (cfg.statusLine && typeof cfg.statusLine === 'object' && isOurs(cfg.statusLine.command)) {
    delete cfg.statusLine;
    removed.push('statusLine');
  }
  return removed;
}
