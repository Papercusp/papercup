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
import * as TOML from '@iarna/toml';
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
  /** ~/.papercusp/bin/psu-sentinel — the 🛡 Sentinel dock pane launcher (EI-9935-adjacent
   *  WI-4244 fix): registers the pane for voice-transcript routing, applies a per-session
   *  model override, then execs the just-written `psu` shim with `--role=papercup`. Mirrors
   *  apps/operator/scripts/psu-sentinel.sh (the dev-repo source of truth for this logic),
   *  which was NEVER added to the on-boot shim set — the packaged app's dock layout invokes
   *  `psu-sentinel` by name (apps/tui/src/layout.rs) but nothing ever put it on PATH. */
  psuSentinelPath: string;
  /** ~/Applications/Papercusp Tutorial & Setup.app — macOS-only clickable launcher that opens a
   *  Terminal window running `papercusp tutorial` (windows-macos-tutorial-shortcut-parity
   *  2026-07-04, WI-2197 — macOS/Dock-Applications parity with the Linux .desktop icon). */
  macTutorialAppPath: string;
  /** ~/.local/share/applications/papercusp-tutorial.desktop — Linux-only per-user XDG
   *  launcher for the guided tutorial (the .deb writes a system twin under /usr/share). */
  linuxTutorialDesktopPath: string;
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
  /** True when the `psu-sentinel` dock-pane launcher shim was written (WI-4244). Only
   *  attempted when the `psu` shim itself was written this call — sentinel execs psu. */
  psuSentinelShimWritten: boolean;
  /** True when the macOS "Papercusp Tutorial & Setup.app" wrapper was written (darwin only, WI-2197). */
  macTutorialAppWritten: boolean;
  /** True when the Linux per-user tutorial `.desktop` launcher was written (linux only). */
  linuxTutorialDesktopWritten: boolean;
  /** True when the tutorial launcher was newly pinned to the GNOME dock this call (linux
   *  only; one-time via a marker so a later user un-pin is respected). */
  linuxTutorialPinned: boolean;
  /** Resolved psu launcher the shim points at. Empty when not found. */
  psuLauncherSource: string;
  /** Resolved ptool launcher the shim points at. Empty when not found. */
  ptoolLauncherSource: string;
  /** Resolved onboarding-concierge launcher the dispatcher points at. Empty when not found. */
  onboardLauncherSource: string;
  /** Shell-profile files updated to put ~/.papercusp/bin on PATH (empty if none). */
  pathProfilesUpdated: string[];
  /** The CC hook scripts copied to ~/.papercusp/hooks/cc/ this call (empty when the
   *  sources weren't shipped — the pre-EI-8191 Mac/Windows gap). */
  claudeHooksInstalled: string[];
  /** True when the CC hooks + fleet statusline were merged into ~/.claude/settings.json. */
  claudeSettingsMerged: boolean;
  /** True when [tui].status_line was merged into an existing ~/.codex/config.toml this call
   *  (false when codex isn't set up here or the user already configured their own status line). */
  codexStatusLineMerged: boolean;
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
 * The Claude/Codex CC hook scripts installed to `~/.papercusp/hooks/cc/`. Kept in
 * sync with install-standalone-mcp.sh's `CC_HOOK_*` set (the dev/Linux installer)
 * AND build-desktop-sidecar.sh (which ships these sources into the packaged bundle).
 * `pretooluse-locks-acquire.sh` MUST stay first — it is the presence gate for the
 * whole set (mirrors the bash `[ -f … ]` guard). `posttooluse-objective-title.sh` is
 * copied for parity but, like the bash installer, is not registered in settings.json.
 */
const CC_HOOK_FILES = [
  'pretooluse-locks-acquire.sh',
  'posttooluse-locks-release.sh',
  'posttooluse-coord-inbox.sh',
  'posttooluse-activity-report.sh',
  'pretooluse-activity-report.sh',
  'lifecycle-report.sh',
  'statusline-fleet.sh',
  'posttooluse-objective-title.sh',
  'pretooluse-bash-resource-gate.sh',
  'workitem-verify-nudge.sh',
  // turn-provenance-owner-vs-agent-2026-07-11 P-003: classify every submitted
  // prompt against the injectors' envelope+nonce ledger → additionalContext
  // stamp (VERIFIED agent-origin / UNVERIFIED claim / affirmative OWNER).
  'userpromptsubmit-provenance.sh',
  // Shared python lib, NOT a hook: statusline-fleet.sh + posttooluse-objective-title.sh
  // `import pc_tty` off their own dirname to resolve the terminal they title. Omit it and
  // both raise ImportError, fail OPEN, and the packaged app silently stops setting the
  // terminal title (WI-3665 — the EI-8191 shape: fail-open is indistinguishable from
  // success). It is imported, never executed, so installClaudeHooks installs it 0644.
  'pc_tty.py',
] as const;

/** Hook files that are LIBRARIES, not executables — installed 0644, never chmod +x. */
const CC_HOOK_LIB_FILES: ReadonlySet<string> = new Set(['pc_tty.py']);

/**
 * Candidate DIRS for the CC hook sources — the bundled sidecar layout first
 * (`<operatorAppRoot>/scripts/hooks/cc`), then the dev-repo fallback. Mirrors
 * `extensionCandidates` (the omp coord-hook resolver); esbuild can't trace these
 * fs-read scripts, so build-desktop-sidecar.sh copies the dir verbatim.
 */
function ccHookDirCandidates(operatorAppRoot: string, explicitRoot: boolean): string[] {
  const fromRoot = [path.join(operatorAppRoot, 'scripts', 'hooks', 'cc')];
  if (explicitRoot) return fromRoot;
  return [...fromRoot, path.join(process.cwd(), 'apps', 'operator', 'scripts', 'hooks', 'cc')];
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
 * Resolve the node binary a CLI shim should exec. Prefer the BUNDLED node over
 * a bare PATH `node` (end users — a macOS Terminal, a WSL distro, a fresh Linux
 * dogfood install — rarely have node on PATH; bare `node` → "node not found",
 * WI-3334). Anchors, checked in order — the first that exists wins:
 *   1. `$PAPERCUSP_SIDECAR_BIN/node` — the explicit sidecar-bin path the app
 *      exports to serve.mjs (and inherits to children). Canonical + cwd-independent.
 *   2. `process.execPath` — the node binary running THIS process. On a packaged
 *      install that IS the bundled sidecar node (Tauri spawns serve.mjs with
 *      `sidecar/bin/node`); on a dev box it's a valid node too. Existence- and
 *      cwd-independent.
 *   3. next to the launcher: `<dirname(dirname(launcher))>/bin/node` — the
 *      bundled `sidecar/scripts/<launcher>` → `sidecar/bin/node` layout.
 *   4. the sidecar root: `<cwd>/bin/node` — a last-ditch anchor for the case
 *      where serve.mjs's cwd happens to be the sidecar dir.
 * Falls back to PATH `node` only when none resolve (a dev/unbundled layout).
 *
 * WI-3334 history: the original fix used only anchors 3+4. But when the launcher
 * resolved to the extracted dev-source tree (`<dev-source>/apps/operator/scripts`),
 * anchor 3's grandparent (`<dev-source>/apps/operator`) has no `bin/node`, AND
 * installPapercuspFiles does NOT always run with cwd = the sidecar dir, so anchor
 * 4 missed too → the shim fell back to bare `node` on a real packaged install
 * (verified on the Linux dogfood VM). Anchors 1+2 are cwd-independent, so they hold.
 */
export async function resolveShimNode(launcherPath: string): Promise<string> {
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  const execBase = path.basename(process.execPath).toLowerCase();
  const execIsNode = execBase === 'node' || execBase === 'node.exe';
  const candidates = [
    sidecarBin ? path.join(sidecarBin, 'node') : '',
    execIsNode ? process.execPath : '',
    path.join(path.dirname(path.dirname(launcherPath)), 'bin', 'node'),
    path.join(process.cwd(), 'bin', 'node'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return 'node';
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
  const nodeCmd = await resolveShimNode(launcherPath);
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
  const nodeCmd = await resolveShimNode(launcherPath);
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
 * `~/Applications/Papercusp Tutorial & Setup.app` that double-clicks (Finder/Launchpad/
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
  // WI-2945: the mac DMGs now BAKE a "Papercusp Tutorial.app" at build time
  // (papercusp-desktop/bin/mac-vm-build.sh — same bundle id com.papercusp.tutorial,
  // same launcher script; keep the two generators in sync). When the user dragged
  // that copy into /Applications, don't write a second one into ~/Applications —
  // LaunchServices would surface two identical apps. This first-boot write remains
  // the fallback for installs that skipped dragging the tutorial app.
  for (const installed of [
    '/Applications/Papercusp Tutorial.app',
    '/Applications/Papercusp Tutorial & Setup.app',
  ]) {
    if (await pathExists(installed)) return false;
  }
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  await fs.mkdir(macosDir, { recursive: true });

  const infoPlist =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '  <key>CFBundleName</key><string>Papercusp Tutorial &amp; Setup</string>\n' +
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
 * Write a per-user XDG `.desktop` launcher at
 * `~/.local/share/applications/papercusp-tutorial.desktop` — the LINUX leg of the
 * tutorial-icon parity (owner 2026-07-06: "how come I still don't see the icon on my
 * taskbar in this dev box", 4th report). Until now the tutorial icon was provisioned
 * ONLY by the .deb postinstall (deb/postinstall.sh, into the ROOT /usr/share) and by
 * macOS `writeMacTutorialApp` — so a Linux DEV box or ANY non-.deb Linux install
 * (a tarball, `npm run dev`, a hand-run operator) got NO tutorial icon at all. This is
 * the first-boot equivalent, mirroring `writeMacTutorialApp`: an UNPRIVILEGED per-user
 * dir (no root, unlike the .deb), `Exec` pointed at the per-user dispatcher shim, and
 * `Terminal=true` so the DE opens a real terminal running `papercusp tutorial`.
 *
 * Icon: install a real PNG into the user hicolor theme and reference it by ABSOLUTE
 * path (robust — no icon-cache refresh needed); if no source PNG resolves, fall back to
 * the themed name `papercusp-desktop` (what the .deb + Tauri bundle install). The entry
 * appears in the app grid; pinning it to a dock/taskbar is the user's/DE's choice (the
 * .deb doesn't auto-pin either). Best-effort throughout — never breaks the install.
 */
export async function writeLinuxTutorialDesktopEntry(
  desktopPath: string,
  papercuspCliPath: string,
  home: string,
  operatorAppRoot: string,
): Promise<boolean> {
  try {
    const appsDir = path.dirname(desktopPath);
    await fs.mkdir(appsDir, { recursive: true });

    // Best-effort: install a real icon PNG into the user hicolor theme; reference it by
    // absolute path so it renders even without a gtk-update-icon-cache pass.
    let iconRef = 'papercusp-desktop'; // themed-name fallback (.deb / Tauri bundle install it)
    const iconSrc = await firstExisting([
      path.resolve(operatorAppRoot, '..', '..', 'papercusp-desktop', 'src-tauri', 'icons', '128x128.png'),
      path.resolve(operatorAppRoot, 'papercusp-desktop', 'src-tauri', 'icons', '128x128.png'),
      path.join(operatorAppRoot, 'icons', '128x128.png'),
      path.join(operatorAppRoot, 'resources', 'icons', '128x128.png'),
    ]);
    if (iconSrc) {
      const iconDst = path.join(home, '.local', 'share', 'icons', 'hicolor', '128x128', 'apps', 'papercusp-desktop.png');
      try {
        await fs.mkdir(path.dirname(iconDst), { recursive: true });
        await fs.writeFile(iconDst, await fs.readFile(iconSrc), { mode: 0o644 });
        iconRef = iconDst;
      } catch {
        /* keep the themed-name fallback */
      }
    }

    // A path with spaces must be double-quoted per the freedesktop Exec spec.
    const execBin = papercuspCliPath.includes(' ') ? `"${papercuspCliPath}"` : papercuspCliPath;
    const desktop =
      '[Desktop Entry]\n' +
      'Type=Application\n' +
      'Name=Papercusp Tutorial & Setup\n' +
      'Comment=Open the guided Papercusp tutorial and setup (tabs for both)\n' +
      `Exec=${execBin} tutorial\n` +
      `Icon=${iconRef}\n` +
      'Terminal=true\n' +
      'Categories=Development;\n' +
      'StartupNotify=true\n';
    await fs.writeFile(desktopPath, desktop, { mode: 0o644 });
    await fs.chmod(desktopPath, 0o644);

    // Refresh the desktop DB so the entry shows without a re-login (best-effort, detached).
    try {
      const { spawn } = await import('node:child_process');
      spawn('update-desktop-database', [appsDir], { stdio: 'ignore' }).on('error', () => {});
    } catch {
      /* not installed — the DE picks the entry up on its next scan */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a desktop-id to a GNOME `favorite-apps` gsettings array LITERAL, idempotently.
 * Pure/string-only so it is unit-testable without a session bus. Handles the shapes
 * gsettings emits: `['a.desktop', 'b.desktop']`, an empty `[]`, and the typed-empty
 * `@as []`. Returns the input unchanged (sans type annotation) when `id` is already
 * present, so callers never double-pin.
 */
export function appendGnomeFavorite(current: string, id: string): string {
  let s = (current || '').trim();
  if (s.startsWith('@as ')) s = s.slice(4).trim(); // drop the type annotation on empty arrays
  const item = `'${id}'`;
  if (s.includes(item)) return s; // already pinned — no-op (don't duplicate)
  if (s === '' || s === '[]') return `[${item}]`;
  const close = s.lastIndexOf(']');
  if (close < 0) return `[${item}]`;
  const inner = s.slice(s.indexOf('[') + 1, close).trim();
  return inner.length ? `[${inner}, ${item}]` : `[${item}]`;
}

/**
 * Auto-pin the tutorial launcher to the GNOME dock/taskbar (owner 2026-07-06, repeated
 * to a 5th report: "I still don't see the papercusp icon in my taskbar"). Writing the
 * `.desktop` only lands it in the app GRID — the owner wants it PINNED to the dock — so
 * this appends `papercusp-tutorial.desktop` to `org.gnome.shell.favorite-apps` (GNOME's
 * dock-favorites list) via gsettings.
 *
 * Pins exactly ONCE, guarded by `markerPath`: installPapercuspFiles re-runs on every
 * boot, and re-pinning every time would fight a user who deliberately un-pinned it — so
 * after the first attempt we drop a marker and never touch favorites again. Best-effort
 * and GNOME-only: silently no-ops when gsettings / the schema is absent (non-GNOME DE,
 * no session bus) and never throws (an install must not fail over a dock cosmetic).
 *
 * NOTE: on an already-running GNOME session the newly-pinned favorite only renders once
 * the shell has re-scanned `~/.local/share/applications` (a fresh app is registered via
 * its file monitor after `update-desktop-database`); a first-boot / fresh login always
 * shows it. This is why the dev box that had a shell running for days needed a manual
 * shell reload once — a normal install does not.
 */
export async function pinLinuxTutorialToDock(desktopId: string, markerPath: string): Promise<boolean> {
  try {
    // Pin-once gate: if we've already attempted a pin, respect any later user un-pin.
    try {
      await fs.access(markerPath);
      return false;
    } catch {
      /* not attempted yet — fall through */
    }

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const pexec = promisify(execFile);

    let current = '';
    try {
      const { stdout } = await pexec('gsettings', ['get', 'org.gnome.shell', 'favorite-apps']);
      current = stdout.trim();
    } catch {
      return false; // no gsettings / GNOME schema (non-GNOME DE, headless) — nothing to pin
    }

    const next = appendGnomeFavorite(current, desktopId);
    let pinned = false;
    if (next !== current.replace(/^@as\s+/, '').trim()) {
      try {
        await pexec('gsettings', ['set', 'org.gnome.shell', 'favorite-apps', next]);
        pinned = true;
      } catch {
        return false; // couldn't write — don't drop the marker, allow a retry next boot
      }
    }
    // Mark the one-time attempt as done (whether we added it or it was already present).
    try {
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, `${new Date().toISOString()}\n`, { mode: 0o644 });
    } catch {
      /* marker is best-effort; worst case we re-check (idempotent) next boot */
    }
    return pinned;
  } catch {
    return false;
  }
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

/**
 * Ensure `~/.papercusp/bin/gh` is a symlink to the currently-bundled `gh` CLI
 * (WI-3626). `buildGithubLoginSpec` (endpoint-route/routes/desktop/setup-pty-
 * commands.ts) resolves `gh` to sign in + run `gh auth setup-git`, which bakes
 * WHICHEVER path it resolved verbatim into `credential.https://github.com.helper`
 * in the user's `~/.gitconfig`. Without this shim, that resolution falls through
 * to an app-bundle-relative path (`<cwd>/bin/gh`, i.e. inside
 * `/Applications/Papercusp.app/Contents/Resources/sidecar/`) — which dangles the
 * instant the app is renamed or replaced (confirmed live on the Mac VM: the
 * bundle is now `Papercusp Server.app` / `Papercusp GUI.app`, no `Papercusp.app`
 * — EI-8793 rounds 1-2). `~/.papercusp/bin/gh` never moves, so gitconfig
 * referencing THAT path instead survives every future rename.
 *
 * Unlike `ensureAgentClisLinked` (link-once-if-missing — a user's own claude/
 * codex install rarely moves), this REFRESHES every boot: an app rename
 * between boots must re-point the symlink at the new bundle's gh, or the shim
 * itself would just reproduce the same dangling-path bug one level removed.
 * Idempotent (a no-op once already pointed correctly) + best-effort (a dev box
 * with no bundled gh in this run leaves any prior link untouched — never
 * removes a working link just because THIS run can't resolve a source).
 */
export async function ensureGhLinked(home: string, binDir: string): Promise<boolean> {
  const dest = path.join(binDir, 'gh');
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  const candidates = [
    sidecarBin ? path.join(sidecarBin, 'gh') : '',
    path.join(process.cwd(), 'bin', 'gh'),
    path.join(process.cwd(), '..', 'bin', 'gh'),
  ].filter(Boolean);
  let resolved: string | null = null;
  for (const c of candidates) {
    if (await pathExists(c)) {
      resolved = c;
      break;
    }
  }
  if (!resolved) return false; // no bundled gh visible this run — leave any prior link alone
  try {
    const current = await fs.readlink(dest);
    if (current === resolved) return false; // already correct — no-op
  } catch {
    /* not a symlink yet (missing, or a plain file/broken link) — fall through to (re)create */
  }
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rm(dest, { force: true });
    await fs.symlink(resolved, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * The BUNDLED node, resolved cwd-independently (a subset of resolveShimNode's
 * anchors — the two that don't depend on a launcher path). `null` when this
 * process can't see it (an extracted dev-source operator whose env lacks
 * PAPERCUSP_SIDECAR_BIN and whose execPath is a tsx wrapper, not plain `node`).
 */
export async function resolveBundledNode(): Promise<string | null> {
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  const execBase = path.basename(process.execPath).toLowerCase();
  const execIsNode = execBase === 'node' || execBase === 'node.exe';
  const candidates = [
    sidecarBin ? path.join(sidecarBin, 'node') : '',
    execIsNode ? process.execPath : '',
  ].filter(Boolean);
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

/**
 * WI-3334 (dev-source shim gap): the psu/ptool shims `exec node` after
 * `export PATH="$HOME/.local/bin:$PATH"`, expecting node in ~/.local/bin. But a
 * shim written where resolveShimNode fell back to bare `node` — the extracted
 * dev-source operator (no PAPERCUSP_SIDECAR_BIN, tsx execPath), verified on the
 * Linux all-5-buttons dogfood VM 2026-07-08 — then dies with `exec: node: not
 * found`. Nothing was creating the ~/.local/bin/node the shims lean on. Link the
 * bundled node there whenever THIS run can resolve it: the primary operator's
 * boot-time install run always can (PAPERCUSP_SIDECAR_BIN set), so the link
 * lands regardless of which operator later rewrites the shim. Non-clobbering
 * (leaves a user's own ~/.local/bin/node) + idempotent + best-effort.
 */
export async function ensureBundledNodeLinked(home: string): Promise<boolean> {
  const dest = path.join(home, '.local', 'bin', 'node');
  // A working node already there (user-installed binary or a live link)? Leave it.
  if (await pathExists(dest)) return false;
  const node = await resolveBundledNode();
  if (!node) return false;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rm(dest, { force: true }); // clear a DANGLING link (pathExists=false but the link file exists)
    await fs.symlink(node, dest);
    return true;
  } catch {
    return false;
  }
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
    macTutorialAppPath: path.join(home, 'Applications', 'Papercusp Tutorial & Setup.app'),
    linuxTutorialDesktopPath: path.join(home, '.local', 'share', 'applications', 'papercusp-tutorial.desktop'),
  };
}

type HookCommand = { type: 'command'; command: string };
type HookEntry = { matcher?: string; hooks: HookCommand[] };

/** Drop every COMMAND in `arr` that references one of `ours` (full path OR basename)
 *  — at the command level, not the whole entry — then append `fresh`. An entry that
 *  mixes one of ours with a FOREIGN command (e.g. a live settings.json's single Bash
 *  entry carrying both `pretooluse-bash-resource-gate.sh` AND a third-party `rtk hook
 *  claude`) keeps its foreign command; only entries left with ZERO commands after the
 *  filter are dropped. A whole-ENTRY drop silently destroyed a co-located foreign
 *  command on a real live settings.json (EI-8997 follow-up) — this is the fix. Mirrors
 *  the python is_ours filter used by every merge_* helper in install-standalone-mcp.sh
 *  (KEEP THE TWO IN SYNC — see that script's own merge_* comments). */
function replaceOurHookEntries(arr: HookEntry[], ours: readonly string[], fresh: HookEntry): HookEntry[] {
  const isOursCmd = (h: HookCommand) => ours.some((o) => String(h?.command ?? '').includes(o));
  const filtered = arr
    .map((e) => (Array.isArray(e?.hooks) ? { ...e, hooks: e.hooks.filter((h) => !isOursCmd(h)) } : e))
    .filter((e) => Array.isArray(e?.hooks) && e.hooks.length > 0);
  return [...filtered, fresh];
}

/**
 * Non-destructive, idempotent merge of the papercusp CC hooks + fleet statusline into a Claude
 * `settings.json` object (mutated + returned). FAITHFUL TS port of the merge_lock_hooks /
 * merge_coord_hook / merge_activity_hook / merge_lifecycle_hooks / merge_workitem_nudge_hook /
 * merge_statusline / merge_bash_gate_hook python helpers in
 * apps/operator/scripts/install-standalone-mcp.sh — KEEP THE TWO IN SYNC. For each event, any prior
 * entry pointing at OUR script (by full path OR basename) is dropped then a fresh one appended,
 * preserving every other user hook. `statusLine` is set only when absent or already ours (never
 * clobbers a personal one).
 *
 * `destDir` = the installed hook dir (~/.papercusp/hooks/cc). `present` = the hook basenames actually
 * installed (mirrors the bash `[ -x … ]` gates), so a missing source degrades gracefully. The
 * `PAPERCUSP_WORKSPACE_ROOT` env prefix the bash installer threads onto the lock/coord/bash-gate
 * commands is intentionally OMITTED: those hooks fall back to `~/papercupai-workspace` (== what the
 * bash installer computes on the standard layout) and self-gate on PAPERCUSP_SID, so behavior is
 * identical and the port stays cross-platform-simple. `isClaudeSettings` gates the Claude-only
 * `enableAllProjectMcpServers` flag. Exported for unit tests.
 */
export function mergeClaudeHookSettings(
  cfg: Record<string, any>,
  destDir: string,
  opts: { present?: ReadonlySet<string>; isClaudeSettings?: boolean } = {},
): Record<string, any> {
  const present = opts.present ?? new Set<string>(CC_HOOK_FILES);
  const has = (name: string) => present.has(name);
  const p = (name: string) => path.join(destDir, name);
  const ours = (name: string): readonly string[] => [p(name), name];
  const cmd = (name: string): HookCommand[] => [{ type: 'command', command: p(name) }];

  const hooks: Record<string, HookEntry[]> =
    cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : (cfg.hooks = {});
  const ev = (name: string): HookEntry[] => (Array.isArray(hooks[name]) ? hooks[name] : []);

  // merge_lock_hooks — PreToolUse + PostToolUse, matcher Edit|Write|MultiEdit.
  if (has('pretooluse-locks-acquire.sh') && has('posttooluse-locks-release.sh')) {
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-locks-acquire.sh'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('pretooluse-locks-acquire.sh'),
    });
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-locks-release.sh'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('posttooluse-locks-release.sh'),
    });
    // Claude-only: auto-approve project-scoped .mcp.json servers (operator-signed papercusp MCP).
    if (opts.isClaudeSettings) cfg.enableAllProjectMcpServers = true;
  }
  // merge_coord_hook — PostToolUse, matcher '*'.
  if (has('posttooluse-coord-inbox.sh'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-coord-inbox.sh'), {
      matcher: '*',
      hooks: cmd('posttooluse-coord-inbox.sh'),
    });
  // merge_activity_hook — PostToolUse, matcher '*'.
  if (has('posttooluse-activity-report.sh'))
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('posttooluse-activity-report.sh'), {
      matcher: '*',
      hooks: cmd('posttooluse-activity-report.sh'),
    });
  // merge_activity_pre_hook — PreToolUse, matcher '*' (EI-8997: a renewal signal
  // at dispatch time too, not just completion — see the script's own header).
  if (has('pretooluse-activity-report.sh'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-activity-report.sh'), {
      matcher: '*',
      hooks: cmd('pretooluse-activity-report.sh'),
    });
  // merge_lifecycle_hooks — SessionStart + SessionEnd, no matcher.
  if (has('lifecycle-report.sh'))
    for (const e of ['SessionStart', 'SessionEnd'])
      hooks[e] = replaceOurHookEntries(ev(e), ours('lifecycle-report.sh'), { hooks: cmd('lifecycle-report.sh') });
  // merge_workitem_nudge_hook — PostToolUse Edit|Write|MultiEdit + Stop + SessionEnd.
  if (has('workitem-verify-nudge.sh')) {
    hooks.PostToolUse = replaceOurHookEntries(ev('PostToolUse'), ours('workitem-verify-nudge.sh'), {
      matcher: 'Edit|Write|MultiEdit',
      hooks: cmd('workitem-verify-nudge.sh'),
    });
    for (const e of ['Stop', 'SessionEnd'])
      hooks[e] = replaceOurHookEntries(ev(e), ours('workitem-verify-nudge.sh'), { hooks: cmd('workitem-verify-nudge.sh') });
  }
  // merge_statusline — non-destructive: set only when absent or already ours.
  if (has('statusline-fleet.sh')) {
    const sl = p('statusline-fleet.sh');
    const existing = cfg.statusLine;
    const mine = existing && typeof existing === 'object' && String(existing.command ?? '').includes(sl);
    if (!existing || mine) cfg.statusLine = { type: 'command', command: sl };
  }
  // merge_bash_gate_hook — PreToolUse, matcher 'Bash'.
  if (has('pretooluse-bash-resource-gate.sh'))
    hooks.PreToolUse = replaceOurHookEntries(ev('PreToolUse'), ours('pretooluse-bash-resource-gate.sh'), {
      matcher: 'Bash',
      hooks: cmd('pretooluse-bash-resource-gate.sh'),
    });
  // merge_provenance_hook — UserPromptSubmit, no matcher (fires on every prompt).
  // turn-provenance-owner-vs-agent-2026-07-11 P-003: verified owner-vs-agent stamps.
  if (has('userpromptsubmit-provenance.sh'))
    hooks.UserPromptSubmit = replaceOurHookEntries(ev('UserPromptSubmit'), ours('userpromptsubmit-provenance.sh'), {
      hooks: cmd('userpromptsubmit-provenance.sh'),
    });

  return cfg;
}

/**
 * Install the Claude/Codex CC hooks to ~/.papercusp/hooks/cc/ and merge them (+ the fleet
 * statusline) into ~/.claude/settings.json — the desktop-installer equivalent of the CC-hook block in
 * install-standalone-mcp.sh (EI-8191: the packaged Mac/Windows apps shipped NEITHER the sources NOR the
 * merge, so Claude rendered a blank statusline + lock/coord enforcement was silently off). Cross-platform:
 * runs under Node natively on macOS and inside the WSL distro on Windows, so both get the hooks from this
 * ONE path. Best-effort + idempotent; a missing source (hooks not shipped) degrades to "nothing
 * installed" and leaves settings.json untouched. `srcDir` = the resolved sidecar/dev hooks/cc dir.
 */
async function installClaudeHooks(
  home: string,
  srcDir: string,
): Promise<{ installed: string[]; settingsMerged: boolean }> {
  const destDir = path.join(home, '.papercusp', 'hooks', 'cc');
  await fs.mkdir(destDir, { recursive: true, mode: 0o755 });
  const installed: string[] = [];
  for (const name of CC_HOOK_FILES) {
    try {
      const data = await fs.readFile(path.join(srcDir, name));
      const dst = path.join(destDir, name);
      // Libraries are imported, not exec'd — 0644. Hooks stay 0755.
      const mode = CC_HOOK_LIB_FILES.has(name) ? 0o644 : 0o755;
      await fs.writeFile(dst, data, { mode });
      await fs.chmod(dst, mode);
      installed.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  // Gate the settings merge on the primary lock hook landing (parity with the bash `[ -x $CC_PRE_HOOK ]`).
  if (!installed.includes('pretooluse-locks-acquire.sh')) return { installed, settingsMerged: false };

  const settingsPath = path.join(home, '.claude', 'settings.json');
  let cfg: Record<string, any> = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cfg = parsed as Record<string, any>;
    } else {
      // Corrupt / non-object → back up then start fresh (mirrors the python except branch).
      await fs.rename(settingsPath, `${settingsPath}.bak.${Date.now()}`).catch(() => {});
      cfg = {};
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    cfg = {};
  }
  mergeClaudeHookSettings(cfg, destDir, { present: new Set(installed), isClaudeSettings: true });
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(settingsPath, 0o600);
  return { installed, settingsMerged: true };
}

/**
 * The codex built-in `[tui].status_line` items papercusp configures for the user's SHARED
 * ~/.codex/config.toml — the codex parallel of the Claude fleet statusLine (EI-8191). codex has
 * NO command-backed status item (openai/codex#17827), so this is codex's OWN native bottom pane
 * (run-state · model+reasoning · context-remaining · git-branch), NOT the fleet coord chips.
 * Kept identical to CODEX_TUI_TOML in role-codex-home.ts (per-session homes) so plain `codex` and
 * a psu-launched codex render the SAME status line.
 */
export const CODEX_STATUS_LINE_ITEMS = [
  'run-state',
  'model-with-reasoning',
  'context-remaining',
  'git-branch',
] as const;

/**
 * Non-destructive, idempotent merge of `[tui].status_line` into a codex `config.toml` STRING
 * (returns the new text + whether it changed). The codex analogue of merge_statusline: codex's
 * default is `status_line = None` ⇒ NO status line renders, which is exactly the "I see no status
 * lines in codex at all" report. NON-CLOBBER: we set `status_line` ONLY when it is entirely absent,
 * so any user choice (including an explicit `[]` = "off on purpose", or a personal item list set via
 * `/statusline`) is preserved. Corrupt/unparseable TOML ⇒ returns unchanged (caller leaves the file
 * alone) rather than risk clobbering. Pure + exported for unit tests.
 */
export function mergeCodexStatusLineToml(raw: string): { toml: string; changed: boolean } {
  let obj: Record<string, any>;
  try {
    const parsed = TOML.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { toml: raw, changed: false };
    obj = parsed as Record<string, any>;
  } catch {
    // Unparseable — never clobber a config we can't understand.
    return { toml: raw, changed: false };
  }
  const tui =
    obj.tui && typeof obj.tui === 'object' && !Array.isArray(obj.tui) ? (obj.tui as Record<string, any>) : (obj.tui = {});
  if (tui.status_line !== undefined) return { toml: raw, changed: false };
  tui.status_line = [...CODEX_STATUS_LINE_ITEMS];
  return { toml: TOML.stringify(obj as any), changed: true };
}

/**
 * Merge the papercusp codex status line into the user's shared ~/.codex/config.toml (best-effort,
 * idempotent) — so a PLAIN `codex` gets a native bottom status pane, the codex sibling of the Claude
 * settings.json statusLine merge (EI-8191). Only touches an EXISTING codex config (we don't create a
 * ~/.codex the user never set up); leaves any user-configured status_line untouched. Never throws.
 */
async function installCodexStatusLine(home: string): Promise<{ merged: boolean }> {
  const configPath = path.join(home, '.codex', 'config.toml');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    // No ~/.codex/config.toml (codex not set up here) — nothing to do. The per-session CODEX_HOME
    // path (role-codex-home.ts) already covers psu-launched codex.
    return { merged: false };
  }
  try {
    const { toml, changed } = mergeCodexStatusLineToml(raw);
    if (!changed) return { merged: false };
    await fs.writeFile(configPath, toml.endsWith('\n') ? toml : toml + '\n', { mode: 0o600 });
    return { merged: true };
  } catch {
    return { merged: false };
  }
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

  // Claude/Codex CC hooks + fleet statusline (EI-8191): install the hooks to
  // ~/.papercusp/hooks/cc/ and merge them into ~/.claude/settings.json — the packaged
  // Mac/Windows apps shipped neither, so Claude rendered a blank statusline + lock/coord
  // enforcement was silently off. Cross-platform (Node native on macOS / WSL distro on
  // Windows). Best-effort: sources not shipped ⇒ nothing installed, settings untouched.
  const ccHookSrcDir = await firstExisting(ccHookDirCandidates(operatorAppRoot, explicitRoot));
  const claudeHooks = ccHookSrcDir
    ? await installClaudeHooks(home, ccHookSrcDir)
    : { installed: [] as string[], settingsMerged: false };

  // Codex status line (parallel to the Claude statusLine merge above): a plain `codex` reads the
  // user's shared ~/.codex/config.toml, whose default status_line=None renders NOTHING — the
  // "no status lines in codex at all" report. Merge our native [tui].status_line in non-destructively.
  const codexStatusLine = await installCodexStatusLine(home);

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

  // WI-3626: keep ~/.papercusp/bin/gh symlinked to the current bundle's gh so
  // buildGithubLoginSpec's `gh auth setup-git` bakes a stable, app-rename-proof
  // path into ~/.gitconfig's credential helper instead of an app-bundle path.
  await ensureGhLinked(home, paths.binDir);

  // WI-3334: link the bundled node into ~/.local/bin so the psu/ptool shims'
  // `exec node` resolves even when the shim itself fell back to bare `node`
  // (a shim written by the dev-source operator, which can't resolve the bundled
  // node → resolveShimNode returns bare `node`). The primary operator's install
  // run resolves it (PAPERCUSP_SIDECAR_BIN set), so the link lands regardless.
  await ensureBundledNodeLinked(home);

  // macOS Tutorial.app wrapper (WI-2197): only where it means something (darwin)
  // and only once the dispatcher it invokes actually landed — a DMG install has
  // no postinstall-script hook, so this is provisioned here at first boot,
  // mirroring the Linux .deb's third `.desktop` icon.
  let macTutorialAppWritten = false;
  if (process.platform === 'darwin' && papercuspCliWritten) {
    macTutorialAppWritten = await writeMacTutorialApp(paths.macTutorialAppPath);
    if (macTutorialAppWritten) {
      await fs.rm(path.join(home, 'Applications', 'Papercusp Tutorial.app'), { recursive: true, force: true });
    }
  }

  // Linux tutorial `.desktop` icon (owner 2026-07-06, "4th time"): the Linux leg of the
  // tutorial-icon parity — provisioned HERE at first boot for dev boxes / any non-.deb
  // install, which the .deb postinstall never covers (that only fires on a .deb install,
  // into root /usr/share). Gated on the dispatcher having landed (it is the Exec target).
  let linuxTutorialDesktopWritten = false;
  let linuxTutorialPinned = false;
  if (process.platform === 'linux' && papercuspCliWritten) {
    linuxTutorialDesktopWritten = await writeLinuxTutorialDesktopEntry(
      paths.linuxTutorialDesktopPath,
      paths.papercuspCliPath,
      home,
      operatorAppRoot,
    );
    // Pin it to the dock/taskbar (once) — writing the `.desktop` alone only lands it in
    // the app grid, but the owner wants it ON the taskbar (2026-07-06, 5th report).
    if (linuxTutorialDesktopWritten) {
      linuxTutorialPinned = await pinLinuxTutorialToDock(
        path.basename(paths.linuxTutorialDesktopPath),
        path.join(home, '.papercusp', 'state', 'linux-tutorial-dock-pinned'),
      );
    }
  }

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
    linuxTutorialDesktopWritten,
    linuxTutorialPinned,
    psuLauncherSource: psuShimWritten && psuLauncherSource ? psuLauncherSource : '',
    ptoolLauncherSource: ptoolShimWritten && ptoolLauncherSource ? ptoolLauncherSource : '',
    onboardLauncherSource: papercuspCliWritten && onboardLauncherSource ? onboardLauncherSource : '',
    pathProfilesUpdated,
    claudeHooksInstalled: claudeHooks.installed,
    claudeSettingsMerged: claudeHooks.settingsMerged,
    codexStatusLineMerged: codexStatusLine.merged,
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
