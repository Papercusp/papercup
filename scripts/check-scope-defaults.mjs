#!/usr/bin/env node
/**
 * check-scope-defaults.mjs — the recurrence guard for silent workspace/harness/scope
 * defaults (workspace-data-isolation-leaks-2026-06-17 P-007 / D-003).
 *
 * The rule (D-003): a function designed to take a workspace / harness / scope must
 * REQUIRE it, or fail loud via the existing fail-loud resolvers (`_harness-scope.ts
 * resolveHarnessScope`, `_hive-scope.ts resolveHiveScope`, `plans/source.ts
 * resolvePlanScope`). A silent `?? 'default'` / `|| DEFAULT_WORKSPACE_ID` / `?? 'operator'`
 * on a SCOPE value is the smell — the shared root cause of BOTH cross-workspace data
 * mixing AND the null-harness work-item invisibility. An empty/missing scope collapsed to
 * a single bucket silently reads/writes the WRONG partition.
 *
 * What this flags: a nullish/or default whose IMMEDIATE left-hand identifier names a
 * workspace / harness / hive / scope value AND defaults to one of the scope literals
 * `'default'` / `DEFAULT_WORKSPACE_ID` / `'operator'` (incl. the `"…"` forms), in source
 * `.ts` (not `.tsx` UI, not tests). A genuinely-global default ("operator/all is the
 * explicit documented scope here") is allowed — mark it with an inline `allow-scope-default`
 * comment (reason at the site), or add an inherently-exempt file to FILE_ALLOW.
 *
 * What it deliberately does NOT flag: a bare `?? ''` / `?? ""`. The empty-string default is
 * too ambiguous for a static lint (a controlled-input value, a copy-text fallback, and a
 * scope collapse all look identical); those are fixed at the specific sites (P-003) and
 * caught in review. This lint targets the unambiguous scope LITERALS.
 *
 *   node scripts/check-scope-defaults.mjs           # report (advisory)
 *   node scripts/check-scope-defaults.mjs --strict  # exit 1 on any un-allowed default
 *
 * Advisory by default (scope-LHS detection is a heuristic, like lint:generic-first /
 * lint:env-feature-gates). Flip the CI wiring to --strict once the Phase-3 remediation
 * (P-001..P-006) lands clean.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

// Inline marker (same line, or the line above) that documents an intentional, explicit
// global/local scope default and suppresses the finding. Keep the reason at the site.
const ALLOW_MARKER = 'allow-scope-default';

// Whole files inherently exempt: the constant's own home, the lexical browser fallback,
// the process-pin reader, the global-workspace resolver, and the fail-loud resolvers
// themselves (which reference the literals only in their operator-home branch / error text).
const FILE_ALLOW = new Set([
  'packages/operator-core/lib/workspace-id-constant.ts',
  'packages/operator-core/lib/browser-workspace.ts',
  'packages/operator-core/lib/dock-layouts.ts',
  'packages/operator-core/lib/workspace-registry.ts', // resolves THE global/current workspace
  'packages/operator-core/lib/agent-tools/_harness-scope.ts',
  'packages/operator-core/lib/agent-tools/_hive-scope.ts',
  'packages/operator-core/lib/agent-tools/plans/source.ts',
  'packages/operator-core/lib/llm-testing/targets/operator.ts', // LLM-test target's test-workspace header
]);

// The scope literals a `??`/`||` may default to (the unambiguous ones).
const LITERAL = "(?:DEFAULT_WORKSPACE_ID\\b|'default'|\"default\"|'operator'|\"operator\")";
const OP_LITERAL_RE = new RegExp(`(\\?\\?|\\|\\|)\\s*${LITERAL}`);
// The IMMEDIATE left-hand identifier chain (the token run just before the operator).
const LHS_TOKEN_RE = /([\w.$?![\]'"]+)\s*$/;
// That LHS must name a scope value.
const SCOPE_LHS_RE = /(workspace|harness|hive|scope|callerWs|\bws\b)/i;

// Test / test-support files poke scope freely — not production leaks.
function isTestFile(file) {
  return (
    file.endsWith('.test.ts') ||
    file.endsWith('.test.tsx') ||
    file.includes('/__tests__/') ||
    file.includes('/test/') ||
    /testbed|_test|\.bench\./.test(file)
  );
}

// A match inside a // line-comment or a /* */ / * doc-comment line is prose, not code.
function isCommentMatch(content, idx) {
  const before = content.slice(0, idx);
  const trimmed = content.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  // A `//` earlier on the line (not inside a string) starts a trailing comment.
  const slashIdx = before.indexOf('//');
  return slashIdx >= 0 && slashIdx < idx;
}

let raw = '';
try {
  raw = execFileSync(
    'git',
    [
      'grep',
      '-nE',
      `(\\?\\?|\\|\\|)\\s*(DEFAULT_WORKSPACE_ID|'default'|\"default\"|'operator'|\"operator\")`,
      '--',
      'packages/',
      'apps/',
      'libs/',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
} catch (e) {
  if (e.status === 1) raw = ''; // git grep exits 1 on no matches
  else throw e;
}

const lines = raw.split('\n');
// file -> { lineno -> content } so we can peek the preceding line for an allow marker.
const byFileLine = new Map();
for (const line of lines) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, lineno, content] = m;
  if (!byFileLine.has(file)) byFileLine.set(file, new Map());
  byFileLine.get(file).set(Number(lineno), content);
}

const hits = [];
for (const line of lines) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) continue;
  const [, file, linenoStr, content] = m;
  const lineno = Number(linenoStr);
  if (!file.endsWith('.ts')) continue; // server .ts only — .tsx is UI render state
  if (isTestFile(file)) continue;
  if (FILE_ALLOW.has(file)) continue;

  const dm = content.match(OP_LITERAL_RE);
  if (!dm) continue;
  if (isCommentMatch(content, dm.index)) continue;

  // The immediate LHS identifier must name a scope value (not, e.g., `role ?? 'operator'`).
  const lhs = content.slice(0, dm.index).match(LHS_TOKEN_RE)?.[1] ?? '';
  if (!SCOPE_LHS_RE.test(lhs)) continue;

  if (content.includes(ALLOW_MARKER)) continue;
  if ((byFileLine.get(file)?.get(lineno - 1) ?? '').includes(ALLOW_MARKER)) continue;

  hits.push({ file, lineno, content: content.trim() });
}

if (hits.length === 0) {
  console.log(
    "check-scope-defaults: clean — no silent workspace/harness scope default " +
      "(?? 'default' / || DEFAULT_WORKSPACE_ID / ?? 'operator') outside the allow-list.",
  );
  process.exit(0);
}

const byFileHits = new Map();
for (const h of hits) {
  if (!byFileHits.has(h.file)) byFileHits.set(h.file, []);
  byFileHits.get(h.file).push(h);
}

console.log(`\ncheck-scope-defaults: ${hits.length} silent scope-default(s) in ${byFileHits.size} file(s):\n`);
for (const [file, fhits] of [...byFileHits].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${file}`);
  for (const h of fhits) console.log(`    ${h.lineno}: ${h.content.slice(0, 110)}`);
}
console.log(
  `\nEach: route the value through a fail-loud resolver (resolveHarnessScope / resolveHiveScope /\n` +
    `resolvePlanScope) or REQUIRE it (throw on missing) — never silently default a workspace/harness.\n` +
    `If a site genuinely means a specific global/local scope, add an inline \`${ALLOW_MARKER}\` marker\n` +
    `comment (with the reason), or add an inherently-exempt file to FILE_ALLOW in this script.\n` +
    `Rule: workspace-data-isolation-leaks-2026-06-17 P-007 / D-003.\n`,
);
process.exit(STRICT ? 1 : 0);
