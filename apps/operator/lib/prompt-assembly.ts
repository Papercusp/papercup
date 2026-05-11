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
import { join } from 'node:path';
import {
  listAllProjectedTools,
  type ProjectedTool,
} from '@papercusp/agent-mcp';

// Resolve at first call, not at module load. process.cwd() at module
// scope is visible to Turbopack's NFT tracer, which pulls the entire
// CWD into the route asset trace and trips
// "Encountered unexpected file in NFT list" → "Invalid segment
// configuration export detected" → build fails (caught 2026-05-11).
// Lazy resolution side-steps the tracer entirely.
function promptsDir(): string {
  return join(process.cwd(), 'apps/operator/prompts');
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
  | 'curator';

export interface AssembledSection {
  name: 'persona' | 'tools-catalog' | 'tools-playbook' | 'runtime';
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
 */
export function renderToolsCatalog(role: Role, toolNames: string[]): string {
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
    rendered += 1;
    lines.push(`- \`${name}\``);
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
