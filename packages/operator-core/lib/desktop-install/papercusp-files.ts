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
import { spliceAtMarker, spliceToolingOverlay, spliceGeneratedSection, WIRE_SCHEMAS_MARKER, COORD_LEGEND_MARKER, WORKSPACE_MAP_MARKER, PROMOTION_MODEL_MARKER, PROJECT_GUIDE_MARKER, AUTO_MODE_MARKER, COMPACTION_MARKER, COMPACTION_CLIENT_OVERLAY_MARKER } from './splice-tooling-overlay';
import { renderModesPolicy } from '../operating-modes-policy';
import { renderDeployPipelineNote } from '../deploy-pipeline-policy';
import { renderWaitLoopNote } from '../wait-loop-policy';
import { renderPeerWakeNote } from '../peer-wake-policy';
import { renderWorkspaceMapSection } from './workspace-map';
import { renderPromotionModelSection } from './promotion-model';
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
  /** ~/.papercusp/compaction-strategy.md — Claude compaction floor (base+claude
   *  overlay), @import-ed by ~/.claude/CLAUDE.md's `# Compact Instructions`. */
  compactionStrategyPath: string;
  /** ~/.papercusp/bin — user-writable dir for the on-PATH CLI shims. */
  binDir: string;
  /** ~/.papercusp/bin/psu — superuser launcher shim → the bundled psu.mjs. */
  psuPath: string;
  /** ~/.papercusp/bin/ptool — defineTool CLI shim → the bundled ptool.mjs. */
  ptoolPath: string;
  /** ~/.papercusp/bin/papercusp — `papercusp <setup|tutorial>` dispatcher (onboard = alias of setup) →
   *  the bundled onboard.mjs concierge (agent-first-onboarding P-014). */
  papercuspCliPath: string;
  /** ~/Applications/Papercusp Tutorial.app — macOS-only clickable launcher that opens a
   *  Terminal window running `papercusp tutorial` (windows-macos-tutorial-shortcut-parity
   *  2026-07-04, WI-2197 — macOS/Dock-Applications parity with the Linux .desktop icon). */
  macTutorialAppPath: string;
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
  /** True when the compaction-strategy.md floor was rendered + written. */
  compactionStrategyWritten: boolean;
  /** Where the playbook source was read from. Empty when not found. */
  playbookSource: string;
  /** Where the extension source was read from. Empty when not found. */
  extensionSource: string;
  /** True when the `psu` shim was written (bundled/dev launcher resolved). */
  psuShimWritten: boolean;
  /** True when the `ptool` shim was written. */
  ptoolShimWritten: boolean;
  /** True when the `papercusp` dispatcher shim was written (P-014). */
  papercuspCliWritten: boolean;
  /** True when the macOS "Papercusp Tutorial.app" wrapper was written (darwin only, WI-2197). */
  macTutorialAppWritten: boolean;
  /** Resolved psu launcher the shim points at. Empty when not found. */
  psuLauncherSource: string;
  /** Resolved ptool launcher the shim points at. Empty when not found. */
  ptoolLauncherSource: string;
  /** Resolved onboarding-concierge launcher the dispatcher points at. Empty when not found. */
  onboardLauncherSource: string;
  /** Shell-profile files updated to put ~/.papercusp/bin on PATH (empty if none). */
  pathProfilesUpdated: string[];
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

/** Read the agent self-management compaction protocol
 *  (`papercusp-compaction.protocol.md`) beside the base playbook; missing → ''
 *  (the marker is still removed, never shipped literally). Client-neutral — the
 *  same protocol for every agent. agent-managed-compaction-2026-07-01. */
async function readCompactionProtocol(baseSrc: string, overlayDir?: string): Promise<string> {
  const p = path.join(overlayDir ?? path.dirname(baseSrc), 'papercusp-compaction.protocol.md');
  try {
    return (await fs.readFile(p, 'utf8')).replace(/\n+$/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render the Claude compaction floor: papercusp-compaction.base.md with the
 * papercusp-compaction.claude.md overlay spliced at COMPACTION_CLIENT_OVERLAY_MARKER,
 * leading HTML comments stripped. Written to ~/.papercusp/compaction-strategy.md and
 * @import-ed by CLAUDE.md's `# Compact Instructions`. Empty base -> '' (nothing to
 * write). agent-managed-compaction-2026-07-01.
 */
export async function renderCompactionStrategy(promptsDir: string): Promise<string> {
  const base = await readNonEmptyFile(path.join(promptsDir, 'papercusp-compaction.base.md'));
  if (!base) return '';
  const overlay = await readNonEmptyFile(path.join(promptsDir, 'papercusp-compaction.claude.md'));
  const overlayBody = overlay ? overlay.replace(/^<!--[\s\S]*?-->\s*/, '').trim() : '';
  const spliced = spliceAtMarker(base, COMPACTION_CLIENT_OVERLAY_MARKER, overlayBody);
  const body = spliced.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  // GENERATED artifact — stamp a do-not-hand-edit banner (drift guard, P-010).
  const banner =
    '<!-- GENERATED — do not hand-edit. Edit apps/operator/prompts/papercusp-compaction.base.md' +
    ' (+ .claude.md overlay), then reinstall. agent-managed-compaction-2026-07-01. -->';
  return `${banner}\n\n${body}`;
}

/**
 * Ensure `<home>/.claude/CLAUDE.md` carries a managed `# Compact Instructions`
 * stanza that @import-s the rendered compaction-strategy.md (the Claude compaction
 * floor). Idempotent + marker-delimited so it never clobbers the owner's own
 * CLAUDE.md; re-running replaces only the managed block. Best-effort — a failure
 * never breaks the install. agent-managed-compaction-2026-07-01.
 */
async function ensureClaudeCompactImport(home: string, strategyPath: string): Promise<boolean> {
  const claudeDir = path.join(home, '.claude');
  const claudeMd = path.join(claudeDir, 'CLAUDE.md');
  const BEGIN = '<!-- PAPERCUSP-COMPACTION:BEGIN (managed — do not edit) -->';
  const END = '<!-- PAPERCUSP-COMPACTION:END -->';
  const block = `${BEGIN}\n# Compact Instructions\n\n@${strategyPath}\n${END}`;
  try {
    await fs.mkdir(claudeDir, { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(claudeMd, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
    const next = re.test(existing)
      ? existing.replace(re, block)
      : existing.replace(/\n+$/, '') + (existing.trim() ? '\n\n' : '') + block + '\n';
    if (next !== existing) {
      await fs.writeFile(claudeMd, next, { mode: 0o644 });
    }
    return true;
  } catch {
    return false;
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
 * Project the shared, cross-cutting BEHAVIORAL notes — canonical constants owned by
 * `@papercusp/orchestrator` (re-exported through operator-core's policy wrappers) — into the
 * su playbook from the SINGLE source. Currently `DEPLOY_PIPELINE_NOTE` (the "deploy pipeline is
 * async; a RED gate is EVERYONE's job to FIX, no owner-ask, even out of lane" directive),
 * `WAIT_LOOP_NOTE` (the "waiting on something? arm a self-wake LOOP — never sleep on an event that
 * may never fire; re-check + FIX what's preventing it" directive), and `PEER_WAKE_NOTE` (the "you can
 * WAKE a peer; a parked agent sleeps until something re-invokes it, so handing work off is not enough"
 * directive) — all of which the su base playbook otherwise misses entirely while the spawned-bee +
 * operator-launched bases already inject them programmatically (prompt-build.ts / prompt-assembly.ts).
 * This keeps such universal directives
 * in ONE place that projects to EVERY base, model/provider-agnostic (plain strings spliced
 * regardless of model), ADDITIVELY — su's existing condensed notes and the `.md` prompt files are
 * left untouched. Inserted just before the project-guide section so they sit in the playbook body,
 * not buried under the 600-line guide.
 */
function injectSharedBaseNotes(text: string): string {
  // Anchor on the project-guide marker: it is the one marker still un-spliced at this point AND a
  // reliable "this is a real su playbook" signal (engineer/power carry it; minimal/test bases do
  // not). Insert the notes just BEFORE it; NEVER append, so a marker-less base is returned untouched
  // (mirrors spliceGeneratedSection's no-append contract).
  if (!text.includes(PROJECT_GUIDE_MARKER)) return text;
  const notes = [renderDeployPipelineNote(), renderWaitLoopNote(), renderPeerWakeNote()].filter((n) => n && n.trim());
  if (notes.length === 0) return text;
  return text.split(PROJECT_GUIDE_MARKER).join(`${notes.join('\n\n')}\n\n${PROJECT_GUIDE_MARKER}`);
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
  // per-hive-git-and-release-gate P-012: the staging→main promotion contract, generated
  // from the same release-gate config (non-coding hives render nothing → marker removed).
  out = spliceGeneratedSection(out, PROMOTION_MODEL_MARKER, renderPromotionModelSection());
  // Operating modes (AUTO act-don't-ask switch + its AUTO↔loop relationship, plus the IDEATE
  // invent-vs-patch switch and the AUTO×IDEATE composition table) — profile-agnostic, so both
  // engineer + power get the one canonical clause spliced here at the (still-named) AUTO marker.
  out = spliceGeneratedSection(out, AUTO_MODE_MARKER, renderModesPolicy());
  // agent-managed-compaction: the agent self-management compaction protocol (client-neutral).
  out = spliceGeneratedSection(out, COMPACTION_MARKER, await readCompactionProtocol(baseSrc));
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

/**
 * Candidate launcher paths for the on-PATH CLI shims (psu / ptool). The
 * shipped sidecar bundles esbuild outputs at `<root>/scripts/psu.mjs` +
 * `ptool.mjs` (build-desktop-sidecar.sh); the dev repo has the un-bundled
 * sources at `apps/operator/scripts/psu-launcher.mjs` + `ptool.mjs`. `names`
 * is ordered bundled-first, dev-second, so a real packaged build always
 * prefers its self-contained bundle. Mirrors playbookCandidates' root list
 * (operatorAppRoot first, then process.cwd()-rooted fallbacks for the esbuild
 * sidecar layout where __dirname collapses to sidecar/).
 */
function cliLauncherCandidates(operatorAppRoot: string, explicitRoot: boolean, names: string[]): string[] {
  const roots = explicitRoot
    ? [path.join(operatorAppRoot, 'scripts')]
    : [
        path.join(operatorAppRoot, 'scripts'),
        path.join(process.cwd(), 'scripts'),
        path.join(process.cwd(), 'apps', 'operator', 'scripts'),
      ];
  // Names-outer so the bundled name wins in EVERY root before the dev name is tried.
  return names.flatMap((n) => roots.map((r) => path.join(r, n)));
}

/**
 * Write an executable bash shim that `exec node`s the resolved launcher.
 * Same shape as the `psu`/`ptool` shims install-standalone-mcp.sh writes for
 * dev, but pointed at the bundled launcher in the shipped runtime. Refreshed
 * every boot so an app update re-points the shim at the new bundle. The
 * launcher path is double-quoted (JSON.stringify) so a path with spaces
 * survives — these shims run under bash on macOS / Linux / the WSL distro.
 */
async function writeShim(shimPath: string, launcherPath: string, label: string): Promise<boolean> {
  // Use the BUNDLED node (sidecar/bin/node, next to scripts/<launcher>) by
  // absolute path, NOT a bare `node`. An end user running this from a plain
  // macOS Terminal almost never has Node on PATH — `exec node …` then fails
  // with "command not found: node" even though the shim itself resolves. Fall
  // back to PATH `node` only in a dev/unbundled layout where the bundled node
  // isn't present (the dev box has node on PATH).
  const bundledNode = path.join(path.dirname(path.dirname(launcherPath)), 'bin', 'node');
  const nodeCmd = (await pathExists(bundledNode)) ? bundledNode : 'node';
  const body =
    '#!/usr/bin/env bash\n' +
    `# papercusp ${label} shim — managed by Papercusp.app (installPapercuspFiles).\n` +
    '# Refreshed on every boot; do not edit. Execs the bundled Node launcher.\n' +
    // The agent backend (claude, installed by the official claude.ai/install.sh
    // into ~/.local/bin) must be resolvable by the launcher's pty.spawn('claude').
    // The WSL2 distro's login PATH omits ~/.local/bin, so a console-launched psu
    // failed with `execvp("claude"): No such file or directory` even though the
    // setup wizard's detectClaude() reported it installed (found live on the
    // Windows VM 2026-07-04, WI-2149). Prepending here is a harmless no-op on
    // macOS/Linux, where ~/.local/bin is already on PATH.
    'export PATH="$HOME/.local/bin:$PATH"\n' +
    `exec ${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)} "$@"\n`;
  await fs.writeFile(shimPath, body, { mode: 0o755 });
  // writeFile honors mode only on creation; chmod to guarantee on overwrite.
  await fs.chmod(shimPath, 0o755);
  return true;
}

/**
 * Write the `papercusp` end-user dispatcher shim (agent-first-onboarding
 * P-014): `papercusp setup` (alias `onboard`) runs the terminal onboarding
 * concierge, `papercusp tutorial` re-opens the guided tutorial (concierge
 * --tutorial). Both reach the same unified shell (owner batch #4/#5).
 * Same node-resolution rules as writeShim. The Linux .deb writes a system
 * twin at /usr/bin/papercusp (deb/postinstall.sh); this per-user copy covers
 * macOS + dev boxes, where installPapercuspFiles is the install path.
 */
async function writeDispatcherShim(shimPath: string, launcherPath: string): Promise<boolean> {
  const bundledNode = path.join(path.dirname(path.dirname(launcherPath)), 'bin', 'node');
  const nodeCmd = (await pathExists(bundledNode)) ? bundledNode : 'node';
  const body =
    '#!/usr/bin/env bash\n' +
    '# papercusp CLI dispatcher — managed by Papercusp.app (installPapercuspFiles).\n' +
    '# Refreshed on every boot; do not edit.\n' +
    'cmd="${1:-}"\n' +
    'case "$cmd" in\n' +
    // `setup` and `tutorial` both open the SAME unified Tutorial|Setup shell — they
    // just default to a different tab (owner batch #4/#5: "Papercusp Setup" & "Papercusp
    // Tutorial" reach the same place, with tabs for both). `onboard` is the desktop's
    // AUTO first-boot linear concierge (kept as a back-compat alias for direct use).
    `  setup)    shift; exec ${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)} --tab=setup "$@" ;;\n` +
    `  tutorial) shift; exec ${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)} --tutorial "$@" ;;\n` +
    `  onboard)  shift; exec ${JSON.stringify(nodeCmd)} ${JSON.stringify(launcherPath)} "$@" ;;\n` +
    '  *)\n' +
    '    echo "usage: papercusp <setup|tutorial>"\n' +
    '    echo "  setup     open the Tutorial & Setup shell on the Setup tab"\n' +
    '    echo "  tutorial  open the Tutorial & Setup shell on the Tutorial tab"\n' +
    '    exit 2 ;;\n' +
    'esac\n';
  await fs.writeFile(shimPath, body, { mode: 0o755 });
  await fs.chmod(shimPath, 0o755);
  return true;
}

/**
 * Write a minimal, self-contained macOS `.app` bundle at
 * `~/Applications/Papercusp Tutorial.app` that double-clicks (Finder/Launchpad/
 * Spotlight) into a fresh Terminal (or iTerm, if installed) window running
 * `papercusp tutorial` (windows-macos-tutorial-shortcut-parity-2026-07-04,
 * WI-2197). Parity with the Linux .deb's third `.desktop` icon
 * (deb/postinstall.sh, agent-first-onboarding P-014) and the forthcoming
 * Windows Start-Menu entry (src-tauri/windows/fragments + hooks.nsh) — this is
 * the macOS leg, since a DMG has no postinstall-script hook to lean on the way
 * the .deb does, so it has to be provisioned here at first-run instead.
 *
 * `~/Applications` (NOT `/Applications`) so this needs no admin privilege —
 * it's a standard, LaunchServices/Spotlight-indexed per-user location, same
 * unprivileged-per-user posture as the rest of installPapercuspFiles.
 *
 * The bundle's own executable is a bash script (macOS doesn't require a
 * compiled binary — LaunchServices only needs CFBundleExecutable to be
 * executable) that mirrors native_console.rs's spawn_macos_new_window: write a
 * one-shot `.command` file and `open -na <Terminal.app|iTerm.app>` it, so a
 * REAL terminal window opens (a bare script would otherwise run invisibly in
 * the background).
 */
async function writeMacTutorialApp(appPath: string): Promise<boolean> {
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  await fs.mkdir(macosDir, { recursive: true });

  const infoPlist =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '  <key>CFBundleName</key><string>Papercusp Tutorial</string>\n' +
    '  <key>CFBundleDisplayName</key><string>Papercusp Tutorial &amp; Setup</string>\n' +
    '  <key>CFBundleIdentifier</key><string>com.papercusp.tutorial</string>\n' +
    '  <key>CFBundleVersion</key><string>1</string>\n' +
    '  <key>CFBundleShortVersionString</key><string>1.0</string>\n' +
    '  <key>CFBundlePackageType</key><string>APPL</string>\n' +
    '  <key>CFBundleExecutable</key><string>papercusp-tutorial</string>\n' +
    '  <key>LSMinimumSystemVersion</key><string>10.15</string>\n' +
    '  <key>LSUIElement</key><true/>\n' +
    '  <key>NSHighResolutionCapable</key><true/>\n' +
    '</dict>\n' +
    '</plist>\n';
  await fs.writeFile(path.join(contentsDir, 'Info.plist'), infoPlist, { mode: 0o644 });

  const executable =
    '#!/bin/bash\n' +
    '# Papercusp Tutorial launcher — managed by Papercusp.app (installPapercuspFiles).\n' +
    '# Refreshed on every boot; do not edit. Opens a Terminal window running\n' +
    '# `papercusp tutorial` (mirrors native_console.rs spawn_macos_new_window).\n' +
    'set -e\n' +
    'TMP="$(mktemp -t papercusp-tutorial).command"\n' +
    'cat > "$TMP" <<\'SCRIPT\'\n' +
    '#!/bin/bash\n' +
    'set -e\n' +
    'export PATH="$HOME/.papercusp/bin:$HOME/.local/bin:$PATH"\n' +
    '"$HOME/.papercusp/bin/papercusp" tutorial\n' +
    'SCRIPT\n' +
    'chmod +x "$TMP"\n' +
    'TERM_APP="Terminal.app"\n' +
    '[ -d "/Applications/iTerm.app" ] && TERM_APP="iTerm.app"\n' +
    'open -na "$TERM_APP" "$TMP"\n';
  const execPath = path.join(macosDir, 'papercusp-tutorial');
  await fs.writeFile(execPath, executable, { mode: 0o755 });
  await fs.chmod(execPath, 0o755);
  return true;
}

/**
 * Ensure ~/.papercusp/bin is on the user's shell PATH so `psu` / `ptool` work in
 * ANY terminal the user opens — not only the in-app "+" console (which sets PATH
 * itself). Appends an idempotent, marker-guarded block to the common login +
 * interactive shell profiles; the `case` guard makes the export a no-op when the
 * dir is already on PATH (safe across multiple sourcings). Only profiles that
 * already exist are touched, except when the user has NO profile at all (fresh
 * account) — then ~/.zprofile is seeded (zsh is the macOS default).
 * (psu-in-desktop-builds: "access psu from whatever the native console is".)
 */
async function ensureBinOnPath(home: string, binDir: string): Promise<string[]> {
  const marker = '# papercusp psu PATH (managed by Papercusp.app)';
  const block =
    `\n${marker} >>>\n` +
    `case ":$PATH:" in *":${binDir}:"*) ;; *) export PATH="${binDir}:$PATH" ;; esac\n` +
    `# papercusp psu PATH <<<\n`;
  const touched: string[] = [];
  let anyExisting = false;
  for (const name of ['.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile']) {
    const fp = path.join(home, name);
    let content: string | null = null;
    try {
      content = await fs.readFile(fp, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (content === null) continue; // don't create a profile that isn't there
    anyExisting = true;
    if (content.includes(marker)) continue; // already added — idempotent
    await fs.writeFile(fp, content + block, { mode: 0o644 });
    touched.push(fp);
  }
  if (!anyExisting) {
    const fp = path.join(home, '.zprofile');
    await fs.writeFile(fp, block, { mode: 0o644 });
    touched.push(fp);
  }
  return touched;
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

/**
 * psu execs the chosen agent CLI BY NAME, expecting it on PATH — but a GUI
 * app's operator child rarely inherits the user's login PATH, so a `claude` /
 * `codex` installed under `~/.local/bin` (etc.) is invisible and `psu → claude`
 * exits immediately ("can't launch the agent"). `~/.papercusp/bin` IS on psu's
 * PATH (ensureBinOnPath), so symlink any agent CLI we find there. Best-effort +
 * idempotent. (`omp`/`gh` ship bundled in the sidecar; a CLI absent everywhere
 * is the WI-681 install gap, surfaced separately — not something we can link.)
 */
async function ensureAgentClisLinked(home: string, binDir: string): Promise<string[]> {
  const linked: string[] = [];
  const searchDirs = [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.cargo', 'bin'),
  ];
  for (const agent of ['claude', 'codex']) {
    const dest = path.join(binDir, agent);
    try {
      await fs.access(dest);
      continue; // already linked/present
    } catch {
      /* not there yet — try to link it */
    }
    for (const dir of searchDirs) {
      const src = path.join(dir, agent);
      try {
        await fs.access(src);
        await fs.symlink(src, dest);
        linked.push(agent);
        break;
      } catch {
        /* not in this dir / link failed — try next */
      }
    }
  }
  return linked;
}

export function resolveInstallPaths(home: string): InstallPaths {
  const papercuspDir = path.join(home, '.papercusp');
  const binDir = path.join(papercuspDir, 'bin');
  return {
    papercuspDir,
    tokenPath: path.join(papercuspDir, 'superuser-token'),
    agentIdPath: path.join(papercuspDir, 'su-agent-id'),
    playbookPath: path.join(papercuspDir, 'engineer-collaborator.md'),
    extensionPath: path.join(papercuspDir, 'papercusp-coord.ts'),
    compactionStrategyPath: path.join(papercuspDir, 'compaction-strategy.md'),
    binDir,
    psuPath: path.join(binDir, 'psu'),
    ptoolPath: path.join(binDir, 'ptool'),
    papercuspCliPath: path.join(binDir, 'papercusp'),
    macTutorialAppPath: path.join(home, 'Applications', 'Papercusp Tutorial.app'),
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
  // psu/ptool launchers — bundled (psu.mjs/ptool.mjs) first, dev source second.
  const psuLauncherSource = await firstExisting(
    cliLauncherCandidates(operatorAppRoot, explicitRoot, ['psu.mjs', 'psu-launcher.mjs']),
  );
  const ptoolLauncherSource = await firstExisting(
    cliLauncherCandidates(operatorAppRoot, explicitRoot, ['ptool.mjs']),
  );
  // Onboarding concierge — bundled (onboard.mjs) first, dev source second (P-014).
  const onboardLauncherSource = await firstExisting(
    cliLauncherCandidates(operatorAppRoot, explicitRoot, ['onboard.mjs', 'onboard-launcher.mjs']),
  );

  const paths = resolveInstallPaths(home);

  await fs.mkdir(paths.papercuspDir, { recursive: true, mode: 0o700 });

  const token = await ensureSecret(paths.tokenPath, mintToken);
  const agentId = await ensureSecret(paths.agentIdPath, mintAgentId);

  // Playbook: splice the OMP overlay at the marker (NOT a raw copy —
  // the marker-model base is incomplete on its own). Extension: raw
  // copy (coord-hook.ts has no overlay).
  const playbookWritten = playbookSource ? await writeSplicedPlaybook(playbookSource, paths.playbookPath) : false;
  const extensionWritten = extensionSource ? await copyIfExists(extensionSource, paths.extensionPath) : false;

  // agent-managed-compaction: render the Claude compaction floor (base + claude overlay)
  // to ~/.papercusp/compaction-strategy.md and @import it from ~/.claude/CLAUDE.md's
  // `# Compact Instructions` (the only supported persistent Claude compaction hook).
  // Best-effort; never blocks install. The compaction .md files sit beside the playbook.
  let compactionStrategyWritten = false;
  if (playbookSource) {
    const strategy = await renderCompactionStrategy(path.dirname(playbookSource));
    if (strategy) {
      await fs.writeFile(paths.compactionStrategyPath, strategy + '\n', { mode: 0o644 });
      compactionStrategyWritten = true;
      await ensureClaudeCompactImport(home, paths.compactionStrategyPath);
    }
  }

  // On-PATH CLI shims (psu-in-desktop-builds-2026-06-23 A2). Written only when
  // the launcher actually resolves — a dev repo or a packaged build that bundled
  // them. The native-console terminal prepends ~/.papercusp/bin to PATH (A2b),
  // so `psu` / `ptool` are then runnable from the in-app terminal. The shims are
  // the launcher only; what the discoverable end-user entry exposes + which
  // profile psu launches with are gated separately (FLAGS.PSU_END_USER + the
  // scoped `user` profile, C1/C2).
  await fs.mkdir(paths.binDir, { recursive: true, mode: 0o700 });
  const psuShimWritten = psuLauncherSource ? await writeShim(paths.psuPath, psuLauncherSource, 'superuser launcher (psu)') : false;
  const ptoolShimWritten = ptoolLauncherSource
    ? await writeShim(paths.ptoolPath, ptoolLauncherSource, 'defineTool CLI (ptool)')
    : false;
  const papercuspCliWritten = onboardLauncherSource
    ? await writeDispatcherShim(paths.papercuspCliPath, onboardLauncherSource)
    : false;
  // Put ~/.papercusp/bin on the user's shell PATH so psu/ptool resolve in ANY
  // terminal they open (the in-app "+" console sets PATH itself, but a plain
  // Terminal does not). Only when a shim actually landed.
  const pathProfilesUpdated =
    psuShimWritten || ptoolShimWritten || papercuspCliWritten
      ? await ensureBinOnPath(home, paths.binDir)
      : [];

  // Link any user-installed agent CLIs (claude/codex) into the psu bin dir so
  // `psu → <agent>` launches out of the box — without this, a fresh install
  // where claude lives in ~/.local/bin makes psu exit immediately (can't exec it).
  await ensureAgentClisLinked(home, paths.binDir);

  // macOS Tutorial.app wrapper (WI-2197): only where it means something (darwin)
  // and only once the dispatcher it invokes actually landed — a DMG install has
  // no postinstall-script hook, so this is provisioned here at first boot,
  // mirroring the Linux .deb's third `.desktop` icon.
  const macTutorialAppWritten =
    process.platform === 'darwin' && papercuspCliWritten ? await writeMacTutorialApp(paths.macTutorialAppPath) : false;

  return {
    ...paths,
    minted: { token: token.minted, agentId: agentId.minted },
    playbookWritten,
    extensionWritten,
    compactionStrategyWritten,
    playbookSource: playbookWritten && playbookSource ? playbookSource : '',
    extensionSource: extensionWritten && extensionSource ? extensionSource : '',
    psuShimWritten,
    ptoolShimWritten,
    papercuspCliWritten,
    macTutorialAppWritten,
    psuLauncherSource: psuShimWritten && psuLauncherSource ? psuLauncherSource : '',
    ptoolLauncherSource: ptoolShimWritten && ptoolLauncherSource ? ptoolLauncherSource : '',
    onboardLauncherSource: papercuspCliWritten && onboardLauncherSource ? onboardLauncherSource : '',
    pathProfilesUpdated,
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
  /**
   * Persona TIER (context-trimming-tiers P-017). 'full' (default) = today's
   * playbook, byte-identical. 'fleet' = the fleet-member tier rendered from
   * the SAME base: FULL-ONLY tagged sections stripped (orientation, named
   * workflows, mid-call interactivity), the AUTO clause compacted + IDEATE
   * dropped (renderModesPolicy('fleet')), and the wire-schema legend filtered
   * to the coordination/work-item/plan/lock spine. The engineering-discipline
   * + shared-dev-environment + project-guide spine is KEPT — fleet members
   * code in the repo.
   */
  tier?: 'full' | 'fleet';
}

/** FULL-ONLY section tags (P-017): content between these comment markers is
 *  stripped from the FLEET persona tier. Author them in the base .tools.md
 *  (or inside a generated section) around owner-facing / leader-only prose. */
export const PLAYBOOK_FULL_ONLY_BEGIN = '<!-- PAPERCUSP-SU:FULL-ONLY:BEGIN -->';
export const PLAYBOOK_FULL_ONLY_END = '<!-- PAPERCUSP-SU:FULL-ONLY:END -->';

/** Remove just the FULL-ONLY marker COMMENT lines (full tier keeps the content;
 *  no internal marker may leak into a rendered prompt — the psu-prompt-isolation
 *  invariant). */
export function stripFullOnlyMarkers(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== PLAYBOOK_FULL_ONLY_BEGIN && t !== PLAYBOOK_FULL_ONLY_END;
    })
    .join('\n');
}

/** Strip every FULL-ONLY tagged block (fleet tier). Unbalanced tags fail soft:
 *  a BEGIN with no END strips nothing further (never truncate the tail). */
export function stripFullOnlySections(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const b = rest.indexOf(PLAYBOOK_FULL_ONLY_BEGIN);
    if (b === -1) return out + rest;
    const e = rest.indexOf(PLAYBOOK_FULL_ONLY_END, b);
    if (e === -1) return out + rest; // unbalanced — keep everything
    out += rest.slice(0, b).replace(/\n+$/, '\n');
    rest = rest.slice(e + PLAYBOOK_FULL_ONLY_END.length).replace(/^\n+/, '\n');
  }
}

/** The wire-schema families a FLEET member keeps (the coordination/work-item/
 *  plan/lock spine); every other tool's legend entry is full-tier only. */
const FLEET_WIRE_SCHEMA_FAMILIES = [
  'coord:',
  'work_items:',
  'plans:',
  'plan_items:',
  'locks:',
  'events:',
  'memory:',
  'improvements:',
];

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
  const tier = input.tier ?? 'full';
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
    // P-017: the fleet tier keeps only the spine families' legend entries.
    renderWireSchemasSection(
      tier === 'fleet'
        ? (name) => FLEET_WIRE_SCHEMA_FAMILIES.some((f) => name.startsWith(f))
        : undefined,
    ),
  );
  const withLegend = spliceGeneratedSection(withWire, COORD_LEGEND_MARKER, renderCoordLegend());
  const withMap = spliceGeneratedSection(withLegend, WORKSPACE_MAP_MARKER, renderWorkspaceMapSection());
  const withPromo = spliceGeneratedSection(withMap, PROMOTION_MODEL_MARKER, renderPromotionModelSection());
  // Operating modes are profile-agnostic (the AUTO act-don't-ask grant + its AUTO↔loop
  // relationship, plus the IDEATE invent-vs-patch switch and the AUTO×IDEATE table, apply to
  // every interactive su surface), so splice them BEFORE the engineer-only shared-base notes —
  // both engineer + power carry the marker and get the one canonical clause.
  const withAuto = spliceGeneratedSection(withPromo, AUTO_MODE_MARKER, renderModesPolicy(tier));
  // agent-managed-compaction: the agent self-management compaction protocol (client-neutral).
  const withCompaction = spliceGeneratedSection(
    withAuto,
    COMPACTION_MARKER,
    await readCompactionProtocol(baseSource, input.overlayDir),
  );
  // Only the ENGINEER profile works the Papercusp repo (where this pipeline + its green gate live);
  // the power profile manages an EXTERNAL repo, so the Papercusp-specific note does not apply there.
  const withNotes = profile === 'engineer' ? injectSharedBaseNotes(withCompaction) : withCompaction;
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
  // P-017 fleet tier: strip every FULL-ONLY tagged block (base + generated
  // sections alike). Applied LAST so tags survive every splice above. The
  // FULL tier keeps the content but drops the marker comment lines — no
  // internal marker leaks into a rendered prompt (psu-prompt-isolation).
  text = tier === 'fleet' ? stripFullOnlySections(text) : stripFullOnlyMarkers(text);
  return { text, baseSource, overlaySource, projectGuideSource };
}
