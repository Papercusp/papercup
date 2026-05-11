#!/usr/bin/env node
/**
 * CI sync test for the tool-guidance arc.
 *
 * Validates the three sources of tool guidance stay in agreement:
 *   1. `<role>.allowedTools` (in route files for chat surfaces)
 *      OR  role's projected catalog (for spawn-URL roles).
 *   2. Every tool's `defineTool({ guidance })` (or plugin manifest
 *      `tools[i].guidance`).
 *   3. `<role>.tools.md`           — cross-tool playbook.
 *   4. `<role>.persona.md`         — behavior rules referencing tools.
 *
 * Assertions:
 *   - (warn) Every tool in the role's surface has a non-empty
 *     `guidance.when`. Warn-only until Phase 5 lights up the full
 *     catalog backfill; flip to fail when that lands.
 *   - (fail) Every tool name mentioned in `<role>.tools.md` is in the
 *     role's surface. Stops a stale playbook from telling the model
 *     about tools it can't call.
 *   - (fail) Every tool name mentioned in `<role>.persona.md` is in
 *     the role's surface. Same reason — persona is loaded into the
 *     prompt verbatim; references must be valid.
 *   - (fail) Every `byRole.<role>` key in any tool's guidance
 *     references a real role. Catches typos like `byRole.workr`.
 *
 * Pure-static check — no operator process needed. Pattern matches
 * chat-surface-tools.mjs in the same directory.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const REPO = '/home/marsh-office/papercupai-workspace/papercup';
const PROMPTS_DIR = join(REPO, 'apps/operator/prompts');

// Roles known to the system. Must stay in sync with the AgentRole
// enum in @papercusp/plugin-sdk + lib/prompt-assembly.ts.
const KNOWN_ROLES = [
  'operator', 'oracle', 'worker', 'validator', 'scoper',
  'reviewer', 'debugger', 'architect', 'documenter', 'curator',
];

// Per-role tool-surface source. For chat surfaces we parse the
// allowedTools array from the route file; for spawn-URL roles the
// authoritative source is the catalog (collected below by scanning
// every defineTool / manifest entry's `roles: [...]` allowlist).
const CHAT_SURFACES = [
  {
    role: 'operator',
    label: 'operator-converse',
    allowedToolsSource: 'apps/operator/lib/operator-mcp-tools.ts',
  },
  // oracle has its own allowedTools inline; parse oracle.ts.
  {
    role: 'oracle',
    label: 'oracle',
    allowedToolsSource: 'apps/operator/app/api/_hono/oracle.ts',
  },
];

const NON_CHAT_ROLES = [
  'worker', 'validator', 'scoper', 'reviewer',
  'debugger', 'architect', 'documenter', 'curator',
];

let pass = 0, fail = 0, warn = 0;
const ok   = (n) => { console.log(`  ✓ ${n}`); pass++; };
const bad  = (n) => { console.log(`  ✗ ${n}`); fail++; };
const note = (n) => { console.log(`  ⚠ ${n}`); warn++; };

/* ─── Parse allowedTools out of a chat-surface route file ────────── */

function parseChatSurfaceAllowedTools(filepath) {
  const src = readFileSync(join(REPO, filepath), 'utf8');
  // Match every `mcp__agentmcp__<name>` reference. The route's
  // allowedTools array is the authoritative shape; we then strip the
  // prefix to get the catalog name.
  const matches = src.matchAll(/mcp__agentmcp__([a-zA-Z0-9_:.]+)/g);
  const names = new Set();
  for (const m of matches) {
    let n = m[1];
    // claude-code translates `.` → `_` for the LLM-facing name; our
    // catalog stores the original dotted name. Normalize both ways.
    names.add(n);
    if (n.includes('_')) names.add(n.replace(/_/g, '.'));
  }
  return names;
}

/* ─── Walk the catalog and collect guidance + role allowlists ────── */

const TOOL_FILES = [];
function findToolFiles(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findToolFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.includes('.test.') && !entry.startsWith('index.')) {
      out.push(full);
    }
  }
}
findToolFiles(join(REPO, 'packages/agent-mcp/src/tools'), TOOL_FILES);
findToolFiles(join(REPO, 'apps/operator/lib/agent-tools'), TOOL_FILES);

const PLUGIN_MANIFESTS = [];
function findPluginManifests(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findPluginManifests(full, out);
    else if (entry === 'papercusp.json') out.push(full);
  }
}
findPluginManifests(join(REPO, 'libs/papercusp/plugins'), PLUGIN_MANIFESTS);

/** Map mcpName → { roles: string[], hasGuidance: bool, byRoleKeys: string[], source: filepath } */
const CATALOG = new Map();

// Pass 1 — defineTool files in packages/agent-mcp + apps/operator/lib/agent-tools.
for (const file of TOOL_FILES) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('defineTool(')) continue;
  // Extract `name: '...'`
  const nameMatch = src.match(/name:\s*['"]([a-zA-Z0-9_:.]+)['"]/);
  if (!nameMatch) continue;
  const name = nameMatch[1];
  // roles: [...]
  const rolesMatch = src.match(/roles:\s*\[([^\]]*)\]/);
  const rolesStr = rolesMatch?.[1] ?? '';
  // ...ALL_ROLES short-form: treat as "every role".
  const allRolesSpread = /\.\.\.ALL_ROLES|\.\.\.AGENT_ROLES/.test(rolesStr);
  const roles = allRolesSpread
    ? [...KNOWN_ROLES]
    : [...rolesStr.matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]);
  // guidance block — detect presence of `guidance: {`.
  const hasGuidanceBlock = /guidance:\s*\{/.test(src);
  // when field specifically — the gate Phase 5 will enforce.
  const hasWhen = hasGuidanceBlock && /guidance:\s*\{[^}]*?when:\s*['"`]/s.test(src);
  // byRole keys — match `byRole: { worker: ..., scoper: ... }`.
  const byRoleMatch = src.match(/byRole:\s*\{([^}]*)\}/);
  const byRoleKeys = byRoleMatch
    ? [...byRoleMatch[1].matchAll(/(\w+):/g)].map((m) => m[1])
    : [];
  CATALOG.set(name, {
    roles,
    hasGuidance: hasGuidanceBlock,
    hasWhen,
    byRoleKeys,
    source: file.replace(REPO + '/', ''),
  });
}

// Pass 2 — plugin manifests (papercusp.json) — guidance lives in tools[i].guidance.
for (const file of PLUGIN_MANIFESTS) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(json.tools)) continue;
  for (const tool of json.tools) {
    // MCP-exposed name comes from expose.mcp.name; falls back to manifest name.
    const mcpName = tool.expose?.mcp?.name ?? `${json.name?.replace(/^@papercupai\//, '')}.${tool.name}`;
    const roles = Array.isArray(tool.roles) ? tool.roles : [];
    const hasGuidance = !!tool.guidance;
    const hasWhen = !!tool.guidance?.when;
    const byRoleKeys = tool.guidance?.byRole ? Object.keys(tool.guidance.byRole) : [];
    CATALOG.set(mcpName, {
      roles,
      hasGuidance,
      hasWhen,
      byRoleKeys,
      source: file.replace(REPO + '/', ''),
    });
  }
}

console.log(`Catalog scanned: ${CATALOG.size} tools, ${TOOL_FILES.length} defineTool files, ${PLUGIN_MANIFESTS.length} plugin manifests`);
console.log('');

/* ─── Per-role assertions ─────────────────────────────────────────── */

function parseToolMentions(md) {
  // Match backtick-wrapped tool names: `tool:name` or `tool.name`.
  // Exclude things that look like filenames or file paths — those
  // backtick-references aren't tool names (e.g. `operator.tools.md`,
  // `next.config.js`, `path/to/file.ts`).
  const FILE_SUFFIX = /\.(md|ts|tsx|js|jsx|mjs|cjs|json|sh|py|css|html|toml|yaml|yml)$/i;
  const mentions = new Set();
  for (const m of md.matchAll(/`([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-/]+)`/g)) {
    const candidate = m[1];
    if (FILE_SUFFIX.test(candidate)) continue;
    if (candidate.includes('/')) continue;
    mentions.add(candidate);
  }
  return mentions;
}

function checkRole(role, allowedNames, label) {
  console.log(`--- ${label} (${role}) ---`);

  // (warn) Every tool in the surface has guidance.when.
  let missingGuidance = 0;
  for (const name of allowedNames) {
    const entry = CATALOG.get(name);
    if (!entry) continue; // tool not in catalog scan (stale name or out-of-scope file)
    if (!entry.hasWhen) {
      missingGuidance += 1;
      if (missingGuidance <= 3) {
        note(`${name} — missing guidance.when (warn-only until Phase 5)`);
      }
    }
  }
  if (missingGuidance > 3) note(`...and ${missingGuidance - 3} more without guidance.when`);
  if (missingGuidance === 0) ok(`every tool in ${role}'s surface has guidance.when`);

  // (fail) Every tool mentioned in tools.md is in the role's surface.
  const toolsMdPath = join(PROMPTS_DIR, `${role}.tools.md`);
  if (existsSync(toolsMdPath)) {
    const md = readFileSync(toolsMdPath, 'utf8');
    const mentions = parseToolMentions(md);
    const stale = [...mentions].filter((n) => !allowedNames.has(n));
    if (stale.length === 0) {
      ok(`${role}.tools.md: every mentioned tool is in the role's surface`);
    } else {
      bad(`${role}.tools.md: mentions tools not in surface: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? '...' : ''}`);
    }
  } else {
    note(`${role}.tools.md not found (skipped mention-validation; expected before Phase 4 for spawn-URL roles)`);
  }

  // (fail) Every tool mentioned in persona.md is in the role's surface.
  const personaPath = join(PROMPTS_DIR, `${role}.persona.md`);
  if (existsSync(personaPath)) {
    const md = readFileSync(personaPath, 'utf8');
    const mentions = parseToolMentions(md);
    const stale = [...mentions].filter((n) => !allowedNames.has(n));
    if (stale.length === 0) {
      ok(`${role}.persona.md: every mentioned tool is in the role's surface`);
    } else {
      // Persona references often pre-date the guidance arc — surface
      // stale ones loudly, but be specific so the implementer can fix.
      bad(`${role}.persona.md: mentions tools not in surface: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? '...' : ''}`);
    }
  } else {
    note(`${role}.persona.md not found (skipped mention-validation)`);
  }
  console.log('');
}

for (const { role, label, allowedToolsSource } of CHAT_SURFACES) {
  const surfaceNames = parseChatSurfaceAllowedTools(allowedToolsSource);
  // Strip mcp__agentmcp__ prefix for matching against the catalog.
  const allowed = new Set([...surfaceNames]);
  checkRole(role, allowed, label);
}

for (const role of NON_CHAT_ROLES) {
  const catalogForRole = new Set();
  for (const [name, entry] of CATALOG) {
    if (entry.roles.length === 0) continue; // role-agnostic; not visible to a specific role
    if (entry.roles.includes(role)) catalogForRole.add(name);
  }
  if (catalogForRole.size === 0) {
    note(`${role}: no tools in catalog match this role's allowlist (skipping)`);
    continue;
  }
  checkRole(role, catalogForRole, role);
}

/* ─── byRole reference validation ─────────────────────────────────── */

console.log('--- byRole reference validation ---');
let byRoleProblems = 0;
for (const [name, entry] of CATALOG) {
  for (const key of entry.byRoleKeys) {
    if (!KNOWN_ROLES.includes(key)) {
      bad(`${name}: byRole.${key} — "${key}" is not a known role`);
      byRoleProblems += 1;
    }
  }
}
if (byRoleProblems === 0) ok('every byRole key references a known role');
console.log('');

/* ─── Summary ─────────────────────────────────────────────────────── */

console.log(`\nResult: ${pass} passed, ${fail} failed, ${warn} warnings`);
process.exit(fail > 0 ? 1 : 0);
