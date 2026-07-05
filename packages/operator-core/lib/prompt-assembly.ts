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
import { renderAccountRoutingNote } from './account-routing-policy';
import { renderConcurrencyFirstNote } from './concurrency-first-policy';
import { renderEvidenceDisciplineNote } from './evidence-discipline-policy';
import { renderDeployPipelineNote } from './deploy-pipeline-policy';
import { renderCodeRunNudge } from './code-run-policy';
import { renderReuseFirstNudge } from './reuse-first-policy';
import { renderWorkRecordNote } from './work-record-policy';
import { renderPlanDisciplineNote } from './plan-discipline-policy';
import { renderObservationCaptureNote } from './observation-capture-policy';
import { renderWriteThroughNote } from './memory-flush-policy';
import { renderTurnEndObservation } from './turn-end-observation-policy';
import { renderFinishTheRolloutNote } from './finish-the-rollout-policy';
import { renderAgentActivityTruthNote } from './agent-activity-truth-policy';
import { renderWaitLoopNote } from './wait-loop-policy';
import { renderPeerWakeNote } from './peer-wake-policy';
import { renderObservationRubricNudge } from './observation-rubric-policy';

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
  // Integration-tree prompt root (decouple-agent-prompts-from-release-gate
  // P-002 / D-001): prefer the integration/staging checkout's operator prompts
  // so a chat-surface prompt edit (operator/oracle/sentinel persona/tools) goes
  // live WITHOUT a code-release promotion. PAPERCUSP_PROMPTS_DIR (above) is the
  // explicit direct override; this derives apps/operator/prompts from the
  // repo-root PAPERCUSP_INTEGRATION_ROOT. CODE stays on the running checkout.
  const integRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integRoot) {
    const fromInteg = join(integRoot, 'apps/operator/prompts');
    if (existsSync(fromInteg)) return fromInteg;
  }
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

/** The roles with prompt sources under apps/operator/prompts/ — the subset
 *  of AGENT_ROLES this assembler can build prompts for. Pinned to the
 *  canonical set via `satisfies` (audit P-072): renaming/removing a role in
 *  agent-mcp's role-config breaks compilation HERE instead of silently
 *  orphaning its prompt files. Type-only dependency — no runtime import
 *  reaches the prompt layer. */
export const PROMPT_ROLES = [
  'operator',
  'oracle',
  'worker',
  'validator',
  'scoper',
  'reviewer',
  'debugger',
  'architect',
  'documenter',
  'curator',
  // G2 user-protection gate (P-006): read-only adversarial judgment role.
  'auditor',
  // Sentinel-as-Herald: the sentinel watcher is re-homed onto the always-on,
  // voice-first Herald — the SAME converse brain loaded with role='sentinel'.
  // Its persona set (sentinel.persona[.{engineer,novice}-mode].md / .converse.md /
  // .shell.md / .tools.md) ships under apps/operator/prompts/, so the assembler
  // must be able to build prompts for it (loadRole{Persona,Converse,ModePersona}).
  'sentinel',
] as const satisfies readonly import('@papercusp/agent-mcp').BuiltinAgentRole[];

export type Role = (typeof PROMPT_ROLES)[number];

export interface AssembledSection {
  name:
    | 'persona'
    | 'tools-catalog'
    | 'tools-playbook'
    | 'coord-legend'
    | 'friction-tripwire'
    | 'observation-rubric-nudge'
    | 'yield-policy'
    | 'testing-standard'
    | 'account-routing-note'
    | 'evidence-discipline-note'
    | 'concurrency-first-note'
    | 'deploy-pipeline-note'
    | 'reuse-first-nudge'
    | 'plan-discipline-note'
    | 'work-record-note'
    | 'observation-capture-note'
    | 'turn-end-observation'
    | 'code-run-note'
    | 'finish-the-rollout-note'
    | 'agent-activity-truth-note'
    | 'wait-loop-note'
    | 'peer-wake-note'
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

/**
 * Load the canonical compaction priorities — the preserve/drop body of
 * apps/operator/prompts/papercusp-compaction.base.md (agent-managed-compaction).
 * The operator converse-brain summarizer folds this into buildCompactionPrompt so
 * a prompt edit goes live without a code release (like the other prompt loaders).
 * Missing file ⇒ null (caller falls back to the built-in default). The leading
 * HTML comment and the trailing CLIENT-OVERLAY marker are stripped.
 */
let compactionPrioritiesCache: string | null | undefined;
export function loadCompactionPriorities(): string | null {
  if (!shouldBypassCache() && compactionPrioritiesCache !== undefined) {
    return compactionPrioritiesCache;
  }
  const path = join(promptsDir(), 'papercusp-compaction.base.md');
  let text: string | null = null;
  if (existsSync(path)) {
    text =
      readFileSync(path, 'utf8')
        .replace(/^<!--[\s\S]*?-->\s*/, '') // strip leading HTML comment
        .replace(/<!--\s*PAPERCUSP-COMPACTION:CLIENT-OVERLAY\s*-->\s*$/, '') // trailing marker
        .trim() || null;
  }
  compactionPrioritiesCache = text;
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

  // Bounded back-pointer (tool-call-batching-wrappers D-005c / P-010): build the inverse
  // index primitive→composite over the RENDERED, modality-passing set (only point at a
  // bundle the agent can actually reach). A primitive a composite `replaces` then gets a
  // single "Bundled by" line — fired at the point the agent reads the primitive — capped
  // (BACKPOINTER_CAP) to keep the catalog from bloating (D-006). The composite self-
  // advertises the other direction via its `chaining` ("Bundles: …").
  const bundledBy = new Map<string, string[]>();
  for (const name of sorted) {
    const t = byMcpName.get(name);
    if (!t || !t.replaces || t.replaces.length === 0) continue;
    if (!(t.modality ?? ['text', 'voice']).includes(modality)) continue;
    for (const prim of t.replaces) {
      const arr = bundledBy.get(prim) ?? [];
      arr.push(name);
      bundledBy.set(prim, arr);
    }
  }
  const BACKPOINTER_CAP = 2;

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
    const bundles = bundledBy.get(name);
    if (bundles && bundles.length > 0) {
      const shown = bundles
        .slice(0, BACKPOINTER_CAP)
        .map((n) => `\`${displayTransform ? displayTransform(n) : n}\``);
      const extra = bundles.length > BACKPOINTER_CAP ? ` (+${bundles.length - BACKPOINTER_CAP} more)` : '';
      lines.push(`  Bundled by: ${shown.join(', ')}${extra} — prefer the bundle to batch this call in one round-trip.`);
    }
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
 *
 * `entryFilter` (context-trimming-tiers P-017): restrict the legend to a
 * subset of tools by name — the FLEET persona tier keeps the coordination/
 * work-item/plan/lock spine and drops every other entry. Omitted = all
 * entries (byte-identical to today).
 */
export function renderWireSchemasSection(entryFilter?: (name: string) => boolean): string {
  const byMcpName = new Map<string, ProjectedTool>();
  for (const t of listAllProjectedTools()) {
    if (t.expose.mcp) byMcpName.set(t.expose.mcp.name, t);
  }
  const entries = entryFilter
    ? listPrePromptEntries().filter((e) => entryFilter(e.name))
    : listPrePromptEntries();
  return renderWireSchemas(entries, (entry) => {
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

  // Observation-rubric nudge (rubric-driven-observations-2026-06-20 P-005, D-001/D-003) — the
  // HOW-to-grade sibling of the friction trip-wire in the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base (buildPromptParts). When filing a turn-end observation,
  // check rubrics:list first and file a STRUCTURED observation (rubricRef + per-criterion ratings +
  // mandatory evidence) if an active rubric fits; free-text stays first-class otherwise. Sourced from
  // the one OBSERVATION_RUBRIC_NUDGE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const observationRubricNudge = renderObservationRubricNudge();
  if (observationRubricNudge) {
    parts.push(observationRubricNudge);
    sections.push({ name: 'observation-rubric-nudge', chars: observationRubricNudge.length });
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

  // Multi-account inference note — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base. Kills the recurring mis-diagnosis of a
  // routing/config fault as a true capacity limit ("we hit the account limit") and
  // steers LLM-building work onto the account-routing system. Sourced from the one
  // ACCOUNT_ROUTING_NOTE constant (orchestrator) so the bases + su playbooks can't desync.
  const accountNote = renderAccountRoutingNote();
  if (accountNote) {
    parts.push(accountNote);
    sections.push({ name: 'account-routing-note', chars: accountNote.length });
  }

  // Evidence-discipline note — the GENERAL rule the account-routing note above is one instance of: a
  // likely-looking cause is a HYPOTHESIS to verify with hard evidence, never a fact to act on / report;
  // and when the evidence isn't obtainable, ADD the observability or FILE the means rather than assuming.
  // Sourced from the one EVIDENCE_DISCIPLINE_NOTE constant (orchestrator) so the bases + su playbooks can't desync.
  const evidenceNote = renderEvidenceDisciplineNote();
  if (evidenceNote) {
    parts.push(evidenceNote);
    sections.push({ name: 'evidence-discipline-note', chars: evidenceNote.length });
  }

  // Concurrency-first note — the SHARED base every operator-launched role inherits, the
  // behavioral dual of the account-routing note. Kills the "the box is too contended, wait for a
  // calmer window" back-off: the only legit block is TRUE verified resource exhaustion; every
  // other block is a BUG to investigate + fix (or file), never to wait out — and the design target
  // is hundreds-to-thousands of concurrent agents. Sourced from the one CONCURRENCY_FIRST_NOTE
  // constant (orchestrator) so the bases + su playbooks + su instance override can't desync.
  const concurrencyNote = renderConcurrencyFirstNote();
  if (concurrencyNote) {
    parts.push(concurrencyNote);
    sections.push({ name: 'concurrency-first-note', chars: concurrencyNote.length });
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

  // Deploy-pipeline note (the "your change ships via an async, self-healing pipeline; don't
  // babysit it or self-diagnose a stall" clause) — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base (buildPromptParts). Sourced from the one
  // DEPLOY_PIPELINE_NOTE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const deployNote = renderDeployPipelineNote();
  if (deployNote) {
    parts.push(deployNote);
    sections.push({ name: 'deploy-pipeline-note', chars: deployNote.length });
  }

  // Reuse-first nudge (the soft "extend, don't fork" clause) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts).
  // Before adding a new durable surface, search for an existing one to extend + prefer the
  // smallest extension; a new parallel surface duplicating an existing one is a top review
  // smell. Sourced from the one REUSE_FIRST_NUDGE constant (orchestrator) so this base, the
  // spawned-bee base, and the su persona base can't desync (agents-reuse-first-default P-001).
  const reuseFirstNudge = renderReuseFirstNudge();
  if (reuseFirstNudge) {
    parts.push(reuseFirstNudge);
    sections.push({ name: 'reuse-first-nudge', chars: reuseFirstNudge.length });
  }

  // Plan-discipline note (enforce-system-on-generic-work-2026-06-29 P-016) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). The bright-line
  // for WHEN a plan is required (>=2 work-items / interdependent steps / outlives a session / sequences
  // subsystems) vs. when it is over-applied ceremony (a one-shot fix). Sourced from the one
  // PLAN_DISCIPLINE_NOTE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const planDisciplineNote = renderPlanDisciplineNote();
  if (planDisciplineNote) {
    parts.push(planDisciplineNote);
    sections.push({ name: 'plan-discipline-note', chars: planDisciplineNote.length });
  }

  // Work-record note (audit-trail discipline; owner ask 2026-06-23, sharpened 2026-06-29 with the
  // work-item PRECONDITION) — the SHARED base every operator-launched role inherits, mirroring the
  // spawned-bee base (buildPromptParts). Hold a work-item BEFORE your first code/deliverable edit; not
  // done until work_items:complete; every unit of work gets a record even when small (a tiny exception
  // task may be recorded AFTER finishing). Sourced from the one WORK_RECORD_NOTE constant (orchestrator)
  // so this base + the spawned-bee base can't desync.
  const workRecordNote = renderWorkRecordNote();
  if (workRecordNote) {
    parts.push(workRecordNote);
    sections.push({ name: 'work-record-note', chars: workRecordNote.length });
  }

  // Observation-capture note (enforce-system-on-generic-work-2026-06-29 P-017) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). The ROUTING
  // sibling of the friction trip-wire: capture what you notice the moment you notice it and route it —
  // signal → improvements:capture (with evidence), problem → issue/work-item, how-it-works → an
  // agent-insights doc. Sourced from the one OBSERVATION_CAPTURE_NOTE constant (orchestrator) so this
  // base + the spawned-bee base can't desync.
  const observationCaptureNote = renderObservationCaptureNote();
  if (observationCaptureNote) {
    parts.push(observationCaptureNote);
    sections.push({ name: 'observation-capture-note', chars: observationCaptureNote.length });
  }

  // Write-through note (compaction-context-loss-2026-07-05 P-004) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). Flush a
  // durable conclusion the MOMENT it forms (facts:assert for a standing conclusion,
  // work_items:checkpoint / loop:checkpoint for in-flight state) — not when the context fills; the
  // ~75% gauge nudge + compaction are the BACKSTOP, never the trigger (D-001: the carry system's
  // weakness is behavioral at the WRITE end). Sourced from the one WRITE_THROUGH_NOTE constant
  // (orchestrator) so this base + the spawned-bee base + the su playbooks + compaction-strategy.md
  // can't desync.
  const writeThroughNote = renderWriteThroughNote();
  if (writeThroughNote) {
    parts.push(writeThroughNote);
    sections.push({ name: 'write-through-note', chars: writeThroughNote.length });
  }

  // Turn-end observation pass (owner ask 2026-06-23) — the DELIBERATE end-of-turn reflection step
  // (the bee.md / su-playbook pass) generalized to every operator-launched role (operator / oracle /
  // sentinel previously had only the reactive friction-tripwire). Token-light: "routine turn ⇒ record
  // nothing". Injected ONLY here (the bee base + su playbooks carry their own) to avoid double-inject.
  const turnEndObservation = renderTurnEndObservation();
  if (turnEndObservation) {
    parts.push(turnEndObservation);
    sections.push({ name: 'turn-end-observation', chars: turnEndObservation.length });
  }

  // Code-run nudge (code-execution-tool-orchestration B-CX-3) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). Reach for
  // code:run to collapse a multi-step tool flow (loop/branch/filter/fan-out/retry over N) into ONE
  // call instead of N inference round-trips; self-gated ("if code:run is in your toolset"). Sourced
  // from the one CODE_RUN_NUDGE constant (orchestrator) so this base + the spawned-bee base can't desync.
  const codeRunNudge = renderCodeRunNudge();
  if (codeRunNudge) {
    parts.push(codeRunNudge);
    sections.push({ name: 'code-run-note', chars: codeRunNudge.length });
  }

  // Finish-the-rollout note (flags-default-on-reach-2026-06-21) — the SHARED base every
  // operator-launched role inherits, mirroring the spawned-bee base (buildPromptParts). A capability
  // built then left gated OFF (flag or env boolean) is INCOMPLETE, not done — turning the gate on is
  // the last step of the task. Sourced from the one FINISH_THE_ROLLOUT_NOTE constant (orchestrator) so
  // this base, the spawned-bee base, the su playbooks, and CLAUDE.md's flags section can't desync.
  const finishTheRolloutNote = renderFinishTheRolloutNote();
  if (finishTheRolloutNote) {
    parts.push(finishTheRolloutNote);
    sections.push({ name: 'finish-the-rollout-note', chars: finishTheRolloutNote.length });
  }

  // Agent-activity-truth note (agent-activity-liveness-truth-2026-06-21 P-004/P-006) — the SHARED
  // base every operator-launched role inherits, mirroring the spawned-bee base. "Who's doing what"
  // is a LIVE derived truth (fleet:assignments: claim + holder-liveness + progress), never a stale
  // coord broadcast that outlives the work — the incident class (a dead bee read as "covered" for ~1h).
  // Sourced from the one AGENT_ACTIVITY_TRUTH_NOTE constant (orchestrator) so this base + the
  // spawned-bee base can't desync.
  const agentActivityTruthNote = renderAgentActivityTruthNote();
  if (agentActivityTruthNote) {
    parts.push(agentActivityTruthNote);
    sections.push({ name: 'agent-activity-truth-note', chars: agentActivityTruthNote.length });
  }

  // Wait-loop note (owner directive 2026-06-23) — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base. When blocked on something that may never fire, arm a
  // recurring self-wake (loop:arm / declare-wake) and FIX what's preventing the firing instead of
  // sleeping forever on a bare event-await. Sourced from the one WAIT_LOOP_NOTE constant
  // (orchestrator) so this base, the spawned-bee base, and the su playbooks can't desync.
  const waitLoopNote = renderWaitLoopNote();
  if (waitLoopNote) {
    parts.push(waitLoopNote);
    sections.push({ name: 'wait-loop-note', chars: waitLoopNote.length });
  }

  // Peer-wake note (owner directive 2026-06-24) — the SHARED base every operator-launched role
  // inherits, mirroring the spawned-bee base. A parked agent sleeps until something re-invokes it, so
  // handing work off does not make a peer act; you can (and usually must) WAKE the peer you depend on
  // (coord:dispatch / coord:handoff for new work, coord:wake to resume an assigned lane) and verify it
  // landed. The active complement of the wait-loop note. Sourced from the one PEER_WAKE_NOTE constant
  // (orchestrator) so this base, the spawned-bee base, and the su playbooks can't desync.
  const peerWakeNote = renderPeerWakeNote();
  if (peerWakeNote) {
    parts.push(peerWakeNote);
    sections.push({ name: 'peer-wake-note', chars: peerWakeNote.length });
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
