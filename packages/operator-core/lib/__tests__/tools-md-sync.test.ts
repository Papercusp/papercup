/**
 * Static assertions: tool guidance stays in sync across allowedTools,
 * defineTool catalog, and role prompts (tools.md / persona.md).
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/tools-md-sync.mjs.
 * Pure-static — no operator process needed.
 *
 * Assertions:
 *   - (fail) Every tool in a role's surface has a catalog entry.
 *   - (warn) Every tool has guidance.when — warn-only until Phase 5.
 *   - (fail) Every tool mentioned in role.tools.md is in the surface.
 *   - (fail) Every tool mentioned in role.persona.md is in the surface.
 *   - (fail) Every byRole key in any tool's guidance is a known role.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
// EI-7284: the P-011 prompt-weight budget ratchet, run HERE too. This file is
// the quick-check the CLAUDE.md "Adding a tool" discipline mandates after a
// guidance/description edit — folding the budget suite in means that mandated
// run reds a budget breach locally, instead of it slipping to the green gate
// (a ~12h fleet-wide deploy wedge). Same suite the standalone
// tool-guidance-budget.test.ts runs, from one shared source of truth.
import { describeToolGuidanceBudget } from './tool-guidance-budget.shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../');
const PROMPTS_DIR = join(REPO, 'apps/operator/prompts');

const KNOWN_ROLES = [
  'operator', 'oracle', 'worker', 'validator', 'scoper',
  'reviewer', 'debugger', 'architect', 'documenter', 'curator',
  // G2 user-protection gate (P-006): read-only adversarial judgment role.
  'auditor',
  // The Hive's generic worker (EI-317: bee.tools.md carries the deferred-MCP
  // loading recipe — keep its tool mentions in the bee surface).
  'cup',
];

const CHAT_SURFACES = [
  {
    role: 'operator',
    label: 'operator-converse',
    allowedToolsSource: 'packages/operator-core/lib/operator-mcp-tools.ts',
  },
  {
    role: 'oracle',
    label: 'oracle',
    allowedToolsSource: 'packages/operator-core/lib/agent-tools/oracle/prompts.ts',
  },
];

const NON_CHAT_ROLES = [
  'worker', 'validator', 'scoper', 'reviewer',
  'debugger', 'architect', 'documenter', 'curator',
  // G2 user-protection gate (P-006): read-only; empty tool catalog (no exec).
  'auditor',
  // The Hive's generic worker (EI-317).
  'cup',
];

// ─── helpers ─────────────────────────────────────────────────────────

function parseChatSurfaceAllowedTools(filepath: string): Set<string> {
  const src = readFileSync(join(REPO, filepath), 'utf8');
  const names = new Set<string>();
  // `-` included: hyphenated tool names (pot:declare-wake, coord:declare-intent)
  // must parse whole — the catalog's name regex already allows it.
  for (const m of src.matchAll(/mcp__agentmcp__([a-zA-Z0-9_:.\-]+)/g)) names.add(m[1]);
  return names;
}

/**
 * Known non-tool mentions that look like tool names in backticks.
 * These are documentation references — markdown block emissions (`promote:plan`)
 * or metadata-key references (`metadata.covers`) — not invocable tools.
 */
const NON_TOOL_MENTION_ALLOWLIST = new Set<string>([
  // Markdown block emissions consumed by the architect/scoper handlers.
  'promote:plan',
  // Metadata-key references (frontmatter or schema columns), not tool names.
  'metadata.covers',
]);

function parseToolMentions(md: string): Set<string> {
  const FILE_SUFFIX = /\.(md|ts|tsx|js|jsx|mjs|cjs|json|sh|py|css|html|toml|yaml|yml)$/i;
  const mentions = new Set<string>();
  for (const m of md.matchAll(/`([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-\/]+)`/g)) {
    const candidate = m[1];
    if (FILE_SUFFIX.test(candidate) || candidate.includes('/')) continue;
    if (NON_TOOL_MENTION_ALLOWLIST.has(candidate)) continue;
    mentions.add(candidate);
  }
  return mentions;
}

/**
 * Extract the TOP-LEVEL keys of a defineTool source's `byRole:` block.
 * `byRole` values are full guidance objects (`{ when, notWhen?, chaining? }`,
 * see ToolGuidance in libs/generic/tooldef), so a flat `[^}]*` regex harvests
 * nested keys (`when`) and `word:` look-alikes inside the guidance strings
 * (`plan:<slug>`). Walk the block brace-aware and string-aware instead, and
 * collect identifiers followed by `:` at depth 0 only.
 */
function parseByRoleTopLevelKeys(src: string): string[] {
  const at = src.search(/byRole:\s*\{/);
  if (at === -1) return [];
  const open = src.indexOf('{', at);
  const keys: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let token = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      token = '';
      continue;
    }
    if (ch === '{') {
      depth++;
      token = '';
      continue;
    }
    if (ch === '}') {
      depth--;
      token = '';
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      if (/[\w$-]/.test(ch)) token += ch;
      else if (ch === ':' && token) {
        keys.push(token);
        token = '';
      } else if (!/\s/.test(ch)) token = '';
    }
  }
  return keys;
}

// ─── catalog ─────────────────────────────────────────────────────────

interface CatalogEntry {
  roles: string[];
  hasWhen: boolean;
  byRoleKeys: string[];
  source: string;
}

const TOOL_FILES: string[] = [];
function findToolFiles(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findToolFiles(full);
    } else if (entry.endsWith('.ts') && !entry.includes('.test.') && !entry.startsWith('index.')) {
      TOOL_FILES.push(full);
    }
  }
}
findToolFiles(join(REPO, 'packages/agent-mcp/src/tools'));
findToolFiles(join(REPO, 'packages/operator-core/lib/agent-tools'));

const PLUGIN_MANIFESTS: string[] = [];
function findPluginManifests(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findPluginManifests(full);
    } else if (entry === 'papercusp.json') {
      PLUGIN_MANIFESTS.push(full);
    }
  }
}
findPluginManifests(join(REPO, 'libs/papercusp/plugins'));

const CATALOG = new Map<string, CatalogEntry>();

// Pass 1 — defineTool files
for (const file of TOOL_FILES) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('defineTool(')) continue;
  // Require at least one separator (`:` or `.`) so we skip inline `name: 'project'`
  // style arguments that appear before the tool's own `name:` field.
  const nameMatch = src.match(/name:\s*['"]([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-]+)['"]/);
  if (!nameMatch) continue;
  const name = nameMatch[1];
  const rolesMatch = src.match(/roles:\s*\[([^\]]*)\]/);
  const rolesStr = rolesMatch?.[1] ?? '';
  // SU_ROLES expands to every agent role in lib/agent-tools/plans/*; treat it
  // as the same "all roles" signal as ALL_ROLES / AGENT_ROLES.
  const allRolesSpread = /\.\.\.ALL_ROLES|\.\.\.AGENT_ROLES|\.\.\.SU_ROLES/.test(rolesStr);
  const roles = allRolesSpread
    ? [...KNOWN_ROLES]
    : [...rolesStr.matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]);
  const hasGuidanceBlock = /guidance:\s*\{/.test(src);
  const hasWhen = hasGuidanceBlock && /guidance:\s*\{[^}]*?when:\s*['"`]/s.test(src);
  CATALOG.set(name, {
    roles,
    hasWhen,
    byRoleKeys: parseByRoleTopLevelKeys(src),
    source: file.replace(REPO + '/', ''),
  });
}

// Pass 2 — plugin manifests
for (const file of PLUGIN_MANIFESTS) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(json.tools)) {
    for (const tool of json.tools) {
      const mcpName = tool.expose?.mcp?.name ?? `${json.name?.replace(/^@papercupai\//, '')}.${tool.name}`;
      const roles = Array.isArray(tool.roles) ? tool.roles : [];
      const hasWhen = !!tool.guidance?.when;
      const byRoleKeys = tool.guidance?.byRole ? Object.keys(tool.guidance.byRole) : [];
      CATALOG.set(mcpName, { roles, hasWhen, byRoleKeys, source: file.replace(REPO + '/', '') });
    }
  }
  if (Array.isArray(json.capabilities)) {
    for (const cap of json.capabilities) {
      const m = /^tools:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(cap);
      if (!m) continue;
      const dynName = `${m[1]}.${m[2]}`;
      if (!CATALOG.has(dynName)) {
        CATALOG.set(dynName, { roles: [], hasWhen: false, byRoleKeys: [], source: file.replace(REPO + '/', '') + ' (dynamic)' });
      }
    }
  }
}

// Tolerate claude-code `_` ↔ `.` name mangling in allowedTools entries.
function lookupCatalog(name: string): CatalogEntry | undefined {
  return (
    CATALOG.get(name) ??
    CATALOG.get(name.replace(/_/g, '.')) ??
    CATALOG.get(name.replace(/_/, '.'))
  );
}

function inSurface(n: string, allowed: Set<string>): boolean {
  return (
    allowed.has(n) ||
    allowed.has(n.replace(/\./g, '_')) ||
    allowed.has(n.replace(/\./, '_'))
  );
}

// ─── test helpers ─────────────────────────────────────────────────────

function checkRoleTests(role: string, allowed: Set<string>) {
  it('every allowedTool has a catalog entry (no drift)', () => {
    const orphans = [...allowed].filter((n) => !lookupCatalog(n));
    expect(orphans, `orphaned tools: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every tool with guidance.when in surface (warn-only — Phase 5 pending)', () => {
    // No assertion: guidance.when backfill is Phase 5 work.
    // When Phase 5 ships, flip this to:
    //   const missing = [...allowed].filter((n) => { const e = lookupCatalog(n); return e && !e.hasWhen; });
    //   expect(missing).toEqual([]);
  });

  it(`${role}.tools.md: every mentioned tool is in the role surface`, () => {
    const toolsMdPath = join(PROMPTS_DIR, `${role}.tools.md`);
    if (!existsSync(toolsMdPath)) return;
    const md = readFileSync(toolsMdPath, 'utf8');
    const stale = [...parseToolMentions(md)].filter((n) => !inSurface(n, allowed));
    expect(stale, `stale in ${role}.tools.md: ${stale.join(', ')}`).toEqual([]);
  });

  it(`${role}.persona.md: every mentioned tool is in the role surface`, () => {
    const personaPath = join(PROMPTS_DIR, `${role}.persona.md`);
    if (!existsSync(personaPath)) return;
    const md = readFileSync(personaPath, 'utf8');
    const stale = [...parseToolMentions(md)].filter((n) => !inSurface(n, allowed));
    expect(stale, `stale in ${role}.persona.md: ${stale.join(', ')}`).toEqual([]);
  });
}

// ─── tests ────────────────────────────────────────────────────────────

describe('tools-md-sync', () => {
  it('catalog has entries from tool files and plugin manifests', () => {
    expect(CATALOG.size).toBeGreaterThan(0);
  });

  for (const { role, label, allowedToolsSource } of CHAT_SURFACES) {
    const allowed = parseChatSurfaceAllowedTools(allowedToolsSource);
    describe(`chat surface: ${label} (${role})`, () => {
      checkRoleTests(role, allowed);
    });
  }

  for (const role of NON_CHAT_ROLES) {
    const catalogForRole = new Set<string>();
    for (const [name, entry] of CATALOG) {
      if (entry.roles.length === 0 || entry.roles.includes(role)) {
        catalogForRole.add(name);
      }
    }
    if (catalogForRole.size === 0) continue;

    describe(`spawn-url role: ${role}`, () => {
      checkRoleTests(role, catalogForRole);
    });
  }

  describe('byRole reference validation', () => {
    it('every byRole key references a known role', () => {
      // Validate against the FULL runtime role registry (AGENT_ROLES), not
      // this file's chat/spawn-surface subset: byRole legitimately targets
      // roles with no apps/operator/prompts surface (queen, sentinel, …) —
      // the EI-286 drift class (registry knows the role, a checker doesn't).
      const validRoles = new Set<string>(AGENT_ROLES);
      const bad: string[] = [];
      for (const [name, entry] of CATALOG) {
        for (const key of entry.byRoleKeys) {
          if (!validRoles.has(key)) bad.push(`${name}: byRole.${key}`);
        }
      }
      expect(bad, `invalid byRole keys: ${bad.join(', ')}`).toEqual([]);
    });
  });
});

// EI-7284: run the P-011 prompt-weight budget ratchet as part of this
// quick-check so `npx vitest run tools-md-sync` reds an over-budget tool.
describeToolGuidanceBudget();
