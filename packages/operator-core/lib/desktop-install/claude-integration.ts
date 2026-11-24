/**
 * claude-integration — install the `papercusp-su` MCP server entry that psu gives
 * its Claude sessions.
 *
 * The entry lives in Papercusp's own home, `~/.papercusp/claude-mcp.json`
 * (`psu-claude-overlay.mjs`), and psu copies it into each session's own
 * CLAUDE_CONFIG_DIR `.claude.json` (`interactive-claude-config.ts`). It is NOT
 * registered in the user's `~/.claude.json`: a user-level entry made every plain
 * `claude` on the machine load the whole Papercusp catalog (~1,000 tools) whether
 * or not psu launched it. `installClaudeIntegration` therefore also REMOVES a
 * `papercusp-su` entry an earlier install left in `~/.claude.json`, and never
 * writes anything else there.
 *
 * The MCP url stays ENV-INTERPOLATED: the desktop operator binds a different
 * localhost port every boot, so the template reads
 *   ${PAPERCUSP_OPERATOR_URL:-<fallback>}/api/mcp?superuser=1
 *     &client=${PAPERCUSP_SID:-<agentId>} &native_session=${CLAUDE_CODE_SESSION_ID:-} …
 * and psu resolves it against the launch environment
 * (`materializePsuClaudeMcpConfig` / `resolveClaudeMcpEntry`) when it writes the
 * session copy. Writing the template is one-time and idempotent.
 *
 * Claude's onboarding flag for a box that never ran claude is handled at launch by
 * `ensureOnboardingComplete`, so this module never creates `~/.claude.json`.
 *
 * Mac + Linux (inside WSL on a Windows desktop install, where the operator sidecar
 * reports `process.platform === 'linux'`). Reads token + agent_id from
 * `~/.papercusp/` (installPapercuspFiles must have run first).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveInstallPaths } from './papercusp-files';
import { resolveAgentMcpBaseUrl } from '../mcp-base-url';
import {
  PSU_CLAUDE_MCP_SERVER,
  psuClaudeMcpTemplatePath,
  readPsuClaudeMcpEntry,
  stripLegacyPsuClaudeJson,
} from '../psu-claude-overlay.mjs';

/** The default operator url baked as the `${PAPERCUSP_OPERATOR_URL:-…}` fallback.
 *  Only used when a launch exports no PAPERCUSP_OPERATOR_URL. Kept
 *  STATIC (never the dynamic boot port) so the written entry is byte-stable →
 *  the merge stays idempotent across boots.
 *
 *  P-007 (mcp-reliability-hardening-2026-07-11): this is now the RESILIENT MCP
 *  PROXY (:9071), not a bare direct :3070, on EVERY host — desktop AND dev box.
 *  The proxy fronts :3070 and survives its deploy-restarts (WI-1457), so a session
 *  without an exported url rides the restart-invisible path by default. A dev-box reconcile with
 *  neither PAPERCUSP_MCP_PROXY_BASE nor PAPERCUSP_DESKTOP set used to re-bake the
 *  deploy-fragile direct :3070 here (silently reverting the P-006 cutover minutes
 *  after every manual re-point); defaulting to the proxy port closes that class.
 *  An explicit PAPERCUSP_MCP_PROXY_BASE still overrides (resolveAgentMcpBaseUrl). */
const DEFAULT_OPERATOR_URL_FALLBACK = 'http://127.0.0.1:9071';

export interface ClaudeIntegrationOptions {
  /** Override ~/. Tests pass this. Defaults to os.homedir(). */
  home?: string;
  /** Fallback operator url baked into the template (psu exports the live one). */
  operatorUrl?: string;
  /** Which su profile the template defaults to: 'power' → `profile=power`,
   *  anything else (engineer) → empty. Default engineer. */
  profile?: string;
}

export interface ClaudeIntegrationResult {
  /** ~/.papercusp/claude-mcp.json — the psu session MCP template. */
  templatePath: string;
  /** True when the template carries papercusp-su after this call. */
  mcpServerInstalled: boolean;
  supported: boolean;
  /** Reason when supported=false, or nothing changed for a notable cause. */
  reason?: string;
  /** True when this call wrote the template or removed a legacy entry. */
  changed: boolean;
  /** Itemized actions — for a settings UI / boot log. */
  actions: string[];
}

interface ClaudeMcpEntry {
  type: string;
  url: string;
  headers: Record<string, string>;
}

/** The user's own Claude config, where earlier installs registered papercusp-su. */
export function resolveClaudeConfigPath(home: string): string {
  return path.join(home, '.claude.json');
}

async function tryReadTrim(p: string): Promise<string | null> {
  try {
    const t = (await fs.readFile(p, 'utf8')).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Profile query-param value baked as the `${PAPERCUSP_PROFILE:-…}` default. */
function profileDefault(profile: string | undefined): string {
  return profile === 'power' ? 'power' : '';
}

/** The env-interpolated entry (see header). `operatorUrlFallback` / `agentId` /
 *  `prof` only feed the `:-default` arms — psu supplies the real values at launch. */
export function buildClaudeMcpEntry(
  operatorUrlFallback: string,
  token: string,
  agentId: string,
  prof: string,
): ClaudeMcpEntry {
  return {
    type: 'http',
    url:
      `\${PAPERCUSP_OPERATOR_URL:-${operatorUrlFallback}}/api/mcp?superuser=1` +
      `&client=\${PAPERCUSP_SID:-${agentId}}` +
      `&native_session=\${CLAUDE_CODE_SESSION_ID:-}` +
      `&workspace=\${PAPERCUSP_WORKSPACE:-}` +
      // orient-recall-quality follow-up (2026-07-12, recall drill 2): the initialize-time
      // memory prelude derives its recall query from ?harness= — without this param EVERY
      // psu claude session was a "bare session" to buildMcpPrelude (empty query → NO
      // session-start memory recall at all; live-proven via the drill's ledger: zero
      // port='initialize' stamps under any su-* id in 24h). console-launcher already
      // exports PAPERCUSP_HARNESS_SLUG for harness-scoped spawns; empty stays bare-session
      // behavior (unchanged for a bare claude).
      `&harness=\${PAPERCUSP_HARNESS_SLUG:-}` +
      `&profile=\${PAPERCUSP_PROFILE:-${prof}}` +
      // su-context-size-variants (claude trim): the ?tools= LISTING allowlist. psu exports
      // PAPERCUSP_TOOLS = the ~19-tool CORE SPINE for a `--context-size=trimmed` claude, so the
      // superuser MCP advertises ONLY the spine (~9k vs the full ~165k catalog) — the fix for
      // claude-sonnet dying "Prompt is too long" on its 200k window (claude's native ToolSearch
      // defers only SCHEMAS, leaving all ~581 names+descriptions inline). Unset/empty ⇒ full
      // catalog (parseToolsAllowlist treats empty as no-filter — zero regression for a bare
      // claude or any session that sets no allowlist). The long tail stays reachable via
      // `tools:find` (in the spine).
      `&tools=\${PAPERCUSP_TOOLS:-}` +
      // deterministic-tool-definition-delivery-2026-09-21: the SECOND axis of the
      // same decision. `?tools=` says WHICH tools are advertised; this says HOW
      // MUCH of each one ships. A name here is still advertised and still
      // callable — only prose is stripped from its advertised definition
      // (compactInputSchema keeps property names, types, the required set, enum
      // members, bounds, discriminators, nested shape and $defs/$ref). That makes
      // admission three-way (full / compact / deferred) instead of all-or-nothing,
      // which is what let seven high-demand heavies back into the seed. psu
      // exports PAPERCUSP_TOOLS_COMPACT from the GENERATED delivery artifact, so
      // neither list is hand-maintained. Unset/empty ⇒ nothing is compacted
      // (byte-identical for a bare claude or any non-psu session).
      `&tools_compact=\${PAPERCUSP_TOOLS_COMPACT:-}` +
      // context-trimming-tiers D-004: the session PAYLOAD tier — a DIFFERENT axis from the
      // retired --context-size mode. psu exports PAPERCUSP_CONTEXT_TIER='trimmed'
      // unconditionally (no launch flag selects 'full'; ptool's PAPERCUSP_CONTEXT_TIER=full
      // env override remains the one escape hatch for unshaped payloads) and the server
      // threads it to ctx.contextTier so defineTool `shape` projections apply.
      // Unset/empty/invalid ⇒ 'full' (unshaped — byte-identical for a bare claude).
      `&ctx_tier=\${PAPERCUSP_CONTEXT_TIER:-}`,
    headers: {
      Authorization: `Bearer ${token}`,
      // The launcher knows a forced/resumed native ID before Claude expands
      // HTTP config. Its built-in ID is only guaranteed in tool subprocesses.
      // Keep the query fallback for bare clients; the server prefers this
      // existing carrier and independently verifies its owner binding.
      'x-papercusp-native-session': '${PAPERCUSP_NATIVE_SESSION_ID:-}',
    },
  };
}

function entryEquals(a: ClaudeMcpEntry | undefined, b: ClaudeMcpEntry): boolean {
  return (
    !!a &&
    a.type === b.type &&
    a.url === b.url &&
    a.headers?.Authorization === b.headers.Authorization
  );
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}

/**
 * Remove the `papercusp-su` entry an earlier install registered in the user's
 * `~/.claude.json`. Every other key round-trips; an absent or unparseable file is
 * left alone. Returns true when it removed the entry.
 */
export async function removeLegacyUserClaudeMcp(home: string): Promise<boolean> {
  const claudeConfigPath = resolveClaudeConfigPath(home);
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8'));
  } catch {
    return false;
  }
  if (!stripLegacyPsuClaudeJson(cfg)) return false;
  await writeJsonAtomic(claudeConfigPath, cfg);
  return true;
}

export async function readClaudeIntegrationState(
  opts: ClaudeIntegrationOptions = {},
): Promise<{ templatePath: string; mcpServerInstalled: boolean }> {
  const home = opts.home ?? os.homedir();
  return { templatePath: psuClaudeMcpTemplatePath(home), mcpServerInstalled: readPsuClaudeMcpEntry(home) !== null };
}

export async function installClaudeIntegration(
  opts: ClaudeIntegrationOptions = {},
): Promise<ClaudeIntegrationResult> {
  const home = opts.home ?? os.homedir();
  const templatePath = psuClaudeMcpTemplatePath(home);

  if (process.platform === 'win32') {
    const st = await readClaudeIntegrationState(opts);
    return { ...st, supported: false, reason: 'windows_not_supported_in_v1', changed: false, actions: [] };
  }

  const actions: string[] = [];
  if (await removeLegacyUserClaudeMcp(home)) actions.push('removed legacy mcpServers.papercusp-su from ~/.claude.json');

  // installPapercuspFiles must have run first — token + agent_id needed.
  const phase1 = resolveInstallPaths(home);
  const token = await tryReadTrim(phase1.tokenPath);
  const agentId = await tryReadTrim(phase1.agentIdPath);
  if (!token || !agentId) {
    const st = await readClaudeIntegrationState(opts);
    return { ...st, supported: true, reason: 'phase1_not_run', changed: actions.length > 0, actions };
  }

  // WI-1457 / P-007: the baked fallback is the resilient MCP proxy (:9071); an
  // explicit PAPERCUSP_MCP_PROXY_BASE still overrides via resolveAgentMcpBaseUrl.
  // A static loopback URL keeps the template byte-stable across boots.
  const operatorUrl = opts.operatorUrl ?? resolveAgentMcpBaseUrl(DEFAULT_OPERATOR_URL_FALLBACK);
  const entry = buildClaudeMcpEntry(operatorUrl, token, agentId, profileDefault(opts.profile));

  if (!entryEquals(readPsuClaudeMcpEntry(home) as ClaudeMcpEntry | undefined, entry)) {
    await writeJsonAtomic(templatePath, { mcpServers: { [PSU_CLAUDE_MCP_SERVER]: entry } });
    actions.push(`wrote mcpServers.papercusp-su to ${templatePath}`);
  }
  return { templatePath, mcpServerInstalled: true, supported: true, changed: actions.length > 0, actions };
}

export async function uninstallClaudeIntegration(
  opts: ClaudeIntegrationOptions = {},
): Promise<ClaudeIntegrationResult> {
  const home = opts.home ?? os.homedir();
  const templatePath = psuClaudeMcpTemplatePath(home);
  if (process.platform === 'win32') {
    return { templatePath, mcpServerInstalled: false, supported: false, reason: 'windows_not_supported_in_v1', changed: false, actions: [] };
  }
  const actions: string[] = [];
  if (await removeLegacyUserClaudeMcp(home)) actions.push('removed legacy mcpServers.papercusp-su from ~/.claude.json');
  try {
    await fs.unlink(templatePath);
    actions.push(`removed ${templatePath}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return { templatePath, mcpServerInstalled: false, supported: true, changed: actions.length > 0, actions };
}
