#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the required-field-strand
// trap (EI-19374535041074908, the class behind WI-6814's detector).
//
// THE TRAP
//   Adding a REQUIRED field to an exported interface instantly strands every
//   construction site of that type — in files your change never touched.
//   `test:affected` is type-blind and would not select them anyway, and a stale
//   fixture in a file whose tsc baseline already tolerates errors is invisible to
//   the ratchet too. So the first thing that reliably notices is the fleet
//   green-checkpoint, hours later, where it red-pins the gate for everyone.
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   scripts/check-required-field-strands.mjs already answers this perfectly, and
//   its own header states the real gap: "finding the stranded sites is not the
//   hard part — tsc already does it perfectly. The hard part is KNOWING TO RUN
//   IT." Documentation did not close that gap: the class recurred 7× in ~48h
//   (WI-6867, EI-19340691974632497, EI-19331709872526777, EI-19332542096444388,
//   EI-19365056012137849, EI-19374026323028948, agent-facts/assumptions.test.ts),
//   each filed / claimed / fixed / closed one file at a time by a different agent.
//
//   Worse, running the CLI *later* does not work ON THIS TREE, and that is a
//   measured fact recorded in its own `formatNoFindings` docstring: git-sync
//   commits the whole tree on a schedule, so a few minutes after you edit,
//   working-tree == HEAD and the default `--base HEAD` diff is EMPTY. It printed
//   a green for a change that HAD added required field `ServeProgress.bytesIn`,
//   purely because git-sync had already swept it. So the author who remembers to
//   run it can still get a false clean bill — the window is minutes wide.
//
//   A PostToolUse hook closes exactly that: it runs milliseconds after the write,
//   when `git show HEAD:<file>` is still unambiguously the PRE-edit content, and
//   it reports to the AUTHOR while it is still their turn. That is the one moment
//   the signal is both correct and actionable.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to: adding a
//     required field is usually CORRECT and usually accompanied by updated call
//     sites. This names the trigger and the command; it never renders a verdict.
//     Do NOT make a field optional to silence it — that reintroduces whatever
//     under-reporting the required field existed to prevent (the WI-6409 bug).
//   - REUSES the detector: `diffRequiredAdditions` is dynamically imported from
//     the repo resolved off the edited file's own path. The hook is INSTALLED to
//     ~/.papercusp/hooks/cc/, detached from any repo, so a static import is
//     impossible — but re-implementing the AST diff here would fork the logic and
//     drift. The hook stays a thin trigger; the analysis stays in ONE place.
//   - SKIPS a file with no HEAD version. A brand-new exported interface has no
//     pre-existing construction sites, so it cannot strand anything (mirrors the
//     CLI's own `status.startsWith('A')` skip). Also skips .d.ts (same as CLI).
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, a
//     submodule path `git show` cannot resolve, an unresolvable detector, a parse
//     failure. A bug here must never disturb an edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors pretooluse-secrets-guard.mjs / nul-byte-edit-guard.mjs.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-required-field-strands.mjs');

/** Parsing two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

// Run the hook ONLY when executed as a binary — never on import. Mirrors
// scripts/check-required-field-strands.mjs's own `invokedDirectly` guard.
// Without this, importing the module (as the test suite does, to exercise
// nudgeFor against the REAL detector) runs main(), which waits on stdin and
// then calls process.exit(0) — killing the vitest worker mid-run. Caught by
// this file's own tests: 10 passed, and the run still reported FAILED.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const msg = await nudgeFor(filePath);
    if (msg) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }) + '\n',
      );
    }
  } catch {
    // fail open — see CONTRACT
  }
  return done();
}

/** True for a source file that can declare an exported interface worth diffing. */
export function isCandidateFile(filePath) {
  if (!/\.tsx?$/.test(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  return true;
}

/**
 * Walk up from the edited file until a directory contains the detector.
 * Returns the repo root, or null. Finding it also PROVES the detector exists,
 * so there is no separate existence check to drift out of sync.
 */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (exists(join(dir, DETECTOR_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The advisory text for a set of findings. Exported so the test asserts the real string. */
export function formatNudge(relPath, added) {
  const lines = [
    '⚠ REQUIRED-FIELD ADDITION — you may have just stranded construction sites you cannot see.',
    `  ${relPath}`,
  ];
  for (const a of added) {
    const how = a.reason === 'optional-to-required' ? 'optional → required' : 'new required field';
    lines.push(`    • ${a.path}  (${how})`);
  }
  lines.push(
    '',
    '  Every site constructing this type in OTHER files just went stale — including',
    '  files test:affected will not select and vitest cannot see. The first thing that',
    '  otherwise notices is the fleet green-checkpoint, hours from now, for everyone.',
    '',
    '  Confirm now, while it is still your turn:',
    '    npm run lint:required-field-strands:typecheck',
    '',
    '  Adding a required field is usually CORRECT — this is a prompt to verify, not a',
    '  verdict. Do NOT make the field optional to silence errors: that reintroduces the',
    '  under-reporting the required field exists to prevent.',
  );
  return lines.join('\n');
}

/**
 * The whole check for one edited file. Returns the advisory string, or null.
 * `deps` is injected by the self-test; production passes nothing.
 */
export async function nudgeFor(filePath, deps = {}) {
  const {
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    sizeOf = (p) => statSync(p).size,
    showHead = defaultShowHead,
    loadDiffer = defaultLoadDiffer,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  // No HEAD version => a new file => no pre-existing construction sites to strand.
  const beforeText = showHead(root, relPath);
  if (beforeText === null) return null;

  const afterText = readFile(abs);
  if (beforeText === afterText) return null;

  const diffRequiredAdditions = await loadDiffer(root);
  if (!diffRequiredAdditions) return null;

  const added = diffRequiredAdditions(beforeText, afterText, relPath);
  if (!added || !added.length) return null;
  return formatNudge(relPath, added);
}

function defaultShowHead(root, relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BYTES * 4,
    });
  } catch {
    return null; // new file, submodule path, detached/empty repo — all fail open
  }
}

async function defaultLoadDiffer(root) {
  try {
    const mod = await import(`file://${join(root, DETECTOR_REL)}`);
    return typeof mod.diffRequiredAdditions === 'function' ? mod.diffRequiredAdditions : null;
  } catch {
    return null;
  }
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res(buf || '{}');
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      finish();
    });
  });
}

async function selfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  check('isCandidateFile accepts .ts', isCandidateFile('a/b.ts'));
  check('isCandidateFile accepts .tsx', isCandidateFile('a/b.tsx'));
  check('isCandidateFile rejects .d.ts', !isCandidateFile('a/b.d.ts'));
  check('isCandidateFile rejects .mjs', !isCandidateFile('a/b.mjs'));

  const differ = (before, after) => {
    const had = /name: string/.test(before);
    const has = /name: string/.test(after);
    return !had && has ? [{ path: 'Foo.name', reason: 'added-required' }] : [];
  };
  const base = {
    exists: () => true,
    sizeOf: () => 10,
    loadDiffer: async () => differ,
  };

  // A required field appearing where there was none => nudge, naming the field.
  const hit = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => 'export interface Foo { id: string }',
    readFile: () => 'export interface Foo { id: string; name: string }',
  });
  check('fires on a required-field addition', !!hit && hit.includes('Foo.name'));
  check('names the remediation command', !!hit && hit.includes('lint:required-field-strands:typecheck'));

  // Unchanged content must never fire (the common case: an edit elsewhere in the file).
  const same = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => 'export interface Foo { id: string }',
    readFile: () => 'export interface Foo { id: string }',
  });
  check('silent when content is unchanged', same === null);

  // No HEAD version => brand-new file => cannot strand anything.
  const brandNew = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => null,
    readFile: () => 'export interface Foo { id: string; name: string }',
  });
  check('silent for a file with no HEAD version', brandNew === null);

  // An unresolvable detector must fail OPEN, not throw.
  const noDetector = await nudgeFor('/repo/packages/x/a.ts', {
    ...base,
    showHead: () => 'export interface Foo { id: string }',
    readFile: () => 'export interface Foo { id: string; name: string }',
    loadDiffer: async () => null,
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  // A non-candidate path short-circuits before any git/AST work.
  const dts = await nudgeFor('/repo/packages/x/a.d.ts', {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => '',
  });
  check('skips .d.ts without touching git', dts === null);

  if (failures.length) {
    console.error(`posttooluse-required-field-strand-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-required-field-strand-nudge --self-test: all cases passed');
  process.exit(0);
}
