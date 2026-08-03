#!/usr/bin/env node
/**
 * check-full-replacement-mocks.mjs — the recurrence guard for the "new export strands
 * N hand-rolled vi.mock factories" class (WI-7187, WI-7185, and at least one prior
 * occurrence with `resolveSpawnBackendModel`).
 *
 * THE CLASS. `vi.mock('<mod>', () => ({ ... }))` is a FULL-REPLACEMENT factory: it must
 * enumerate every export the subject imports. Vitest 4 validates the mock against the
 * importer's named-import surface at LINK time, so adding ANY export to a module that is
 * full-replacement-mocked silently strands every such factory whose subject then imports
 * it. Nothing catches that between "author adds an export" and "the fleet green-checkpoint
 * reds hours later" — that detector gap is what this closes.
 *
 * THE SAFE FORM, already present in the tree, is to spread the real module and override
 * only what the test controls — immune to new exports BY CONSTRUCTION:
 *
 *   vi.mock('../../adv-sessions', async (orig) => ({
 *     ...(await orig<typeof import('../../adv-sessions')>()),
 *     recordedLiveOwnerIds: vi.fn(async () => new Set()),
 *   }));
 *
 * WHY A REGISTRY AND NOT A TREE-WIDE RULE. Measured 2026-08-03: 1,007 internal modules
 * have >=1 full-replacement mocker and 2,827 test files would violate a blanket rule
 * (`workspace-registry` alone has 313 mockers). A blanket rule is therefore permanently
 * red or needs a 2,800-entry allowlist — unshippable, and an ignored guard misses the real
 * one. So the guard is scoped to a REGISTRY of modules that have actually cost us an
 * incident. Adding a module here is cheap to decide and explicit about its cost: you must
 * convert that module's existing mockers first (a mechanical rewrite of the factory head).
 *
 *   node scripts/check-full-replacement-mocks.mjs             # check (exit 1 on violation)
 *   node scripts/check-full-replacement-mocks.mjs --self-test # prove the analyzer's teeth
 *   node scripts/check-full-replacement-mocks.mjs --list      # registry + live mocker census
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Modules whose mock factories MUST use the import-actual spread.
 * Repo-relative, extensionless. Each entry costs a one-time conversion of its mockers.
 */
export const PROTECTED_MODULES = [
  {
    module: 'packages/operator-core/lib/adv-sessions',
    why: 'WI-7187: 45 exports, 26 full-replacement mockers; adding `recordSuLaunchSpec` stranded 3 files and red-pinned the fleet gate (WI-7185). Converted 2026-08-03.',
  },
];

// ---------------------------------------------------------------------------
// Pure analyzer — no I/O, so synthetic fixtures can prove it fires on the real
// shape AND stays silent for every safe form.
// ---------------------------------------------------------------------------

/** Scan forward from `open` (index of a '(') to its matching ')', skipping strings/comments. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      for (; i < text.length; i += 1) {
        if (text[i] === '\\') { i += 1; continue; }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the top-level ',' inside a call's argument list, or -1. */
function firstTopLevelComma(text, open, close) {
  let depth = 0;
  for (let i = open; i < close; i += 1) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl === -1 ? close : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? close : end + 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      for (; i < close; i += 1) { if (text[i] === '\\') { i += 1; continue; } if (text[i] === quote) break; }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 1) return i;
  }
  return -1;
}

const MOCK_CALL = /\bvi\.(?:mock|doMock)\s*\(/g;
const SPEC_HEAD = /^\s*(['"])([^'"]+)\1/;

/**
 * Classify every vi.mock/vi.doMock call in one source file.
 * Returns [{ spec, form, line }] where form is:
 *   'automock'       — no factory: vitest synthesises the WHOLE surface, cannot strand
 *   'import-actual'  — factory receives importOriginal, or calls vi.importActual: immune
 *   'full-replacement' — bare `() => ({...})`: strands on any new export the subject imports
 */
export function analyzeMockCalls(text) {
  const out = [];
  MOCK_CALL.lastIndex = 0;
  let m;
  while ((m = MOCK_CALL.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close === -1) continue;
    const specMatch = SPEC_HEAD.exec(text.slice(open + 1, close));
    if (!specMatch) continue;
    const spec = specMatch[2];
    const comma = firstTopLevelComma(text, open, close);
    const line = text.slice(0, m.index).split('\n').length;
    if (comma === -1) {
      out.push({ spec, form: 'automock', line });
      MOCK_CALL.lastIndex = close;
      continue;
    }
    const factory = text.slice(comma + 1, close);
    // A factory that takes a parameter receives vitest's importOriginal; one that calls
    // vi.importActual/importOriginal itself is equally immune. Everything else enumerates.
    const takesParam = /^\s*(?:async\s*)?\(\s*[A-Za-z_$]/.test(factory);
    const usesImportActual = /\bimportActual\b|\bimportOriginal\b/.test(factory);
    out.push({
      spec,
      form: takesParam || usesImportActual ? 'import-actual' : 'full-replacement',
      line,
    });
    MOCK_CALL.lastIndex = close;
  }
  return out;
}

/** Resolve a relative mock specifier against the mocking file, extensionless + repo-relative. */
export function resolveSpec(filePath, spec) {
  if (!spec.startsWith('.')) return null;
  const joined = normalize(join(dirname(filePath), spec));
  return joined.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

/** Pure check of ONE file against the protected set. Returns violations. */
export function checkFile({ path, text, protectedModules }) {
  const violations = [];
  for (const call of analyzeMockCalls(text)) {
    if (call.form !== 'full-replacement') continue;
    const resolved = resolveSpec(path, call.spec);
    if (!resolved) continue;
    const hit = protectedModules.find((p) => p.module === resolved);
    if (hit) violations.push({ path, line: call.line, spec: call.spec, module: hit.module, why: hit.why });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Self-test — the guard must fire on the real shape and stay silent for each
// safe form. A run reporting "0 violations" on a clean tree would pass
// identically with the condition inverted, so teeth are proven here, not there.
// ---------------------------------------------------------------------------

export const FIXTURE_PROTECTED = [{ module: 'packages/operator-core/lib/adv-sessions', why: 'fixture' }];
const FIXTURE_PATH = 'packages/operator-core/lib/agent-tools/fleet/x.test.ts';

/**
 * The fixtures live HERE, not in the vitest guard test, and that is load-bearing rather
 * than tidiness: a fixture is mock SOURCE TEXT, so a `.test.ts` holding one is itself a
 * test file containing a bare `vi.mock` of a protected module — the live scan flags its
 * own guard test. That actually happened while building this (`'./adv-sessions'` inside
 * the guard test resolved to exactly the protected module). Keeping the fixtures in a
 * `.mjs` the scan never treats as a test removes the self-match by construction, instead
 * of papering over it with a self-exclusion that would also blind the guard to a real
 * violation in that file. The vitest test drives THESE cases, so the two can never drift.
 */
export const SELF_TESTS = [
  {
    name: 'FIRES on the bare full-replacement factory (the real WI-7187 shape)',
    path: FIXTURE_PATH,
    text: `vi.mock('../../adv-sessions', () => ({ recordedLiveOwnerIds: vi.fn(async () => new Set()) }));`,
    expect: 1,
  },
  {
    name: 'silent for the import-actual spread (the prescribed fix)',
    path: FIXTURE_PATH,
    text: `vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), a: 1 }));`,
    expect: 0,
  },
  {
    name: 'silent for an async factory calling vi.importActual itself',
    path: FIXTURE_PATH,
    text: `vi.mock('../../adv-sessions', async () => ({ ...(await vi.importActual('../../adv-sessions')), a: 1 }));`,
    expect: 0,
  },
  {
    name: 'silent for a bare automock (vitest synthesises the whole surface)',
    path: FIXTURE_PATH,
    text: `vi.mock('../../adv-sessions');`,
    expect: 0,
  },
  {
    name: 'silent for the SAME bad shape on an UNPROTECTED module (precision, not zeal)',
    path: FIXTURE_PATH,
    text: `vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn() }));`,
    expect: 0,
  },
  {
    name: 'FIRES through a multi-line factory body with braces, strings and comments',
    path: FIXTURE_PATH,
    text: [
      `vi.mock('../../adv-sessions', () => ({`,
      `  // a comment with a stray ) paren and 'quote`,
      `  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),`,
      `  listRecordedLiveSessions: vi.fn(async () => [{ id: 1 }]),`,
      `}));`,
    ].join('\n'),
    expect: 1,
  },
  {
    name: 'FIRES on vi.doMock too',
    path: FIXTURE_PATH,
    text: `vi.doMock('../../adv-sessions', () => ({ a: vi.fn() }));`,
    expect: 1,
  },
  {
    name: 'silent when the specifier resolves ELSEWHERE (same basename, different dir)',
    path: 'packages/operator-core/lib/pot/y.test.ts',
    text: `vi.mock('./adv-sessions', () => ({ a: vi.fn() }));`,
    expect: 0,
  },
];

function runSelfTest() {
  let failed = 0;
  for (const t of SELF_TESTS) {
    const got = checkFile({ path: t.path, text: t.text, protectedModules: FIXTURE_PROTECTED }).length;
    const ok = got === t.expect;
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${t.name} (expected ${t.expect}, got ${got})`);
  }
  console.log(`\n${SELF_TESTS.length - failed}/${SELF_TESTS.length} self-tests passed`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Thin I/O shell
// ---------------------------------------------------------------------------

/** Test files that could possibly mention a protected module — cheap substring pre-filter. */
export function collectCandidateFiles({ listFiles, read, protectedModules }) {
  const needles = protectedModules.map((p) => p.module.split('/').pop());
  const out = [];
  for (const f of listFiles()) {
    const text = read(f);
    if (text === null) continue;
    if (!needles.some((n) => text.includes(n))) continue;
    out.push({ path: f, text });
  }
  return out;
}

function gitTestFiles() {
  const out = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(runSelfTest() ? 0 : 1);

  const read = (f) => {
    try {
      return readFileSync(join(ROOT, f), 'utf8');
    } catch {
      return null;
    }
  };
  const candidates = collectCandidateFiles({
    listFiles: gitTestFiles,
    read,
    protectedModules: PROTECTED_MODULES,
  });

  if (argv.includes('--list')) {
    console.log(`protected modules (${PROTECTED_MODULES.length}):\n`);
    for (const p of PROTECTED_MODULES) {
      let full = 0;
      let safe = 0;
      for (const c of candidates) {
        for (const call of analyzeMockCalls(c.text)) {
          if (resolveSpec(c.path, call.spec) !== p.module) continue;
          if (call.form === 'full-replacement') full += 1;
          else safe += 1;
        }
      }
      console.log(`  ${p.module}\n      mockers: ${safe} safe, ${full} full-replacement\n      ${p.why}\n`);
    }
    process.exit(0);
  }

  const violations = candidates.flatMap((c) =>
    checkFile({ path: c.path, text: c.text, protectedModules: PROTECTED_MODULES }),
  );

  if (violations.length === 0) {
    console.log(
      `✓ full-replacement-mocks: ${PROTECTED_MODULES.length} protected module(s), ` +
        `${candidates.length} candidate test file(s) scanned — no bare vi.mock factories.`,
    );
    process.exit(0);
  }

  console.error(
    `✗ full-replacement-mocks: ${violations.length} bare vi.mock factor(y/ies) on a PROTECTED module.\n`,
  );
  console.error('  A bare `() => ({ ... })` factory enumerates the exports it happens to need today, so the');
  console.error('  next export added to that module silently strands it and reds the fleet gate hours later.');
  console.error('  Spread the real module instead and override only what the test controls:\n');
  console.error("    vi.mock('<spec>', async (orig) => ({ ...(await orig<typeof import('<spec>')>()), ...overrides }));\n");
  for (const v of violations) {
    console.error(`    ${v.path}:${v.line}  →  ${v.spec}`);
    console.error(`        protected: ${v.module}`);
    console.error(`        ${v.why}`);
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
