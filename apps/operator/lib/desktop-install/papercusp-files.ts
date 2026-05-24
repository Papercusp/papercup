/**
 * Phase 1 (always-on) of desktop-app-install-integration-2026-05-23:
 *
 * Mint / reuse the superuser-token + agent_id, copy the engineer-
 * collaborator playbook + coordination extension into ~/.papercusp/.
 *
 * Idempotent: token + agent_id are minted only on first call; subsequent
 * calls reuse the existing values (per a03fb875 — don't disrupt live
 * shells by rotating their bearer). Playbook + extension are refreshed
 * every call so app updates flow to the user.
 *
 * Node port of steps 1–2b + 4 + 4c of install-standalone-mcp.sh. The
 * shell script remains the dev/repo path; this is the
 * Papercusp.app/sidecar path (D-001a).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export interface InstallPaths {
  /** ~/.papercusp/ — created if missing. */
  papercuspDir: string;
  /** ~/.papercusp/superuser-token — created mode 0600 if missing. */
  tokenPath: string;
  /** ~/.papercusp/su-agent-id — created mode 0600 if missing. */
  agentIdPath: string;
  /** ~/.papercusp/engineer-collaborator.md — refreshed every call. */
  playbookPath: string;
  /** ~/.papercusp/papercusp-coord.ts — refreshed every call. */
  extensionPath: string;
}

export interface InstallResult extends InstallPaths {
  /**
   * Indicates which artifacts were newly minted on this call.
   * Playbook/extension are not tracked here (always written).
   */
  minted: { token: boolean; agentId: boolean };
  /** True when the playbook source file was found and copied. */
  playbookWritten: boolean;
  /** True when the extension source file was found and copied. */
  extensionWritten: boolean;
  /** Where the playbook source was read from. Empty when not found. */
  playbookSource: string;
  /** Where the extension source was read from. Empty when not found. */
  extensionSource: string;
}

export interface InstallOpts {
  /** Override ~/. Useful for tests. Defaults to os.homedir(). */
  home?: string;
  /**
   * Override the playbook source path. Defaults to
   * `<operatorAppRoot>/prompts/papercusp-su.tools.md`.
   */
  playbookSource?: string;
  /**
   * Override the extension source path. Defaults to
   * `<operatorAppRoot>/scripts/hooks/omp/coord-hook.ts`.
   */
  extensionSource?: string;
  /**
   * Operator app root. Defaults to walking up from this module's
   * location. Resolved playbook + extension live underneath this.
   */
  operatorAppRoot?: string;
}

/**
 * Mint a 32-character base64url-safe token. The shell script does
 * `head -c 24 /dev/urandom | base64 | tr -d '+/=' | head -c 32` —
 * which actually yields variable length (~26 chars) because base64
 * of 24 bytes has zero padding chars but does contain `+`/`/`. The
 * Node port uses base64url for clean fixed-length 32 chars with the
 * same 24-byte (192-bit) entropy — strictly more secure than the
 * shell version, and read by the same consumers (bearer string, no
 * length check).
 */
function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function mintAgentId(): string {
  return crypto.randomUUID();
}

async function readNonEmptyFile(p: string): Promise<string | null> {
  try {
    const s = await fs.readFile(p, 'utf8');
    const trimmed = s.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function ensureSecret(filePath: string, mint: () => string): Promise<{ value: string; minted: boolean }> {
  const existing = await readNonEmptyFile(filePath);
  if (existing) return { value: existing, minted: false };
  const value = mint();
  await fs.writeFile(filePath, value + '\n', { mode: 0o600 });
  // writeFile honors mode only on creation; chmod to guarantee on overwrite.
  await fs.chmod(filePath, 0o600);
  return { value, minted: true };
}

async function copyIfExists(src: string, dst: string): Promise<boolean> {
  try {
    const data = await fs.readFile(src);
    await fs.writeFile(dst, data, { mode: 0o644 });
    await fs.chmod(dst, 0o644);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function resolveOperatorAppRoot(): string {
  // This file lives at <operatorApp>/lib/desktop-install/papercusp-files.ts.
  // Walk up two directories. Resolves correctly under both tsx (source) and
  // built JS layouts (same relative depth).
  return path.resolve(__dirname, '..', '..');
}

export function resolveInstallPaths(home: string): InstallPaths {
  const papercuspDir = path.join(home, '.papercusp');
  return {
    papercuspDir,
    tokenPath: path.join(papercuspDir, 'superuser-token'),
    agentIdPath: path.join(papercuspDir, 'su-agent-id'),
    playbookPath: path.join(papercuspDir, 'engineer-collaborator.md'),
    extensionPath: path.join(papercuspDir, 'papercusp-coord.ts'),
  };
}

export async function installPapercuspFiles(opts: InstallOpts = {}): Promise<InstallResult> {
  const home = opts.home ?? os.homedir();
  const operatorAppRoot = opts.operatorAppRoot ?? resolveOperatorAppRoot();
  const playbookSource = opts.playbookSource ?? path.join(operatorAppRoot, 'prompts', 'papercusp-su.tools.md');
  const extensionSource = opts.extensionSource ?? path.join(operatorAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts');

  const paths = resolveInstallPaths(home);

  await fs.mkdir(paths.papercuspDir, { recursive: true, mode: 0o700 });

  const token = await ensureSecret(paths.tokenPath, mintToken);
  const agentId = await ensureSecret(paths.agentIdPath, mintAgentId);

  const playbookWritten = await copyIfExists(playbookSource, paths.playbookPath);
  const extensionWritten = await copyIfExists(extensionSource, paths.extensionPath);

  return {
    ...paths,
    minted: { token: token.minted, agentId: agentId.minted },
    playbookWritten,
    extensionWritten,
    playbookSource: playbookWritten ? playbookSource : '',
    extensionSource: extensionWritten ? extensionSource : '',
  };
}
