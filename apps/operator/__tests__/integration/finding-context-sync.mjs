#!/usr/bin/env node
/**
 * Drift test for apps/operator/content/docs/agents/finding-context.mdx.
 *
 * This page is prompt-injected into every spawned agent (orchestrator
 * loads it via Path B in libs/papercusp/packages/orchestrator/src/invoke.ts).
 * If it drifts — references a renamed tool, exceeds the budget, or
 * names a tool that does not exist in the catalog — every spawn pays
 * tokens for stale guidance.
 *
 * Assertions:
 *   - (fail) Page exists at the expected path.
 *   - (fail) Page is ≤200 lines (token-budget cap).
 *   - (warn) Every `tool:name`-shaped token in backticks resolves to
 *     a real defineTool entry. (Warn so anti-pattern lists ("don't use
 *     X") don't fail; flip to fail if false positives become real.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const PAGE_PATH = join(REPO_ROOT, 'content/docs/agents/finding-context.mdx');
const MAX_LINES = 200;

let failed = false;
let warned = false;

function fail(msg) {
  console.error(`[fail] ${msg}`);
  failed = true;
}
function warn(msg) {
  console.warn(`[warn] ${msg}`);
  warned = true;
}

// 1. Exists.
if (!existsSync(PAGE_PATH)) {
  fail(`finding-context.mdx not found at ${PAGE_PATH}`);
  process.exit(1);
}

const text = readFileSync(PAGE_PATH, 'utf8');
const lines = text.split('\n');

// 2. Line budget.
if (lines.length > MAX_LINES) {
  fail(`page is ${lines.length} lines, max ${MAX_LINES}`);
} else {
  console.log(`✓ page is ${lines.length} lines (limit ${MAX_LINES})`);
}

// 3. Tool name references resolve.
//    Match `<scope>:<verb>` tokens inside backticks. Skip ones that
//    show up alongside negation cues (anti-pattern bullets) to avoid
//    false positives on "don't use foo:bar" copy.
const toolRefs = new Set();
const re = /`([a-z][a-z0-9_]*:[a-z][a-z0-9_]*)`/g;
for (const line of lines) {
  // Cheap negation cue: skip lines starting with "Don't" or containing "instead of"
  if (/^\s*[-*]?\s*Don't\b|don't use\b|instead of/i.test(line)) continue;
  let m;
  while ((m = re.exec(line)) !== null) toolRefs.add(m[1]);
}

if (toolRefs.size === 0) {
  console.log('✓ no tool references found (page may be content-light)');
} else {
  // Read the live tool catalog by importing the agent-tools side-effect
  // index and reading from registry. Cheaper: just grep for `name: '<tool>'`
  // in agent-tools and plugin manifests.
  const grepArgs = [
    '-r',
    '-h',
    '-oE',
    "name:\\s*['\"][a-z][a-z0-9_]*:[a-z][a-z0-9_]*['\"]",
    'lib/agent-tools',
    '../../packages/agent-mcp/src/tools',
  ];
  const res = spawnSync('grep', grepArgs, { cwd: REPO_ROOT, encoding: 'utf8' });
  const found = new Set();
  for (const line of (res.stdout || '').split('\n')) {
    const m = /name:\s*['"]([^'"]+)['"]/.exec(line);
    if (m) found.add(m[1]);
  }
  // Plugin tools live in libs/papercusp/plugins/*/papercusp.json — grep those.
  const pluginRes = spawnSync(
    'sh',
    ['-c', `find ../../libs/papercusp/plugins -name papercusp.json -exec cat {} +`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  for (const m of (pluginRes.stdout || '').matchAll(/"name":\s*"([^"]+)"/g)) {
    found.add(m[1]);
  }
  for (const ref of toolRefs) {
    if (!found.has(ref)) warn(`tool reference \`${ref}\` not found in agent-tools or plugin manifests`);
  }
  console.log(`✓ checked ${toolRefs.size} tool references against ${found.size} registered tools`);
}

if (failed) {
  console.error('FAIL: finding-context.mdx drift test failed');
  process.exit(1);
}
if (warned) {
  console.warn('PASS with warnings');
} else {
  console.log('PASS');
}
process.exit(0);
