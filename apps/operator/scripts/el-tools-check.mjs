#!/usr/bin/env node
/**
 * el-tools-check.mjs — static drift check for el-agent-sync TOOLS list.
 *
 * Yesterday we hit "ElevenLabs runtime error: Client tool with name X is
 * not defined on client" because CommandDefs such as
 * operator.approve-pending were registered as `browser: 'optional'` in
 * the registry but pushed as `type: 'client'` in el-agent-sync's TOOLS
 * list. The browser exposes only browser:'required' commands as
 * client-tools, so the agent's tool list was a superset of the
 * browser's handler set, and runtime fired one of the missing ones.
 *
 * This script prevents that class of drift:
 *   - For every entry in el-agent-sync TOOLS with type:'client',
 *     verify a corresponding registry def exists with
 *       agents including 'operator'
 *       AND (kind=='command' implies browser=='required')
 *   - Cross-direction: warn (don't fail) about registry defs with
 *     agents:['operator',...] that AREN'T in TOOLS — those are the
 *     "you have a tool the agent can't see" case, less catastrophic
 *     than the inverse but still drift.
 *
 * Wire-in: el-agent-sync.mjs runs this as part of its preflight; CI /
 * affected-tests can run it directly. Standalone invocation:
 *   node apps/operator/scripts/el-tools-check.mjs
 *   exit 0 = no drift errors (warnings allowed)
 *   exit 1 = drift errors — fix before pushing
 * Pass --strict to make warnings also exit 1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(__dirname, '..');

// 1. Parse the TOOLS array from el-agent-sync.mjs by string match. The
//    file is JS we own so the regex is safe; if we ever switch the
//    format we update the parser.
const syncSource = fs.readFileSync(path.join(operatorRoot, 'scripts/el-agent-sync.mjs'), 'utf8');

const toolsArrayMatch = syncSource.match(/const TOOLS = \[([\s\S]*?)\n\];/);
if (!toolsArrayMatch) {
  console.error('[el-tools-check] could not locate const TOOLS = [...] in el-agent-sync.mjs');
  process.exit(1);
}
const syncTools = [];
for (const m of toolsArrayMatch[1].matchAll(/name:\s*'([\w_]+)',\s*type:\s*'(\w+)'/g)) {
  syncTools.push({ name: m[1], type: m[2] });
}
const syncClientNames = new Set(syncTools.filter((t) => t.type === 'client').map((t) => t.name));

// 2. Parse all CommandDef / QueryDef blocks from the registry defs dir.
//    The defs moved to operator-core in the SP1 extraction
//    (operator-core-headless-serve-2026-06-04); apps/operator/lib/commands/defs
//    is now an empty .gitkeep stub. We split each file by
//    `const NAME: CommandDef<...>` boundaries and pull id/agents/browser/kind
//    out of each block. Crude but stable enough for our hand-authored defs.
const defsDir = path.resolve(operatorRoot, '../../packages/operator-core/lib/commands/defs');
const defFiles = fs
  .readdirSync(defsDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts');

const defs = [];
for (const file of defFiles) {
  const content = fs.readFileSync(path.join(defsDir, file), 'utf8');
  const blocks = content.split(/^const \w+\s*[:=]/m).slice(1);
  for (const b of blocks) {
    const id = (b.match(/id:\s*'([\w.\-]+)'/) || [])[1];
    if (!id) continue;
    const agents = (b.match(/agents:\s*\[([^\]]+)\]/) || [])[1] || '';
    const agentList = agents.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    // Match the property assignment, not occurrences of the words
    // inside doc-comments. Anchor to start-of-line + whitespace.
    const browser = (b.match(/^\s*browser:\s*'(\w+)'/m) || [])[1];
    const kind = (b.match(/^\s*kind:\s*'(\w+)'/m) || [])[1];
    defs.push({ id, agents: agentList, browser, kind, file });
  }
}

// 3. Tool name normalization — must match el-agent-sync.mjs and
//    lib/voice-engines/elevenlabs-conv.ts (registry id → EL tool name).
const normalize = (id) => id.replace(/[.-]/g, '_');

const operatorDefsByToolName = new Map();
for (const d of defs) {
  if (!d.agents.includes('operator')) continue;
  operatorDefsByToolName.set(normalize(d.id), d);
}

// 4. Cross-check.
const errors = [];
const warnings = [];

// Tools that intentionally bypass the registry — handled directly in
// buildClientTools() in elevenlabs-conv.ts. Drift check skips them.
//   ask_operator    — brain delegate; calls /api/agent-mcp/operator-converse
//   end_conversation — session lifecycle; calls conv.endSession()
const REGISTRY_EXEMPT = new Set(['ask_operator', 'end_conversation']);

for (const toolName of syncClientNames) {
  if (REGISTRY_EXEMPT.has(toolName)) continue;
  const def = operatorDefsByToolName.get(toolName);
  if (!def) {
    errors.push(
      `${toolName}: pushed as client-tool to EL but no registry def with agents:['operator',...] — ` +
      'agent will call it and crash with "Client tool not defined on client". ' +
      'Either register the def or remove the entry from TOOLS.',
    );
    continue;
  }
  if (def.kind === 'command' && def.browser !== 'required') {
    errors.push(
      `${toolName} (${def.id} in ${def.file}): registered as browser:'${def.browser ?? 'unset'}' but pushed as client-tool. ` +
      'buildClientTools only exposes browser:\'required\' commands; ' +
      'agent will call it and crash. Promote browser to \'required\'.',
    );
  }
}

// 5. Inverse direction: registry has operator-tagged defs not in TOOLS.
//    These won't crash the agent; they're just invisible to it. Warn
//    rather than fail — defs may be used by oracle/palette only.
for (const [toolName, def] of operatorDefsByToolName) {
  if (syncClientNames.has(toolName)) continue;
  // Only flag commands+queries that look like reasonable agent tools —
  // skip aliases (nav.harness duplicates navigate, etc.).
  if (def.id === 'nav.papercusp') continue;
  warnings.push(
    `${toolName} (${def.id} in ${def.file}): registry def is operator-tagged but missing from TOOLS list. ` +
    'EL agent can\'t call it. Add to TOOLS if intended.',
  );
}

// 6. Report.
if (errors.length === 0 && warnings.length === 0) {
  console.log(`[el-tools-check] ✓ aligned — ${syncClientNames.size} client tools, all backed by registry defs.`);
  process.exit(0);
}

if (errors.length > 0) {
  console.error(`[el-tools-check] ✗ ${errors.length} drift error${errors.length > 1 ? 's' : ''}:`);
  for (const e of errors) console.error(`  - ${e}`);
}
if (warnings.length > 0) {
  console.error(`[el-tools-check] ${warnings.length} warning${warnings.length > 1 ? 's' : ''}:`);
  for (const w of warnings) console.error(`  - ${w}`);
}

const strict = process.argv.includes('--strict');
process.exit(errors.length > 0 || (strict && warnings.length > 0) ? 1 : 0);
