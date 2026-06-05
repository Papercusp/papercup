/**
 * Phase 2 (opt-in) of desktop-app-install-integration-2026-05-23:
 * wire the operator into the user's local OMP install.
 *
 * Idempotent. Mirrors steps 3 + 3b + 4a + 4c-rm + 4d of
 * install-standalone-mcp.sh:
 *   - merge papercusp-su MCP server into ~/.omp/agent/mcp.json
 *     (preserves any other configured MCP servers)
 *   - enable OMP-native Hindsight memory config when an `omp` binary is
 *     available
 *   - strip the legacy always-on playbook block from
 *     ~/.omp/agent/CLAUDE.md (left there by older versions of the
 *     shell script — keeps plain `omp` from auto-loading the playbook)
 *   - install the `omp-su` wrapper next to the `omp` binary, or
 *     `~/.local/bin/omp-su` with a pathWarning when that's not on PATH
 *   - delete the legacy auto-discovered extension at
 *     ~/.omp/agent/extensions/papercusp-coord.ts so plain `omp` no
 *     longer loads coordination
 *
 * Per D-002a, supports Mac + Linux only in v1. On Windows, returns
 * `{ supported: false }` without touching the filesystem — the
 * platform-aware wrapper-install logic (P-008) is the natural
 * extension point when Windows comes later.
 *
 * Reads token + agent_id from ~/.papercusp/ (Phase 1 must have run
 * first). Returns an `installed: false, reason: 'phase1_not_run'` if
 * either is missing — caller surfaces that in the UI.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveInstallPaths } from './papercusp-files';

const exec = promisify(execFile);

const LEGACY_BLOCK_BEGIN = '<!-- BEGIN papercusp-su playbook (managed by install-standalone-mcp.sh) -->';
const LEGACY_BLOCK_END = '<!-- END papercusp-su playbook -->';

export interface OmpPaths {
  /** ~/.omp/agent/ — the OMP agent config directory. */
  ompAgentDir: string;
  /** ~/.omp/agent/mcp.json — MCP server config. */
  mcpJsonPath: string;
  /** ~/.omp/agent/CLAUDE.md — vanilla context file (where the legacy block lived). */
  legacyContextPath: string;
  /** ~/.omp/agent/extensions/papercusp-coord.ts — legacy auto-discovered extension. */
  legacyExtensionPath: string;
}

export interface OmpDetection {
  ompAgentDirExists: boolean;
  /** Absolute path to the omp binary, or null when not on PATH. */
  ompBinaryPath: string | null;
}

export interface OmpIntegrationState extends OmpPaths, OmpDetection {
  /** True when papercusp-su is configured in mcp.json. */
  mcpServerInstalled: boolean;
  /** True when the omp-su wrapper exists at its installed path. */
  wrapperInstalled: boolean;
  /** Absolute path to the installed omp-su wrapper (computed even when not installed). */
  wrapperPath: string;
  /** True when the legacy CLAUDE.md block is present (needs stripping). */
  legacyBlockPresent: boolean;
  /** Warning when wrapperPath's dir isn't on PATH; null when fine. */
  pathWarning: string | null;
}

export interface InstallOptions {
  /** Override ~/. Tests pass this. Defaults to os.homedir(). */
  home?: string;
  /** Operator URL the MCP entry points at. Defaults to http://localhost:3070. */
  operatorUrl?: string;
  /** Override PATH lookup for omp. Tests pass this to skip exec. */
  ompBinaryPath?: string | null;
  /** Force-skip the wrapper install (Windows path uses this). */
  skipWrapper?: boolean;
}

export interface IntegrationInstallResult extends OmpIntegrationState {
  supported: boolean;
  /** Reason when supported=false or installed=false. */
  reason?: string;
  /** True when the install actually wrote files (vs no-op verification). */
  changed: boolean;
  /** Itemized actions taken — for the settings UI to surface to the user. */
  actions: string[];
}

export function resolveOmpPaths(home: string): OmpPaths {
  const ompAgentDir = path.join(home, '.omp', 'agent');
  return {
    ompAgentDir,
    mcpJsonPath: path.join(ompAgentDir, 'mcp.json'),
    legacyContextPath: path.join(ompAgentDir, 'CLAUDE.md'),
    legacyExtensionPath: path.join(ompAgentDir, 'extensions', 'papercusp-coord.ts'),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectOmpBinary(): Promise<string | null> {
  // `command -v` is POSIX; works on bash/zsh/dash. Skipped on Windows
  // anyway via the supported check before this is called.
  try {
    const { stdout } = await exec('sh', ['-c', 'command -v omp'], { timeout: 3000 });
    const found = stdout.trim();
    return found || null;
  } catch {
    return null;
  }
}

const OMP_HINDSIGHT_DESIRED_CONFIG = [
  ['memory.backend', 'hindsight'],
  ['hindsight.apiUrl', process.env.PAPERCUSP_HINDSIGHT_API_URL ?? process.env.HINDSIGHT_API_URL ?? 'http://localhost:8888'],
  ['hindsight.scoping', 'per-project-tagged'],
  ['hindsight.autoRecall', 'true'],
  ['hindsight.autoRetain', 'true'],
] as const;

function ompExecEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home };
}

async function readOmpConfigValue(
  ompBinaryPath: string,
  home: string,
  key: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec(ompBinaryPath, ['config', 'get', key], {
      timeout: 3000,
      env: ompExecEnv(home),
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function ensureOmpHindsightConfig(
  ompBinaryPath: string | null,
  home: string,
): Promise<string[]> {
  if (!ompBinaryPath) return [];
  const updated: string[] = [];
  for (const [key, value] of OMP_HINDSIGHT_DESIRED_CONFIG) {
    const current = await readOmpConfigValue(ompBinaryPath, home, key);
    if (current === value) continue;
    try {
      await exec(ompBinaryPath, ['config', 'set', key, value], {
        timeout: 3000,
        env: ompExecEnv(home),
      });
      updated.push(key);
    } catch {
      return updated;
    }
  }
  return updated;
}

export async function detectOmp(home: string): Promise<OmpDetection> {
  const ompAgentDir = path.join(home, '.omp', 'agent');
  const ompAgentDirExists = await pathExists(ompAgentDir);
  const ompBinaryPath = await detectOmpBinary();
  return { ompAgentDirExists, ompBinaryPath };
}

interface McpServerEntry {
  type: string;
  url: string;
  headers: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

async function readJsonOrEmpty(p: string): Promise<McpConfig> {
  try {
    const buf = await fs.readFile(p, 'utf8');
    return JSON.parse(buf) as McpConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (e instanceof SyntaxError) {
      // Back up the invalid file (per install-standalone-mcp.sh §3) so
      // the user isn't silently overwritten.
      const ts = Math.floor(Date.now() / 1000);
      await fs.rename(p, `${p}.bak.${ts}`);
      return {};
    }
    throw e;
  }
}

function buildMcpEntry(operatorUrl: string, token: string, agentId: string): McpServerEntry {
  return {
    type: 'http',
    url: `${operatorUrl}/api/mcp?superuser=1&client=${agentId}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

function mcpEntryEquals(a: McpServerEntry | undefined, b: McpServerEntry): boolean {
  if (!a) return false;
  return (
    a.type === b.type &&
    a.url === b.url &&
    a.headers?.Authorization === b.headers.Authorization
  );
}

async function mergeMcpServer(
  mcpJsonPath: string,
  operatorUrl: string,
  token: string,
  agentId: string,
): Promise<{ wrote: boolean; created: boolean }> {
  const existed = await pathExists(mcpJsonPath);
  await fs.mkdir(path.dirname(mcpJsonPath), { recursive: true });

  const cfg = existed ? await readJsonOrEmpty(mcpJsonPath) : {};
  cfg.mcpServers = cfg.mcpServers ?? {};

  const newEntry = buildMcpEntry(operatorUrl, token, agentId);
  if (mcpEntryEquals(cfg.mcpServers['papercusp-su'], newEntry)) {
    return { wrote: false, created: false };
  }
  cfg.mcpServers['papercusp-su'] = newEntry;
  await fs.writeFile(mcpJsonPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.chmod(mcpJsonPath, 0o600);
  return { wrote: true, created: !existed };
}

async function stripLegacyBlock(filePath: string): Promise<boolean> {
  if (!(await pathExists(filePath))) return false;
  const text = await fs.readFile(filePath, 'utf8');
  const startIdx = text.indexOf(LEGACY_BLOCK_BEGIN);
  const endIdx = text.indexOf(LEGACY_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return false;
  // Include the trailing newline after the END marker if present.
  const endAfter = endIdx + LEGACY_BLOCK_END.length;
  const sliceEnd = text[endAfter] === '\n' ? endAfter + 1 : endAfter;
  const stripped = (text.slice(0, startIdx) + text.slice(sliceEnd)).replace(/^\n+/, '');
  await fs.writeFile(filePath, stripped);
  return true;
}

function resolveWrapperPath(home: string, ompBinaryPath: string | null): string {
  // Co-locate with omp if we found it; otherwise ~/.local/bin/.
  if (ompBinaryPath) return path.join(path.dirname(ompBinaryPath), 'omp-su');
  return path.join(home, '.local', 'bin', 'omp-su');
}

// (wrapperContent/installWrapper removed — omp-su wrapper retired, P-050.)

function checkPathContains(dir: string, envPath: string | undefined): boolean {
  if (!envPath) return false;
  const parts = envPath.split(path.delimiter);
  return parts.some((p) => path.resolve(p) === path.resolve(dir));
}

export async function readOmpIntegrationState(opts: InstallOptions = {}): Promise<OmpIntegrationState> {
  const home = opts.home ?? os.homedir();
  const ompPaths = resolveOmpPaths(home);
  const detection: OmpDetection =
    opts.ompBinaryPath !== undefined
      ? { ompAgentDirExists: await pathExists(ompPaths.ompAgentDir), ompBinaryPath: opts.ompBinaryPath }
      : await detectOmp(home);

  const wrapperPath = resolveWrapperPath(home, detection.ompBinaryPath);

  let mcpServerInstalled = false;
  if (await pathExists(ompPaths.mcpJsonPath)) {
    const cfg = await readJsonOrEmpty(ompPaths.mcpJsonPath);
    mcpServerInstalled = !!cfg.mcpServers?.['papercusp-su'];
  }

  const wrapperInstalled = await pathExists(wrapperPath);

  let legacyBlockPresent = false;
  if (await pathExists(ompPaths.legacyContextPath)) {
    const text = await fs.readFile(ompPaths.legacyContextPath, 'utf8');
    legacyBlockPresent =
      text.includes(LEGACY_BLOCK_BEGIN) && text.includes(LEGACY_BLOCK_END);
  }

  const wrapperDir = path.dirname(wrapperPath);
  const pathWarning = checkPathContains(wrapperDir, process.env.PATH)
    ? null
    : `${wrapperDir} is not on PATH — add it or invoke ${wrapperPath} by full path`;

  return {
    ...ompPaths,
    ...detection,
    mcpServerInstalled,
    wrapperInstalled,
    wrapperPath,
    legacyBlockPresent,
    pathWarning,
  };
}

export async function installOmpIntegration(opts: InstallOptions = {}): Promise<IntegrationInstallResult> {
  // D-002a — Windows is deferred. Surface clearly; settings UI can
  // display a "Not supported on this platform" line.
  if (process.platform === 'win32') {
    const home = opts.home ?? os.homedir();
    const state = await readOmpIntegrationState(opts);
    return {
      ...state,
      supported: false,
      reason: 'windows_not_supported_in_v1',
      changed: false,
      actions: [],
    };
  }

  const home = opts.home ?? os.homedir();
  const ompPaths = resolveOmpPaths(home);
  const detection: OmpDetection =
    opts.ompBinaryPath !== undefined
      ? { ompAgentDirExists: await pathExists(ompPaths.ompAgentDir), ompBinaryPath: opts.ompBinaryPath }
      : await detectOmp(home);

  // Phase 1 must have run first — token + agent_id needed for the
  // mcp.json merge.
  const phase1 = resolveInstallPaths(home);
  const tokenStr = await tryReadTrim(phase1.tokenPath);
  const agentIdStr = await tryReadTrim(phase1.agentIdPath);
  if (!tokenStr || !agentIdStr) {
    return {
      ...(await readOmpIntegrationState(opts)),
      supported: true,
      reason: 'phase1_not_run',
      changed: false,
      actions: [],
    };
  }

  const operatorUrl = opts.operatorUrl ?? 'http://localhost:3070';
  const actions: string[] = [];

  // 1. mcp.json merge — idempotent (compares to existing entry).
  const merge = await mergeMcpServer(ompPaths.mcpJsonPath, operatorUrl, tokenStr, agentIdStr);
  if (merge.wrote) {
    actions.push(merge.created ? `created ${ompPaths.mcpJsonPath}` : `updated mcpServers.papercusp-su`);
  }

  // 2. strip the legacy CLAUDE.md block (no-op when already stripped or file missing).
  if (await stripLegacyBlock(ompPaths.legacyContextPath)) {
    actions.push(`stripped legacy playbook block from ${ompPaths.legacyContextPath}`);
  }

  // 3. remove the legacy auto-discovered extension copy.
  if (await pathExists(ompPaths.legacyExtensionPath)) {
    await fs.rm(ompPaths.legacyExtensionPath, { force: true });
    actions.push(`removed legacy extension at ${ompPaths.legacyExtensionPath}`);
  }

  const hindsightUpdated = await ensureOmpHindsightConfig(detection.ompBinaryPath, home);
  if (hindsightUpdated.length > 0) {
    actions.push(`configured OMP Hindsight (${hindsightUpdated.join(', ')})`);
  }

  // 4. The omp-su wrapper is RETIRED (psu-only-launch P-050) — psu launches
  //    raw omp per-launch (playbook + `-e` coord via suLaunchArgs /
  //    resumeArgsFor), so this install no longer writes a wrapper.
  //    uninstallOmpIntegration still removes a stale one. The MCP merge
  //    (step 1) is what psu's raw omp depends on and stays.

  // Re-read final state.
  const finalState = await readOmpIntegrationState(opts);

  return {
    ...finalState,
    supported: true,
    changed: actions.length > 0,
    actions,
  };
}

export async function uninstallOmpIntegration(opts: InstallOptions = {}): Promise<IntegrationInstallResult> {
  // Always reports `supported: true` on POSIX even when nothing was to
  // uninstall; settings UI uses `actions` to know what happened.
  if (process.platform === 'win32') {
    return {
      ...(await readOmpIntegrationState(opts)),
      supported: false,
      reason: 'windows_not_supported_in_v1',
      changed: false,
      actions: [],
    };
  }
  const home = opts.home ?? os.homedir();
  const ompPaths = resolveOmpPaths(home);
  const detection: OmpDetection =
    opts.ompBinaryPath !== undefined
      ? { ompAgentDirExists: await pathExists(ompPaths.ompAgentDir), ompBinaryPath: opts.ompBinaryPath }
      : await detectOmp(home);

  const actions: string[] = [];

  // 1. remove the papercusp-su MCP entry, preserve other servers.
  if (await pathExists(ompPaths.mcpJsonPath)) {
    const cfg = await readJsonOrEmpty(ompPaths.mcpJsonPath);
    if (cfg.mcpServers?.['papercusp-su']) {
      delete cfg.mcpServers['papercusp-su'];
      await fs.writeFile(ompPaths.mcpJsonPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      actions.push(`removed mcpServers.papercusp-su from ${ompPaths.mcpJsonPath}`);
    }
  }

  // 2. remove wrapper.
  const wrapperPath = resolveWrapperPath(home, detection.ompBinaryPath);
  if (await pathExists(wrapperPath)) {
    await fs.rm(wrapperPath, { force: true });
    actions.push(`removed wrapper at ${wrapperPath}`);
  }

  const finalState = await readOmpIntegrationState(opts);

  return {
    ...finalState,
    supported: true,
    changed: actions.length > 0,
    actions,
  };
}

async function tryReadTrim(p: string): Promise<string | null> {
  try {
    const s = await fs.readFile(p, 'utf8');
    const t = s.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
