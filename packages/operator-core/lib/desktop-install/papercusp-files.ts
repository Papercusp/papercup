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
import { fileURLToPath } from 'node:url';
import { spliceToolingOverlay, spliceGeneratedSection, WIRE_SCHEMAS_MARKER, COORD_LEGEND_MARKER, WORKSPACE_MAP_MARKER, PROJECT_GUIDE_MARKER } from './splice-tooling-overlay';
import { renderDeployPipelineNote } from '../deploy-pipeline-policy';
import { renderWorkspaceMapSection } from './workspace-map';
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
async function readAgentOverlay(baseSrc: string, agent: string, overlayDir?: string): Promise<string> {
  const overlayPath = path.join(overlayDir ?? path.dirname(baseSrc), `papercusp-su.${agent}.md`);
  try {
    return (await fs.readFile(overlayPath, 'utf8')).replace(/\n+$/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Wrap the project guide (the repo's `CLAUDE.md`) for splicing into a psu
 * playbook (psu-isolation P-001 / D-002). Empty guide → '' so the marker is
 * removed, never shipped literally. The provenance header tells the agent this
 * is the repo's editable guide delivered by splice (NOT client auto-load), so
 * a session knows where to edit it and that personal config was deliberately
 * left out.
 */
export function renderProjectGuideSection(guideText: string): string {
  const body = guideText.replace(/\n+$/, '').trim();
  if (!body) return '';
  return (
    '## Project guide — repo conventions\n\n' +
    "> The following is the working repo's project guide (`CLAUDE.md` at the\n" +
    "> repo root — the single editable source; `AGENTS.md` is a symlink to it).\n" +
    '> It is spliced in here so a psu session gets these conventions WITHOUT the\n' +
    '> client auto-loading the file (which would also drag in the launching\n' +
    "> user's personal/global config). To change it, edit the repo's `CLAUDE.md`.\n\n" +
    body +
    '\n'
  );
}

/**
 * Candidate project-guide (`CLAUDE.md`) paths for the ENGINEER profile — the
 * working repo's own guide, resolved relative to the resolved base playbook
 * (which lives at `<repo>/apps/operator/prompts/`) and `process.cwd()`. The
 * power profile passes an explicit `projectGuideSource` (the managed repo's
 * guide) instead of relying on this. First existing wins; none → no guide.
 */
function projectGuideCandidates(baseSource: string): string[] {
  const promptsDir = path.dirname(baseSource);
  return [
    path.resolve(promptsDir, '..', '..', '..', 'CLAUDE.md'), // <repo>/apps/operator/prompts → <repo>
    path.resolve(promptsDir, '..', 'CLAUDE.md'), // <sidecar>/prompts → <sidecar>
    path.join(process.cwd(), 'CLAUDE.md'),
  ];
}

/**
 * Resolve + read the project guide for splicing. `explicitSource` (when not
 * undefined) wins — including '' which means "no guide" (e.g. a power launch
 * whose managed repo has none). Otherwise auto-resolve the engineer candidates.
 * Reads only when the base actually carries the marker (the caller gates this),
 * so a markerless base never pays the file read.
 */
async function resolveProjectGuideText(
  baseSource: string,
  explicitSource: string | undefined,
): Promise<{ text: string; source: string }> {
  const source =
    explicitSource !== undefined ? explicitSource : ((await firstExisting(projectGuideCandidates(baseSource))) ?? '');
  if (!source) return { text: '', source: '' };
  try {
    return { text: await fs.readFile(source, 'utf8'), source };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', source: '' };
    throw e;
  }
}

/**
 * Project the shared, cross-cutting BEHAVIORAL note(s) — canonical constants owned by
 * `@papercusp/orchestrator` (re-exported through operator-core's policy wrappers) — into the
 * su playbook from the SINGLE source. Currently `DEPLOY_PIPELINE_NOTE` (the "deploy pipeline is
 * async; a RED gate is EVERYONE's job to FIX, no owner-ask, even out of lane" directive), which
 * the su base playbook otherwise misses entirely while the spawned-bee + operator-launched bases
 * already inject it programmatically (prompt-build.ts / prompt-assembly.ts). This keeps such a
 * universal directive in ONE place that projects to EVERY base, model/provider-agnostic (a plain
 * string spliced regardless of model), ADDITIVELY — su's existing condensed notes and the `.md`
 * prompt files are left untouched. Inserted just before the project-guide section so it sits in
 * the playbook body, not buried under the 600-line guide.
 */
function injectSharedBaseNotes(text: string): string {
  // Anchor on the project-guide marker: it is the one marker still un-spliced at this point AND a
  // reliable "this is a real su playbook" signal (engineer/power carry it; minimal/test bases do
  // not). Insert the note just BEFORE it; NEVER append, so a marker-less base is returned untouched
  // (mirrors spliceGeneratedSection's no-append contract).
  if (!text.includes(PROJECT_GUIDE_MARKER)) return text;
  const note = renderDeployPipelineNote();
  if (!note) return text;
  return text.split(PROJECT_GUIDE_MARKER).join(`${note}\n\n${PROJECT_GUIDE_MARKER}`);
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
  let out = spliceGeneratedSection(spliceToolingOverlay(base, overlay), WIRE_SCHEMAS_MARKER, renderWireSchemasSection());
  out = spliceGeneratedSection(out, COORD_LEGEND_MARKER, renderCoordLegend());
  out = spliceGeneratedSection(out, WORKSPACE_MAP_MARKER, renderWorkspaceMapSection());
  out = injectSharedBaseNotes(out);
  // Project guide (P-001): engineer-profile install splices the repo's CLAUDE.md.
  if (out.includes(PROJECT_GUIDE_MARKER)) {
    const { text } = await resolveProjectGuideText(baseSrc, undefined);
    out = spliceGeneratedSection(out, PROJECT_GUIDE_MARKER, renderProjectGuideSection(text));
  }
  await fs.writeFile(dst, out, { mode: 0o644 });
  await fs.chmod(dst, 0o644);
  return true;
}

function resolveOperatorAppRoot(): string {
  // Source layout (tsx dev): this file lives at
  // <operatorApp>/lib/desktop-install/papercusp-files.ts. Walk up two
  // directories. In the esbuild-bundled production layout (single
  // host.cjs in sidecar/), the module dir collapses to sidecar/ — the
  // candidate-list fallbacks below handle that. ESM-safe: use
  // fileURLToPath(import.meta.url) for the module path, with process.cwd()
  // as a safe fallback if that fails for any reason.
  let moduleDir: string;
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    moduleDir = process.cwd();
  }
  return path.resolve(moduleDir, '..', '..');
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
  // Profile-specific base, then the ENGINEER base as a graceful fallback for any
  // non-engineer profile (domain-generic-hive-architecture P-025): a `generic`
  // (non-coding work-hive) launch has no `papercusp-su-generic.tools.md` of its own
  // yet, so it degrades to the engineer base playbook — its domain context comes from
  // the per-hive su override + a NO repo-guide splice (role-launch-spec, profile=generic),
  // not a bespoke base. `power` has its own file so the fallback never triggers for it.
  // Only GENERIC gets the engineer fallback (it has no bespoke file by design). Every
  // OTHER profile keeps the strict single-candidate behavior so a typo'd/missing profile
  // file still THROWS (defense-in-depth alongside the bootstrap-su allow-list) rather than
  // silently masking to engineer.
  const files = profile === 'generic'
    ? [`papercusp-su-${profile}.tools.md`, 'papercusp-su-engineer.tools.md']
    : [`papercusp-su-${profile}.tools.md`];
  const roots = explicitRoot
    ? [path.join(operatorAppRoot, 'prompts')]
    : [
        path.join(operatorAppRoot, 'prompts'),
        path.join(process.cwd(), 'apps', 'operator', 'prompts'),
        path.join(process.cwd(), 'prompts'),
      ];
  // Specificity-first: try the profile-specific file in every root before the
  // engineer fallback in every root, so a real generic file (if later authored) wins.
  return files.flatMap((file) => roots.map((r) => path.join(r, file)));
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
  /** Dir to resolve the per-agent overlay (`papercusp-su.<agent>.md`) from. Defaults to
   *  dirname(baseSource). Set when baseSource is a blueprint persona whose dir has no
   *  client overlays (domain-generic-agent-personas P-006) — point it at the operator
   *  prompts dir so the client tooling overlay still splices. */
  overlayDir?: string;
  /**
   * Project-guide source to splice at PROJECT_GUIDE_MARKER (P-001 / D-002).
   * - `undefined` (default) → auto-resolve the ENGINEER candidates: the repo's
   *   own `CLAUDE.md`.
   * - an explicit path → read that (the POWER profile passes the managed repo's
   *   guide, resolved from the launch cwd).
   * - `''` → no guide (marker removed). Only read when the base carries the marker.
   */
  projectGuideSource?: string;
}

export interface RenderedSuPlaybook {
  /** The spliced playbook text (base + per-agent overlay at the marker). */
  text: string;
  /** Resolved base-playbook path, '' if none was found. */
  baseSource: string;
  /** Resolved overlay path, '' when the agent has no overlay file. */
  overlaySource: string;
  /** Resolved project-guide path, '' when none was spliced. */
  projectGuideSource: string;
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
  const overlay = await readAgentOverlay(baseSource, input.agent, input.overlayDir);
  const overlaySource = overlay
    ? path.join(input.overlayDir ?? path.dirname(baseSource), `papercusp-su.${input.agent}.md`)
    : '';
  const withWire = spliceGeneratedSection(
    spliceToolingOverlay(base, overlay),
    WIRE_SCHEMAS_MARKER,
    renderWireSchemasSection(),
  );
  const withLegend = spliceGeneratedSection(withWire, COORD_LEGEND_MARKER, renderCoordLegend());
  const withMap = spliceGeneratedSection(withLegend, WORKSPACE_MAP_MARKER, renderWorkspaceMapSection());
  // Only the ENGINEER profile works the Papercusp repo (where this pipeline + its green gate live);
  // the power profile manages an EXTERNAL repo, so the Papercusp-specific note does not apply there.
  const withNotes = profile === 'engineer' ? injectSharedBaseNotes(withMap) : withMap;
  // Project guide (P-001 / D-002): splice the repo's CLAUDE.md so a psu session
  // gets the full project conventions via psu, not client auto-load. Only read
  // the (large) guide file when the base actually carries the marker.
  let text = withNotes;
  let projectGuideSource = '';
  if (withNotes.includes(PROJECT_GUIDE_MARKER)) {
    const guide = await resolveProjectGuideText(baseSource, input.projectGuideSource);
    projectGuideSource = guide.source;
    text = spliceGeneratedSection(withNotes, PROJECT_GUIDE_MARKER, renderProjectGuideSection(guide.text));
  }
  return { text, baseSource, overlaySource, projectGuideSource };
}
