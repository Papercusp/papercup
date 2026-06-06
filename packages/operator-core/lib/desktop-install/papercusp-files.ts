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
import { spliceToolingOverlay, spliceAtMarker, WIRE_SCHEMAS_MARKER, COORD_LEGEND_MARKER } from './splice-tooling-overlay';
import { renderWireSchemasSection } from '../prompt-assembly';
import { renderCoordLegend } from '../coord-schema';

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
   * Override the playbook source path. Defaults to first-found among
   * the candidate layout list (see `playbookCandidates`).
   */
  playbookSource?: string;
  /**
   * Override the extension source path. Defaults to first-found among
   * the candidate layout list (see `extensionCandidates`).
   */
  extensionSource?: string;
  /**
   * Operator app root. Defaults to walking up from this module's
   * location. Used as the *primary* candidate for default source
   * resolution. Tests set this to a fake tree.
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

/** Read the per-agent tooling overlay (`papercusp-su.<agent>.md`) beside
 *  the base playbook; missing → '' (the marker is still removed, never
 *  shipped literally). One reader for every client (omp/claude/codex) so
 *  the install path and `buildLaunchSpec`'s `su` branch can't drift. */
async function readAgentOverlay(baseSrc: string, agent: string): Promise<string> {
  const overlayPath = path.join(path.dirname(baseSrc), `papercusp-su.${agent}.md`);
  try {
    return (await fs.readFile(overlayPath, 'utf8')).replace(/\n+$/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Write the base playbook with the OMP tooling overlay spliced in at
 * the marker (or appended, if a pre-marker base is ever encountered).
 * Node port of `render_playbook` from install-standalone-mcp.sh.
 * Returns false when the base source is missing (matches copyIfExists).
 */
async function writeSplicedPlaybook(baseSrc: string, dst: string): Promise<boolean> {
  let base: string;
  try {
    base = await fs.readFile(baseSrc, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  const overlay = await readAgentOverlay(baseSrc, 'omp');
  let out = spliceAtMarker(spliceToolingOverlay(base, overlay), WIRE_SCHEMAS_MARKER, renderWireSchemasSection());
  out = spliceAtMarker(out, COORD_LEGEND_MARKER, renderCoordLegend());
  await fs.writeFile(dst, out, { mode: 0o644 });
  await fs.chmod(dst, 0o644);
  return true;
}

function resolveOperatorAppRoot(): string {
  // Source layout (tsx dev): this file lives at
  // <operatorApp>/lib/desktop-install/papercusp-files.ts. Walk up two
  // directories. In the esbuild-bundled production layout (single
  // host.cjs in sidecar/), __dirname collapses to sidecar/ — the
  // candidate-list fallbacks below handle that.
  return path.resolve(__dirname, '..', '..');
}

/**
 * Candidate playbook source paths, ordered most-specific first. The
 * first one that exists wins.
 *
 * When `operatorAppRoot` is explicitly provided (tests, or the caller
 * knows where the app lives), ONLY that root is considered — no
 * process.cwd() fallback. Auto-discovered mode (no explicit root)
 * also tries process.cwd()-rooted paths to cover the esbuild-bundled
 * Tauri sidecar layout where `__dirname` collapses to `sidecar/`.
 */
function playbookCandidates(operatorAppRoot: string, explicitRoot: boolean, profile = 'engineer'): string[] {
  const file = `papercusp-su-${profile}.tools.md`;
  const fromRoot = [path.join(operatorAppRoot, 'prompts', file)];
  if (explicitRoot) return fromRoot;
  const sidecarRoot = process.cwd();
  return [
    ...fromRoot,
    path.join(sidecarRoot, 'apps', 'operator', 'prompts', file),
    path.join(sidecarRoot, 'prompts', file),
  ];
}

function extensionCandidates(operatorAppRoot: string, explicitRoot: boolean): string[] {
  const fromRoot = [path.join(operatorAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts')];
  if (explicitRoot) return fromRoot;
  const sidecarRoot = process.cwd();
  return [
    ...fromRoot,
    path.join(sidecarRoot, 'apps', 'operator', 'scripts', 'hooks', 'omp', 'coord-hook.ts'),
  ];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
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
  const explicitRoot = !!opts.operatorAppRoot;
  const operatorAppRoot = opts.operatorAppRoot ?? resolveOperatorAppRoot();

  const playbookSource =
    opts.playbookSource ?? (await firstExisting(playbookCandidates(operatorAppRoot, explicitRoot)));
  const extensionSource =
    opts.extensionSource ?? (await firstExisting(extensionCandidates(operatorAppRoot, explicitRoot)));

  const paths = resolveInstallPaths(home);

  await fs.mkdir(paths.papercuspDir, { recursive: true, mode: 0o700 });

  const token = await ensureSecret(paths.tokenPath, mintToken);
  const agentId = await ensureSecret(paths.agentIdPath, mintAgentId);

  // Playbook: splice the OMP overlay at the marker (NOT a raw copy —
  // the marker-model base is incomplete on its own). Extension: raw
  // copy (coord-hook.ts has no overlay).
  const playbookWritten = playbookSource ? await writeSplicedPlaybook(playbookSource, paths.playbookPath) : false;
  const extensionWritten = extensionSource ? await copyIfExists(extensionSource, paths.extensionPath) : false;

  return {
    ...paths,
    minted: { token: token.minted, agentId: agentId.minted },
    playbookWritten,
    extensionWritten,
    playbookSource: playbookWritten && playbookSource ? playbookSource : '',
    extensionSource: extensionWritten && extensionSource ? extensionSource : '',
  };
}

export interface RenderSuPlaybookInput {
  /** Which client's tooling overlay to splice in (omp/claude/codex). */
  agent: string;
  /** Base-playbook profile: 'engineer' (default) | 'power'. */
  profile?: string;
  /** Override the operator app root (tests). Defaults to walking up from here. */
  operatorAppRoot?: string;
  /** Override the resolved base path directly (tests / explicit callers). */
  baseSource?: string;
}

export interface RenderedSuPlaybook {
  /** The spliced playbook text (base + per-agent overlay at the marker). */
  text: string;
  /** Resolved base-playbook path, '' if none was found. */
  baseSource: string;
  /** Resolved overlay path, '' when the agent has no overlay file. */
  overlaySource: string;
}

/**
 * Render an SU playbook IN MEMORY: the `papercusp-su-<profile>.tools.md`
 * base with the `papercusp-su.<agent>.md` overlay spliced in at the
 * marker. This is the SAME composition the install path
 * (`writeSplicedPlaybook`) writes to disk — both go through
 * `spliceToolingOverlay` + `readAgentOverlay` over the SAME prompts
 * files, so a `psu` launch and a `~/.papercusp/engineer-collaborator.md`
 * install can never drift.
 *
 * `buildLaunchSpec({ kind: 'su' })` uses this to source the prompt
 * fresh from the prompts dir rather than depending on install having run.
 * Throws when the base profile file can't be found (a real misconfig —
 * surface it; the marker-model base is required).
 */
export async function renderSuPlaybook(input: RenderSuPlaybookInput): Promise<RenderedSuPlaybook> {
  const profile = input.profile ?? 'engineer';
  const explicitRoot = !!input.operatorAppRoot;
  const operatorAppRoot = input.operatorAppRoot ?? resolveOperatorAppRoot();
  const baseSource =
    input.baseSource ?? (await firstExisting(playbookCandidates(operatorAppRoot, explicitRoot, profile)));
  if (!baseSource) {
    throw new Error(
      `renderSuPlaybook: base playbook "papercusp-su-${profile}.tools.md" not found ` +
        `(searched from operatorAppRoot=${operatorAppRoot})`,
    );
  }
  const base = await fs.readFile(baseSource, 'utf8');
  const overlay = await readAgentOverlay(baseSource, input.agent);
  const overlaySource = overlay
    ? path.join(path.dirname(baseSource), `papercusp-su.${input.agent}.md`)
    : '';
  const withWire = spliceAtMarker(
    spliceToolingOverlay(base, overlay),
    WIRE_SCHEMAS_MARKER,
    renderWireSchemasSection(),
  );
  const text = spliceAtMarker(withWire, COORD_LEGEND_MARKER, renderCoordLegend());
  return { text, baseSource, overlaySource };
}
