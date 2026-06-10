/**
 * Role system-prompt assembly.
 *
 * Builds the system prompt for an LLM call from four sources, in order:
 *
 *   1. `<role>.persona.md`        — character + behavior rules (filesystem)
 *   2. Tools catalog              — per-tool guidance from the projection
 *                                   registry (single source of truth for
 *                                   "when/notWhen/chaining"). Rendered only
 *                                   for the tools the caller passes.
 *   3. `<role>.tools.md`          — cross-tool patterns + named workflows
 *                                   (filesystem; optional — falls back to
 *                                   no playbook section when absent)
 *   4. Runtime context            — caller-supplied blocks (history,
 *                                   trigger, [may_ask_active] marker, etc.)
 *
 * Why three layers (persona + catalog + tools.md):
 *   - Per-tool guidance lives at the tool (`defineTool({ guidance })`) so
 *     one tool's "when to call me" is authored once across all roles.
 *   - Cross-tool patterns and workflows can't live at any single tool —
 *     they go in `<role>.tools.md`.
 *   - Behavior rules ("always call", "tier-high requires confirm") are
 *     about the AGENT's behavior pattern, not a tool's — they live in
 *     `<role>.persona.md`.
 *
 * Caching:
 *   - Filesystem reads (persona.md, tools.md) memoized at module load.
 *   - Catalog rendering memoized per-role, invalidated when any tool is
 *     registered (catalog version bump in the projection registry).
 *   - `PAPERCUSP_RELOAD_PROMPTS=1` env var (default on in NODE_ENV=development)
 *     disables ALL caches so editing a .md file shows up next request
 *     without restarting the dev server.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listAllProjectedTools,
  type ProjectedTool,
} from '@papercusp/agent-mcp';
import {
  listPrePromptEntries,
  projectReadColumns,
  projectWriteColumns,
  renderWireSchemas,
} from '@papercusp/result-encoding';
import { renderCoordLegend } from './coord-schema';
import { renderFrictionTripwire } from './harness/improvements/friction-markers';
import { renderYieldPolicy } from './turn-yield-policy';
import { renderTestingStandard } from './testing-standard-policy';

// Resolve at first call, not at module load. process.cwd() at module
// scope is visible to Turbopack's NFT tracer, which pulls the entire
// CWD into the route asset trace and trips
// "Encountered unexpected file in NFT list" → "Invalid segment
// configuration export detected" → build fails (caught 2026-05-11).
// Lazy resolution side-steps the tracer entirely.
//
// Path handling: process.cwd() is monorepo-root when the dev server is
// launched via `bin/overmind-all start` from the workspace root, but
// `apps/operator/` when next-server is launched directly from there
// (the common dev-server case). Try the longer path first; fall back
// to cwd-relative if the prompts dir is right next to cwd.
export function promptsDir(): string {
  // Explicit override — the packaged desktop (SP1 C5: serve.mjs with
  // cwd=sidecar/) sets PAPERCUSP_PROMPTS_DIR=<sidecar>/prompts, mirroring
  // PAPERCUSP_SPA_DIST / PAPERCUSP_DOCS_ROOT. Without it the cwd heuristics
  // below misfire there: sidecar/apps/operator/prompts EXISTS (it carries
  // only the desktop-install playbook) and would win over sidecar/prompts,
  // so persona loads would throw at boot.
  const fromEnv = process.env.PAPERCUSP_PROMPTS_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const fromRoot = join(process.cwd(), 'apps/operator/prompts');
  if (existsSync(fromRoot)) return fromRoot;
  const fromOperator = join(process.cwd(), 'prompts');
  if (existsSync(fromOperator)) return fromOperator;
  // cwd-independent fallback: anchor to THIS module's own location and walk
  // up to the repo root that owns apps/operator/prompts. The operator-core
  // carve (operator-core-headless-serve-2026-06-04) moved the route code into
  // packages/operator-core/lib/ while the prompts stayed at apps/operator/
  // prompts, so the cwd-relative forms above MISS when operator-core's own
  // package tests run (cwd=packages/operator-core) — every role's persona
  // load then throws. Anchoring to import.meta.url fixes that regardless of
  // cwd. (Lazy, inside the fn — keeps it out of module scope so the Turbopack
  // NFT tracer never sees it; see the note above.)
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, 'apps/operator/prompts');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Default to the monorepo-root cwd form so loaders that throw point at
  // the canonical path (less confusing in the error message).
  return fromRoot;
}

/** Roles supported. Mirrors AGENT_ROLES in the plugin SDK; kept local
 *  so this module doesn't drag a workspace-aware role enum into a prompt
 *  layer. Update both when the canonical list changes. */
export type Role =
  | 'operator'
  | 'oracle'
  | 'worker'
  | 'validator'
  | 'scoper'
  | 'reviewer'
  | 'debugger'
  | 'architect'
  | 'documenter'
  | 'curator'
  // G2 user-protection gate (P-006): read-only adversarial judgment role.
  | 'auditor';

export interface AssembledSection {
  name:
    | 'persona'
    | 'tools-catalog'
    | 'tools-playbook'
    | 'coord-legend'
    | 'friction-tripwire'
    | 'yield-policy'
    | 'testing-standard'
    | 'runtime';
  chars: number;
}

export interface AssembledPrompt {
  /** The assembled prompt, ready to send to the model. */
  text: string;
  /** For audit/debug — which sections contributed and their sizes. */
  sections: AssembledSection[];
}

export interface AssembleOptions {
  role: Role;
  /**
   * MCP tool names this role is allowed to call for the surface invoking
   * the assembly. For chat surfaces (operator, oracle) this is the
   * `allowedTools` array (stripped of the `mcp__agentmcp__` prefix). For
   * spawn-URL roles (worker etc.), the dispatcher determines allowance
   * — pass the full role-filtered catalog or omit to skip the catalog
   * section.
   */
  toolNames: string[];
  /** Optional caller-supplied blocks rendered after the tools playbook. */
  runtime?: Array<{ heading: string; body: string }>;
}

/* ─── Filesystem reads (cached unless PAPERCUSP_RELOAD_PROMPTS=1) ─────── */

function shouldBypassCache(): boolean {
  if (process.env.PAPERCUSP_RELOAD_PROMPTS === '1') return true;
  if (process.env.PAPERCUSP_RELOAD_PROMPTS === '0') return false;
  return process.env.NODE_ENV === 'development';
}

const personaCache = new Map<Role, string>();
const toolsMdCache = new Map<Role, string | null>();
const converseCache = new Map<Role, string>();

export function loadRolePersona(role: Role): string {
  if (!shouldBypassCache() && personaCache.has(role)) {
    return personaCache.get(role)!;
  }
  const path = join(promptsDir(), `${role}.persona.md`);
  if (!existsSync(path)) {
    throw new Error(
      `prompt-assembly: ${role}.persona.md not found at ${path}. ` +
      `Every role must have a persona.md.`,
    );
  }
  const text = readFileSync(path, 'utf8');
  personaCache.set(role, text);
  return text;
}

export function loadRoleToolsMd(role: Role): string | null {
  if (!shouldBypassCache() && toolsMdCache.has(role)) {
    return toolsMdCache.get(role)!;
  }
  const path = join(promptsDir(), `${role}.tools.md`);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  toolsMdCache.set(role, text);
  return text;
}

/**
 * Load `<role>.converse.md` — the active-mode behavioral rules (silence
 * ladder, say/set_mode/sleep/spawn tag protocol). Required for chat-mode
 * roles that drive a conversation loop on the server (today: operator).
 *
 * Throws if the file is missing; chat-mode routes that call this should
 * already require it. If a role exists that doesn't use the converse
 * pattern, that role's route just doesn't call this.
 */
const modePersonaCache = new Map<string, string | null>();

/**
 * Load `<role>.persona.<mode>-mode.md` — the audience-mode character
 * overlay. Injected as the first system section so it frames who the
 * user is before the shared persona rules apply.
 *
 * Returns null when no file exists for the given mode (opt-in per role).
 * Throws when a file exists but is unreadable.
 */
export function loadRoleModePersona(role: Role, mode: string): string | null {
  const key = `${role}:${mode}`;
  if (!shouldBypassCache() && modePersonaCache.has(key)) {
    return modePersonaCache.get(key)!;
  }
  const path = join(promptsDir(), `${role}.persona.${mode}-mode.md`);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  modePersonaCache.set(key, text);
  return text;
}

export function loadRoleConverse(role: Role): string {
  if (!shouldBypassCache() && converseCache.has(role)) {
    return converseCache.get(role)!;
  }
  const path = join(promptsDir(), `${role}.converse.md`);
  if (!existsSync(path)) {
    throw new Error(
      `prompt-assembly: ${role}.converse.md not found at ${path}. ` +
      `Required for chat-mode roles.`,
    );
  }
  const text = readFileSync(path, 'utf8');
  converseCache.set(role, text);
  return text;
}

/* ─── Catalog rendering ───────────────────────────────────────────────── */

/**
 * Render the per-tool catalog for the role. For each tool name in
 * `toolNames`:
 *   - look up the projected tool definition (which carries guidance)
 *   - merge byRole[role] over the base
 *   - emit a "- <name>\n  <description>\n  When: ...\n  Not when: ...\n  Chaining: ..."
 *     block; the guidance lines are omitted when empty so unmigrated
 *     tools render with description-only (backwards-identical to
 *     pre-guidance behavior).
 *
 * Sorted alphabetically by tool name so the prompt is stable across
 * runs (helpful for prompt-diffing in audits).
 *
 * `modality` (Phase 4 T3.1) filters the catalog by surface: when set
 * to 'voice', tools whose declared `modality` excludes 'voice' are
 * dropped. Tools without a declared modality default to text-only and
 * are filtered out of voice catalogs.
 */
export function renderToolsCatalog(
  role: Role,
  toolNames: string[],
  modality: 'text' | 'voice' = 'text',
  /**
   * Optional rewrite of the DISPLAYED tool name (lookup is unchanged — always
   * by the colon MCP-catalog name). The operator passes `:`→`_` so the catalog
   * advertises the same underscore names Claude Code actually presents to the
   * model (it sanitizes the colon out of `harness:status` → `harness_status`),
   * instead of colon names the model can't match (voice-persona P-005). Default
   * identity — every other role's catalog is byte-identical.
   */
  displayTransform?: (mcpName: string) => string,
): string {
  if (toolNames.length === 0) return '';

  const byMcpName = new Map<string, ProjectedTool>();
  for (const t of listAllProjectedTools()) {
    if (t.expose.mcp) byMcpName.set(t.expose.mcp.name, t);
  }

  const lines: string[] = ['## Available tools', ''];
  const sorted = [...new Set(toolNames)].sort();
  let rendered = 0;
  for (const name of sorted) {
    const tool = byMcpName.get(name);
    if (!tool) continue; // silently skip — caller's list may include legacy or transient names
    // Modality filter: a tool's `modality: readonly ('text'|'voice')[]`
    // declares which surfaces it makes sense from. Default
    // `['text', 'voice']` when absent — most tools are usable in
    // either surface, and the previous text-only default silently
    // emptied the voice catalog for any tool that didn't opt in
    // (round-13 E2E bug #36).
    const toolModality = tool.modality ?? ['text', 'voice'];
    if (!toolModality.includes(modality)) continue;
    rendered += 1;
    lines.push(`- \`${displayTransform ? displayTransform(name) : name}\``);
    lines.push(`  ${tool.description}`);
    const g = mergeRoleGuidance(tool.guidance, role);
    if (g?.when) lines.push(`  When: ${g.when}`);
    if (g?.notWhen) lines.push(`  Not when: ${g.notWhen}`);
    if (g?.chaining) lines.push(`  Chaining: ${g.chaining}`);
    lines.push('');
  }
  if (rendered === 0) return '';
  return lines.join('\n').trimEnd();
}

/**
 * Render the "## Wire schemas" prompt legend (token-efficient-agent-io P-003):
 * the prompt-declared column schemas for every pre-prompt registry tool, derived
 * from each tool's OWN registered schema (output `data` for read, `args` for
 * write). Because the SAME `projectReadColumns`/`projectWriteColumns` drive the
 * read serializer and the write shim, the legend can't desync from the wire (the
 * anti-desync test asserts it). Returns '' when no registry tool has derivable
 * columns, so the marker collapses to nothing.
 */
export function renderWireSchemasSection(): string {
  const byMcpName = new Map<string, ProjectedTool>();
  for (const t of listAllProjectedTools()) {
    if (t.expose.mcp) byMcpName.set(t.expose.mcp.name, t);
  }
  return renderWireSchemas(listPrePromptEntries(), (entry) => {
    const tool = byMcpName.get(entry.name);
    if (!tool) return {};
    const read =
      entry.read !== 'off' && tool.outputJsonSchema
        ? projectReadColumns(tool.outputJsonSchema)
        : undefined;
    const write =
      entry.write === 'positional'
        ? projectWriteColumns(tool.inputSchema as Record<string, unknown>, { freeTextName: entry.freeTextArg })
        : undefined;
    return { read, write };
  });
}

function mergeRoleGuidance(
  raw:
    | {
        when?: string;
        notWhen?: string;
        chaining?: string;
        byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
      }
    | undefined,
  role: Role,
): { when?: string; notWhen?: string; chaining?: string } | null {
  if (!raw) return null;
  const base = { when: raw.when, notWhen: raw.notWhen, chaining: raw.chaining };
  const override = raw.byRole?.[role];
  const merged = override ? { ...base, ...override } : base;
  if (!merged.when && !merged.notWhen && !merged.chaining) return null;
  return merged;
}

/* ─── Top-level assembly ──────────────────────────────────────────────── */

export function assembleRolePrompt(opts: AssembleOptions): AssembledPrompt {
  const sections: AssembledSection[] = [];
  const parts: string[] = [];

  const persona = loadRolePersona(opts.role);
  parts.push(persona);
  sections.push({ name: 'persona', chars: persona.length });

  const catalog = renderToolsCatalog(opts.role, opts.toolNames);
  if (catalog) {
    parts.push(catalog);
    sections.push({ name: 'tools-catalog', chars: catalog.length });
  }

  const playbook = loadRoleToolsMd(opts.role);
  if (playbook) {
    parts.push(playbook);
    sections.push({ name: 'tools-playbook', chars: playbook.length });
  }

  // Coord-injection legend (token-efficient-coord-injection P-013). Role
  // sessions DO receive coord injection — the global Claude PostToolUse coord
  // hook fires on their `PAPERCUSP_SID` (set by bootstrap-role) — so they get the
  // positional `[coord+N]` blocks and need the SAME legend the psu playbook
  // carries to read them. Sourced from the one `COORD_LEGEND` (so it can't
  // desync from the renderer). Clients that don't inject just never see a block.
  const coordLegend = renderCoordLegend();
  if (coordLegend) {
    parts.push(coordLegend);
    sections.push({ name: 'coord-legend', chars: coordLegend.length });
  }

  // Friction trip-wire (self-learning-central P-001/A, D-006). The SUBJECTIVE
  // sibling of the watchdog: a near-zero one-line clause in the SHARED base every
  // role inherits, priming the model to file friction it *felt* (a workaround, a
  // misleading doc, a >3-attempt confusing failure) via improvements:capture the
  // moment it hits it — NOT a per-turn reflection pass. Sourced from the one
  // friction-markers module so the base, the su playbook, and the
  // completion-boundary reflect step can't desync.
  const frictionTripwire = renderFrictionTripwire();
  if (frictionTripwire) {
    parts.push(frictionTripwire);
    sections.push({ name: 'friction-tripwire', chars: frictionTripwire.length });
  }

  // Yield policy (turn-lifecycle-control P-017, D-007/D-009) — the dual of the
  // friction trip-wire: the cooperative-yield behavior in the SHARED base every
  // operator-launched role inherits (on a turn:interrupt yield, checkpoint →
  // persist partial state → release locks → successor note → end the turn).
  // Sourced from the one YIELD_POLICY constant (orchestrator) so this base, the
  // spawned-bee base, and the su playbook can't desync.
  const yieldPolicy = renderYieldPolicy();
  if (yieldPolicy) {
    parts.push(yieldPolicy);
    sections.push({ name: 'yield-policy', chars: yieldPolicy.length });
  }

  // Testing standard (the "write tests the project way" clause) — the SHARED base
  // every operator-launched role inherits, mirroring the spawned-bee base
  // (buildPrompt). Sourced from the one TESTING_STANDARD constant (orchestrator) so
  // this base, the spawned-bee base, and the su playbooks can't desync.
  const testingStandard = renderTestingStandard();
  if (testingStandard) {
    parts.push(testingStandard);
    sections.push({ name: 'testing-standard', chars: testingStandard.length });
  }

  if (opts.runtime && opts.runtime.length > 0) {
    const runtimeText = opts.runtime
      .map((r) => `## ${r.heading}\n\n${r.body}`)
      .join('\n\n---\n\n');
    parts.push(runtimeText);
    sections.push({ name: 'runtime', chars: runtimeText.length });
  }

  return {
    text: parts.join('\n\n---\n\n'),
    sections,
  };
}
