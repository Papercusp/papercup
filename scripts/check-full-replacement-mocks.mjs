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
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Modules whose mock factories MUST use the import-actual spread.
 *
 * An entry is EITHER a repo-relative extensionless path (for a module mocked by relative
 * specifier) OR a bare package specifier exactly as tests write it (`@papercusp/agent-mcp`,
 * `@papercusp/flags/server`). Sub-path exports are DISTINCT modules with distinct export
 * surfaces, so `@papercusp/flags` and `@papercusp/flags/server` must be listed separately.
 * Each entry costs a one-time conversion of its mockers.
 */
export const PROTECTED_MODULES = [
  {
    module: 'packages/operator-core/lib/adv-sessions',
    why: 'WI-7187: 45 exports, 26 full-replacement mockers; adding `recordSuLaunchSpec` stranded 3 files and red-pinned the fleet gate (WI-7185). Converted 2026-08-03.',
  },
  {
    module: '@papercusp/agent-mcp',
    why: 'WI-39707: adding `AGENT_ROLES` to a module-scope deref (agent-tools/testing/run.ts, via rubrics-criterion-checks) stranded 7 hand-listed factories in lib/agent-tools/memory/ and took BOTH operator-core lanes red as a COLLECTION crash. 50 full-replacement mockers converted 2026-08-17.',
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
 *
 * MATCH ON MASKED, READ ON RAW — the one shape neither stripper alone can express.
 * This analyzer needs BOTH halves at once: the CALL is code (a `vi.mock(` quoted inside a
 * template-literal fixture or a doc comment is data, and matching it mints a phantom
 * offender), but the SPECIFIER it must extract IS a string literal — so
 * `stripCommentsAndStrings` wholesale would delete the very thing SPEC_HEAD reads and turn
 * every real call into a silent pass. Measured 2026-08-10: 17 `vi.mock(` tokens on the live
 * corpus sit inside a string or comment, ~15 of which this analyzer reported as real calls;
 * none is a violation only because PROTECTED_MODULES currently holds one module, so the red
 * gate was latent, not absent. The header of THIS file is itself such a site, which is the
 * structural reason guards mint phantoms from their own prose.
 *
 * The mask is LENGTH-PRESERVING (contents blanked, delimiters kept), so an offset in `scan`
 * means exactly what it means in `text`: find positions on `scan`, read values from `text`.
 * Structure detection is strictly BETTER on the masked text — a paren or comma inside a
 * string or a regex body can no longer confuse matchParen/firstTopLevelComma — and the
 * import-actual escape is read from `scan` too, so a factory that merely NAMES
 * `importActual` in a string no longer buys immunity it has not earned.
 *
 * @param {string} text      raw source
 * @param {string} [fileName] real path — picks the ScriptKind for the parse (.ts vs .tsx)
 */
export function analyzeMockCalls(text, fileName) {
  const out = [];
  const scan = stripCommentsAndStrings(text, fileName);
  MOCK_CALL.lastIndex = 0;
  let m;
  while ((m = MOCK_CALL.exec(scan))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(scan, open);
    if (close === -1) continue;
    // The ONE read that must come from the raw text: the specifier lives inside the quotes
    // the mask just emptied. Same offsets, because the mask preserves length.
    const specMatch = SPEC_HEAD.exec(text.slice(open + 1, close));
    if (!specMatch) continue;
    const spec = specMatch[2];
    const comma = firstTopLevelComma(scan, open, close);
    const line = text.slice(0, m.index).split('\n').length;
    if (comma === -1) {
      out.push({ spec, form: 'automock', line });
      MOCK_CALL.lastIndex = close;
      continue;
    }
    const factory = scan.slice(comma + 1, close);
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

/**
 * Resolve a mock specifier to the MODULE IDENTITY the registry is keyed by.
 *
 * A RELATIVE specifier is resolved against the mocking file (extensionless, repo-relative),
 * because the same `'./x'` means a different module from each directory.
 *
 * A BARE specifier (`@papercusp/agent-mcp`, `nuqs`, `node:child_process`) is ALREADY a
 * global identity, so it is returned verbatim. Returning `null` for these — the behaviour
 * until WI-39707 — made every package-mocking factory structurally invisible to this guard,
 * which is the entire population that actually reds the gate: measured 2026-08-17, bare
 * specifiers carry 174 full-replacement factories on `@papercusp/db-org`, 151 on
 * `@papercusp/sync` and 50 on `@papercusp/agent-mcp`, against 26 for the one relative
 * module the registry had protected. The guard was watching the small half of the class.
 *
 * Sub-path exports stay DISTINCT (`@papercusp/flags` !== `@papercusp/flags/server`): they
 * have different export surfaces, so collapsing them would both miss strandings and mint
 * false ones.
 */
export function resolveSpec(filePath, spec) {
  if (!spec.startsWith('.')) return spec;
  const joined = normalize(join(dirname(filePath), spec));
  return joined.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

/** Pure check of ONE file against the protected set. Returns violations. */
export function checkFile({ path, text, protectedModules }) {
  const violations = [];
  for (const call of analyzeMockCalls(text, path)) {
    if (call.form !== 'full-replacement') continue;
    const resolved = resolveSpec(path, call.spec);
    if (!resolved) continue;
    const hit = protectedModules.find((p) => p.module === resolved);
    if (hit) violations.push({ path, line: call.line, spec: call.spec, module: hit.module, why: hit.why });
  }
  return violations;
}

/**
 * The guard's OWN BLIND SPOT, measured — the population carrying the risky shape on modules
 * the registry does NOT cover.
 *
 * EI-20836231573383362: this guard passed `✓ ... 327 candidate test file(s) scanned — no bare
 * vi.mock factories` at 20:24Z while a bare `@papercusp/db-org` factory had been sitting in
 * sync-resolver/learning-knowledge-scout.test.ts for ~3 weeks, breaking COLLECTION of that
 * whole file. The scan was CORRECT — db-org is not a protected module — but the verdict read
 * as a tree-wide all-clear, and was used as one ("lint:full-replacement-mocks passed, so bare
 * factories are not the problem"). A bounded measurement rendered as an unbounded verdict is
 * indistinguishable from a real zero, which is the specific way this guard was worse than no
 * guard: it supplied positive evidence for a conclusion it never tested.
 *
 * So the pass path reports BOTH halves of one measurement — what was checked and what is
 * structurally out of scope. Deriving them from the SAME parse of the SAME corpus is the
 * point: a scope note computed separately could drift from the check it qualifies.
 */
export function exposureCensus({ files, protectedModules }) {
  const protectedSet = new Set(protectedModules.map((p) => p.module));
  const byModule = new Map();
  for (const f of files) {
    for (const call of analyzeMockCalls(f.text, f.path)) {
      if (call.form !== 'full-replacement') continue;
      const resolved = resolveSpec(f.path, call.spec);
      if (!resolved || protectedSet.has(resolved)) continue;
      if (!byModule.has(resolved)) byModule.set(resolved, new Set());
      byModule.get(resolved).add(f.path);
    }
  }
  const top = [...byModule.entries()]
    .map(([module, set]) => ({ module, files: set.size, internal: isInternalModule(module) }))
    .sort((a, b) => b.files - a.files || a.module.localeCompare(b.module));
  return {
    modules: top.length,
    pairs: top.reduce((n, r) => n + r.files, 0),
    internalModules: top.filter((r) => r.internal).length,
    top,
  };
}

/**
 * Render the scope qualifier that travels with a PASS. Pure, so a test can pin the one
 * property that matters: a non-zero exposure must never render as an unqualified all-clear.
 */
export function printExposureNote(exposure) {
  if (exposure.modules === 0) {
    return (
      '  SCOPE: every module carrying a bare full-replacement factory is in the registry — ' +
      'this IS a tree-wide all-clear.'
    );
  }
  const lines = [
    `  ⚠ SCOPE — NOT a tree-wide all-clear. ${exposure.modules} unprotected module(s) ` +
      `(${exposure.internalModules} internal) still carry ${exposure.pairs} bare ` +
      `full-replacement factor(y/ies).`,
    '    They are OUT OF SCOPE for this guard and were NOT checked, so a green here does not',
    '    mean "bare factories are not the problem" — it means none reached a REGISTERED module.',
    '    Largest unprotected exposures (promoting one costs converting its mockers first):',
  ];
  for (const r of exposure.top.slice(0, 5)) {
    lines.push(`      ${String(r.files).padStart(4)} file(s)  ${r.module}`);
  }
  lines.push('    Full census: node scripts/check-full-replacement-mocks.mjs --list');
  return lines.join('\n');
}

/**
 * Internal modules are the ACTIONABLE half of the exposure: our own export surfaces change
 * on any ordinary commit, whereas a third-party surface (`nuqs`, `sonner`) moves only on a
 * deliberate upgrade. Both can strand a factory, so both are counted — but a reader deciding
 * what to promote next needs them separated, or the total reads as undifferentiated noise.
 */
function isInternalModule(module) {
  return (
    module.startsWith('@papercusp/') ||
    module.startsWith('@/') ||
    module.startsWith('packages/') ||
    module.startsWith('apps/') ||
    module.startsWith('libs/')
  );
}

// ---------------------------------------------------------------------------
// Self-test — the guard must fire on the real shape and stay silent for each
// safe form. A run reporting "0 violations" on a clean tree would pass
// identically with the condition inverted, so teeth are proven here, not there.
// ---------------------------------------------------------------------------

export const FIXTURE_PROTECTED = [
  { module: 'packages/operator-core/lib/adv-sessions', why: 'fixture' },
  { module: '@papercusp/agent-mcp', why: 'fixture (bare package specifier)' },
];
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
  // The phantom half. A guard's own test necessarily QUOTES the offending shape it asserts
  // on, so these are the sites most likely to contain it — which is why the fixtures below
  // are the ones that used to force a self-exclusion instead of a fix.
  {
    name: 'silent when the whole call sits inside a template-literal fixture (phantom)',
    path: FIXTURE_PATH,
    text: [
      'const badShape = `',
      `vi.mock('../../adv-sessions', () => ({ recordedLiveOwnerIds: vi.fn() }));`,
      '`;',
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'silent when the call is quoted in a line comment (phantom)',
    path: FIXTURE_PATH,
    text: `// never write vi.mock('../../adv-sessions', () => ({ a: vi.fn() })) — spread instead`,
    expect: 0,
  },
  {
    name: 'silent when the call is quoted in a block comment (phantom)',
    path: FIXTURE_PATH,
    text: `/**\n * BAD: vi.mock('../../adv-sessions', () => ({ a: vi.fn() }));\n */`,
    expect: 0,
  },
  {
    name: 'a factory that merely NAMES importActual in a string does not earn immunity',
    path: FIXTURE_PATH,
    text: `vi.mock('../../adv-sessions', () => ({ note: 'use importActual instead', a: vi.fn() }));`,
    expect: 1,
  },
  {
    name: 'FIRES on a real call sitting AFTER a comment that quotes the same shape',
    path: FIXTURE_PATH,
    text: [
      `// vi.mock('../../adv-sessions', () => ({ decoy: vi.fn() }));`,
      `vi.mock('../../adv-sessions', () => ({ real: vi.fn() }));`,
    ].join('\n'),
    expect: 1,
  },
  // BARE PACKAGE SPECIFIERS (WI-39707). Until this, resolveSpec returned null for anything
  // not starting with '.', so the entire package-mocking population — where every measured
  // incident actually happened — could not be protected at all. These fixtures are the
  // teeth: without the resolveSpec change the first one silently expects 1 and gets 0.
  {
    name: 'BARE: FIRES on the hand-listed factory (the real WI-39707 shape)',
    path: FIXTURE_PATH,
    text: `vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (def: unknown) => def }));`,
    expect: 1,
  },
  {
    name: 'BARE: silent for the import-actual spread (the prescribed fix)',
    path: FIXTURE_PATH,
    text: [
      `vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({`,
      `  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),`,
      `  defineTool: (def: unknown) => def,`,
      `}));`,
    ].join('\n'),
    expect: 0,
  },
  {
    name: 'BARE: silent for an UNPROTECTED package with the same bad shape (precision)',
    path: FIXTURE_PATH,
    text: `vi.mock('nuqs', () => ({ useQueryState: vi.fn() }));`,
    expect: 0,
  },
  {
    name: 'BARE: a SUB-PATH export is a DISTINCT module, not the protected package',
    path: FIXTURE_PATH,
    text: `vi.mock('@papercusp/agent-mcp/server', () => ({ defineTool: (def: unknown) => def }));`,
    expect: 0,
  },
  {
    name: 'BARE: fires regardless of the mocking file’s directory (identity is global)',
    path: 'apps/operator/lib/somewhere/else/deep.test.ts',
    text: `vi.mock('@papercusp/agent-mcp', () => ({ SU_ROLES: ['operator'] }));`,
    expect: 1,
  },
  {
    name: 'BARE: a relative spec whose basename merely LOOKS like the package is not it',
    path: FIXTURE_PATH,
    text: `vi.mock('./agent-mcp', () => ({ defineTool: (def: unknown) => def }));`,
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

/**
 * Pure half of the pre-filter: which already-read files could mention a protected module.
 * Split out so ONE read of the corpus can feed both the violation scan and the exposure
 * census — two walks could disagree about what the tree contains, and the whole point of
 * the census is that it qualifies THIS run's verdict.
 */
export function selectCandidates({ files, protectedModules }) {
  const needles = protectedModules.map((p) => p.module.split('/').pop());
  return files.filter((f) => needles.some((n) => f.text.includes(n)));
}

/** Test files that could possibly mention a protected module — cheap substring pre-filter. */
export function collectCandidateFiles({ listFiles, read, protectedModules }) {
  return selectCandidates({ files: readAllFiles({ listFiles, read }), protectedModules });
}

/** Read every listed file once, dropping unreadable ones. */
export function readAllFiles({ listFiles, read }) {
  const out = [];
  for (const f of listFiles()) {
    const text = read(f);
    if (text === null) continue;
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
  // ONE read, ONE parse pass, both halves of the verdict. See exposureCensus().
  const allFiles = readAllFiles({ listFiles: gitTestFiles, read });
  const candidates = selectCandidates({ files: allFiles, protectedModules: PROTECTED_MODULES });
  const exposure = exposureCensus({ files: allFiles, protectedModules: PROTECTED_MODULES });

  if (argv.includes('--list')) {
    // One parse per candidate, not one per (module × candidate): the analyzer now runs a
    // real TS parse, so the old nested loop would re-parse the whole corpus per module.
    const census = new Map(PROTECTED_MODULES.map((p) => [p.module, { full: 0, safe: 0 }]));
    for (const c of candidates) {
      for (const call of analyzeMockCalls(c.text, c.path)) {
        const row = census.get(resolveSpec(c.path, call.spec));
        if (!row) continue;
        if (call.form === 'full-replacement') row.full += 1;
        else row.safe += 1;
      }
    }
    console.log(`protected modules (${PROTECTED_MODULES.length}):\n`);
    for (const p of PROTECTED_MODULES) {
      const { full, safe } = census.get(p.module);
      console.log(`  ${p.module}\n      mockers: ${safe} safe, ${full} full-replacement\n      ${p.why}\n`);
    }
    process.exit(0);
  }

  const violations = candidates.flatMap((c) =>
    checkFile({ path: c.path, text: c.text, protectedModules: PROTECTED_MODULES }),
  );

  if (violations.length === 0) {
    console.log(
      `✓ full-replacement-mocks: no bare vi.mock factories on the ` +
        `${PROTECTED_MODULES.length} PROTECTED module(s) ` +
        `(${candidates.length} candidate test file(s) parsed).`,
    );
    // EI-20836231573383362: never print this pass as a tree-wide all-clear. It was read as
    // one, on a tree that had a collection-breaking bare factory in it the whole time.
    console.log(printExposureNote(exposure));
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
