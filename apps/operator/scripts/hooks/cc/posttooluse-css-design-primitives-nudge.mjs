#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-css-design-primitives-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge when an edit ADDS a banned nonzero
// `letter-spacing` — i.e. when it arms the `lint:design-primitives` green-checkpoint leg
// (EI-20023819609804890).
//
// THE TRAP THIS CLOSES IS NOT THE DECLARATION — IT IS WHO PAYS FOR IT
//   `lint:design-primitives` is a green-checkpoint leg, so a banned declaration bites ONLY
//   at the fleet gate. The author never pays: the cost lands hours later on whichever
//   unrelated agent is waiting on a deploy. hud.css alone has red-pinned the fleet THREE
//   times on this single rule (once 2026-08-02, twice 2026-08-09).
//
//   Nothing in the edit loop catches it either, and not by accident:
//     • `test:affected` maps CHANGED PATHS to workspaces — editing a .css file selects the
//       lint only if the mapping happens to route there, and an author editing CSS is
//       typically not running tests at all.
//     • `lint:tsc` cannot: a CSS declaration is not a type error.
//   So the breach rides git-sync to staging within minutes and surfaces as someone else's
//   red gate.
//
// WHY A HOOK RATHER THAN ANOTHER WARNING COMMENT
//   Prose was already tried, four times, in the very file that keeps breaking: hud.css
//   carries warnings at L564, L782, L885 and L1372. It broke anyway — a comment only
//   reaches someone reading THAT region of a 1,445-line stylesheet, and an author adding a
//   new uppercase micro-label is by definition writing somewhere else in it. A fifth
//   comment would have been the fifth instance of a remedy already measured to fail.
//
// WHY A HOOK RATHER THAN "RUN THE LINT AFTERWARDS"
//   Same reason as posttooluse-mock-cast-escape-nudge.mjs: git-sync commits the WHOLE
//   working tree every few minutes, so minutes after the edit, working-tree == HEAD and
//   any after-the-fact diff is empty. A PostToolUse hook runs milliseconds after the
//   write, when `git show HEAD:<file>` is still unambiguously the PRE-edit content — the
//   one moment the signal is both correct and attributable.
//
// REUSES THE LINT'S OWN MATCHER
//   `findNonzeroLetterSpacing` is dynamically imported from
//   apps/operator/app/_lints/letter-spacing-pattern.mjs, resolved off the edited file's
//   own path (this hook is INSTALLED to ~/.papercusp/hooks/cc/, detached from any repo, so
//   a static import is impossible). Re-implementing the regex here would fork it — and the
//   drift would be silent and severe, because the negative lookahead is precisely what
//   separates a banned `0.04em` from the REQUIRED `letter-spacing: 0`. A hand-rewrite that
//   dropped it would fire on every compliant declaration in the tree.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to. The gate remains the
//     authority; this only makes the cost visible to the person choosing to pay it.
//   - SCOPED TO THE LINT'S OWN FILE POPULATION: `.css` / `.ts` / `.tsx` under the dirs the
//     lint scans, excluding test files. A declaration outside that set is not counted by
//     the leg, so nudging about it would be a false positive by construction.
//   - FIRES ONLY ON AN INCREASE. Refactors that move or remove declarations are silent;
//     only a net-new offender costs anyone anything.
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, an unresolvable
//     module. A bug here must never disturb an edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on failure.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Shared matcher, relative to the repo root — also how the root is identified. */
const MODULE_REL = join('apps', 'operator', 'app', '_lints', 'letter-spacing-pattern.mjs');

/** Directories the lint actually scans (SOURCE_DIRS in design-primitives.test.ts). */
const SCANNED_DIRS = [join('apps', 'operator', 'app'), join('apps', 'operator-vite', 'src')];

const SOURCE_FILE_RE = /\.(?:tsx|ts|css)$/;
const TEST_FILE_RE = /(?:\.test|\.spec)\.tsx?$/;

/** Scanning two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

/** At most this many NEW sites are listed; the count line always states the true total. */
const MAX_LISTED = 5;

// Run ONLY when executed as a binary — never on import. Without this, importing the module
// (as a test does) runs main(), which waits on stdin and then exits, killing the runner.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
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

/**
 * True for a file the `lint:design-primitives` leg actually scans. Mirrors SOURCE_FILE_RE /
 * TEST_FILE_RE / SOURCE_DIRS in design-primitives.test.ts — keep the two in step.
 */
export function isCandidateFile(repoRoot, filePath) {
  const abs = resolve(filePath);
  if (!SOURCE_FILE_RE.test(abs) || TEST_FILE_RE.test(abs)) return false;
  const rel = relative(resolve(repoRoot), abs);
  if (rel.startsWith('..')) return false;
  return SCANNED_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

/** Walk up from the edited file until a directory contains the shared matcher. */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (exists(join(dir, MODULE_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Offenders in `after` not accounted for by `before`, as a multiset difference over the
 * snippet text. Line numbers shift when anything above them moves, so they cannot identify
 * a site across two versions; the snippet can, and the multiset makes repeated identical
 * snippets come out right (N before, N+1 after => exactly one new).
 */
export function newOffenders(beforeFound, afterFound) {
  const remaining = new Map();
  for (const e of beforeFound) remaining.set(e.snippet, (remaining.get(e.snippet) || 0) + 1);
  const fresh = [];
  for (const e of afterFound) {
    const left = remaining.get(e.snippet) || 0;
    if (left > 0) remaining.set(e.snippet, left - 1);
    else fresh.push(e);
  }
  return fresh;
}

/** The advisory text. Exported so a test asserts the real string. */
export function formatNudge(relPath, fresh, beforeCount, afterCount) {
  const lines = [
    `⚠ BANNED letter-spacing ADDED (+${afterCount - beforeCount}) — this arms lint:design-primitives, a GREEN-CHECKPOINT LEG.`,
    `  ${relPath}  (${beforeCount} → ${afterCount} in this file)`,
  ];
  for (const e of fresh.slice(0, MAX_LISTED)) lines.push(`    • L${e.line}  ${e.snippet}`);
  if (fresh.length > MAX_LISTED) lines.push(`    … and ${fresh.length - MAX_LISTED} more`);
  lines.push(
    '',
    '  Nonzero letter-spacing is not an approved primitive: the gate reds the WHOLE FLEET on',
    '  it, and the cost lands on whoever is next waiting on a deploy — not on this edit.',
    '  hud.css has already red-pinned the gate 3x on exactly this rule.',
    '',
    '  Carry the distinction with case + size + weight instead (what chat-controls.css and',
    '  AgentOrders.css do), or use letter-spacing: 0. If tracking is genuinely required, it',
    '  is a design-system decision — /internal/docs/design — not a per-surface tweak.',
  );
  return lines.join('\n');
}

/** The nudge for one edited path, or null. */
export async function nudgeFor(filePath) {
  const repoRoot = findRepoRoot(filePath);
  if (!repoRoot) return null;
  if (!isCandidateFile(repoRoot, filePath)) return null;

  const abs = resolve(filePath);
  if (!existsSync(abs)) return null;
  if (statSync(abs).size > MAX_BYTES) return null;

  const { findNonzeroLetterSpacing } = await import(
    `file://${join(repoRoot, MODULE_REL)}`
  );

  const after = findNonzeroLetterSpacing(readFileSync(abs, 'utf8'));
  if (after.length === 0) return null; // nothing to say — the common case

  const relPath = relative(repoRoot, abs);
  const before = findNonzeroLetterSpacing(headVersion(repoRoot, relPath));
  const fresh = newOffenders(before, after);
  if (fresh.length === 0) return null; // pre-existing; not this edit's doing

  return formatNudge(relPath, fresh, before.length, after.length);
}

/** The committed content of `relPath`, or '' when there is no HEAD version. */
function headVersion(repoRoot, relPath) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'show', `HEAD:${relPath}`], {
      encoding: 'utf8',
      maxBuffer: MAX_BYTES * 2,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // A brand-new file has no HEAD version. Treat as before-count = 0 rather than
    // skipping: a new stylesheet full of banned declarations reds the gate exactly like
    // an edit to an existing one, and skipping would leave that path uncovered while
    // looking complete.
    return '';
  }
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    let buf = '';
    const t = setTimeout(() => res(buf || '{}'), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      res(buf || '{}');
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      res('{}');
    });
  });
}

function done() {
  process.exit(0);
}

function selfTest() {
  let failures = 0;
  const check = (label, cond) => {
    if (!cond) {
      failures += 1;
      process.stderr.write(`FAIL: ${label}\n`);
    }
  };

  // A SYNTHETIC root for the pure-function checks below — this script's REAL
  // root is derived per-invocation by findRepoRoot(filePath), never from here.
  // Kept under /tmp because that is what a fake path should look like, and
  // because the class-wide portability ratchet
  // (__tests__/hook-repo-root-portability.test.ts) is a TEXTUAL scan for
  // `const <root-ish> = '/abs/path'` — it cannot tell a fixture from an
  // operating root, and a bare '/repo' here tripped it and red-pinned the
  // @papercusp/web suite. Machine-global prefixes are exempt by design there.
  const root = '/tmp/pc-selftest-repo';
  check(
    'scans operator app css',
    isCandidateFile(root, '/tmp/pc-selftest-repo/apps/operator/app/adv/hud/hud.css'),
  );
  check('scans operator-vite src', isCandidateFile(root, '/tmp/pc-selftest-repo/apps/operator-vite/src/a.tsx'));
  check('skips test files', !isCandidateFile(root, '/tmp/pc-selftest-repo/apps/operator/app/a.test.tsx'));
  check('skips unscanned dirs', !isCandidateFile(root, '/tmp/pc-selftest-repo/packages/operator-core/a.ts'));
  check('skips non-source', !isCandidateFile(root, '/tmp/pc-selftest-repo/apps/operator/app/a.md'));
  check('skips outside repo', !isCandidateFile(root, '/elsewhere/a.css'));

  // Only NET-NEW offenders count.
  const a = { line: 1, snippet: 'letter-spacing: 0.04em' };
  const b = { line: 9, snippet: 'letter-spacing: 0.04em' };
  check('moved site is not new', newOffenders([a], [b]).length === 0);
  check('added duplicate counts once', newOffenders([a], [a, b]).length === 1);
  check('removal is silent', newOffenders([a, b], [a]).length === 0);

  const msg = formatNudge('apps/operator/app/adv/hud/hud.css', [a], 0, 1);
  check('names the leg', msg.includes('GREEN-CHECKPOINT LEG'));
  check('names the file', msg.includes('hud.css'));
  check('shows the offending line', msg.includes('L1'));
  check('offers the alternative', msg.includes('letter-spacing: 0'));

  process.stdout.write(failures === 0 ? 'self-test OK\n' : `self-test FAILED (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}
