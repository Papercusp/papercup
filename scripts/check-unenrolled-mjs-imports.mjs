#!/usr/bin/env node
/**
 * check-unenrolled-mjs-imports.mjs — fail-loud guard against a `.mjs` imported
 * from TypeScript that is NEITHER enrolled for declaration generation NOR
 * type-suppressed (EI-19346163916263067).
 *
 * `packages/operator-core` is `allowJs: false` + `strict`, so importing a plain
 * `.mjs` from a `.ts` file needs one of exactly two things:
 *
 *   1. ENROL it in `tsconfig.declarations.json`, so `npm run gen:declarations`
 *      emits a committed sibling `.d.mts` (16 modules today — fully typed, and
 *      kept honest by `generated-declarations.test.ts`); or
 *   2. SUPPRESS the import with `@ts-ignore` / `@ts-expect-error` (37 modules
 *      today — the `// @ts-ignore — pure JS guard script, no .d.ts` convention).
 *      Everything the module exports is `any` in that file.
 *
 * Both are legitimate and this guard endorses both. It catches only the THIRD
 * case — doing neither — which is the natural thing to write and is always
 * `TS7016: Could not find a declaration file for module '...'`.
 *
 * WHY A DEDICATED GUARD (none of the existing checks can see this):
 *   - vitest never typechecks (esbuild transform), so `test:affected` is green.
 *   - the tsc baseline cannot absorb it: baselines are per-file, and the new
 *     import is in a file whose errors were never baselined — which is exactly
 *     why it REDS the gate instead of being tolerated.
 *   - `gen:declarations:check` only validates modules the config already LISTS,
 *     so a module nobody enrolled is invisible to it by construction.
 *
 * So the first signal today is the ~55-minute green-checkpoint, where it reds
 * the gate for the whole fleet. This turns that into a ~1s local failure.
 *
 *   node scripts/check-unenrolled-mjs-imports.mjs
 *
 * BASELINE is deliberately EMPTY and must stay that way: every existing import
 * already satisfies (1) or (2), so any offender this reports is genuinely new.
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listFilesIncludingUntracked, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = 'tsconfig.declarations.json';

/**
 * The `.mjs` modules enrolled for declaration generation, as absolute paths.
 * Read from `tsconfig.declarations.json` (JSONC — tsc accepts `//` comments)
 * so this guard and `gen-declarations.ts` can never disagree about the set.
 *
 * @param {string} [root]
 * @returns {Set<string>}
 */
export function enrolledModules(root = ROOT) {
  const raw = readFileSync(resolve(root, CONFIG), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const parsed = /** @type {{ files?: string[] }} */ (JSON.parse(raw));
  return new Set((parsed.files ?? []).map((f) => resolve(root, f)));
}

/**
 * Scan upwards from `anchor` for a `@ts-ignore` / `@ts-expect-error` directive,
 * skipping blank lines and the `eslint-disable-next-line
 * @typescript-eslint/ban-ts-comment` pragma the local convention pairs with it.
 *
 * @param {string[]} lines
 * @param {number} anchor 0-based index of the line the directive must precede
 * @returns {boolean}
 */
function directiveAbove(lines, anchor) {
  let checked = 0;
  for (let i = anchor - 1; i >= 0 && checked < 3; i -= 1) {
    const text = (lines[i] ?? '').trim();
    if (text === '') continue;
    if (/@ts-(?:ignore|expect-error)/.test(text)) return true;
    if (text.startsWith('// eslint-disable')) continue;
    checked += 1;
    if (!text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')) break;
  }
  return false;
}

/**
 * True when the import carrying the specifier on `lineIdx` is type-suppressed.
 *
 * Checks TWO anchors, because tsc's directive placement rule differs by import
 * shape and this repo uses both:
 *
 *   - a single-line `import { x } from './y.mjs'` takes the directive above the
 *     statement;
 *   - a MULTI-LINE `import {\n  x,\n} from './y.mjs'` lands the diagnostic on
 *     the `from` line, so the directive must sit immediately above THAT — i.e.
 *     inside the braces (see the comments in fs-mutex.test.ts /
 *     test-file-router.test.ts, which spell this out).
 *
 * Anchoring only on the statement start walks straight past the second form and
 * reports three suppressed imports as offenders — measured, and the reason this
 * takes the union rather than picking one anchor.
 *
 * @param {string[]} lines
 * @param {number} lineIdx 0-based index of the line carrying the specifier
 * @returns {boolean}
 */
export function isSuppressed(lines, lineIdx) {
  if (directiveAbove(lines, lineIdx)) return true;
  for (let i = lineIdx; i >= 0 && lineIdx - i <= 10; i -= 1) {
    if (/\bimport\b/.test(lines[i] ?? '')) return directiveAbove(lines, i);
  }
  return false;
}

/**
 * Whether the nearest enclosing tsconfig for `file` sets `allowJs`.
 *
 * A project with `allowJs: true` (e.g. `libs/papercusp/libs/db`) consumes a
 * plain `.mjs` happily and never emits TS7016, so flagging an import there
 * would be a pure false positive. Resolution walks up to the nearest
 * `tsconfig.json` and follows `extends` so a base-config setting still counts.
 *
 * @param {string} file repo-relative path to the importing file
 * @param {string} [root]
 * @returns {boolean}
 */
export function projectAllowsJs(file, root = ROOT) {
  let dir = dirname(resolve(root, file));
  const stop = resolve(root);
  while (dir.startsWith(stop)) {
    const cfg = resolve(dir, 'tsconfig.json');
    if (existsSync(cfg)) return readAllowJs(cfg, 0);
    if (dir === stop) break;
    dir = dirname(dir);
  }
  return false;
}

/**
 * @param {string} cfgPath
 * @param {number} depth
 * @returns {boolean}
 */
function readAllowJs(cfgPath, depth) {
  if (depth > 4) return false;
  let parsed;
  try {
    parsed = /** @type {{ compilerOptions?: { allowJs?: boolean }, extends?: string }} */ (
      JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
    );
  } catch {
    return false;
  }
  if (typeof parsed.compilerOptions?.allowJs === 'boolean') return parsed.compilerOptions.allowJs;
  if (parsed.extends) {
    const base = resolve(dirname(cfgPath), parsed.extends);
    const withExt = base.endsWith('.json') ? base : `${base}.json`;
    if (existsSync(withExt)) return readAllowJs(withExt, depth + 1);
  }
  return false;
}

/**
 * Every relative `.mjs` specifier in `text`, with the 0-based line it sits on.
 * Covers both static `from '...'` and dynamic `import('...')`.
 *
 * @param {string} text
 * @returns {{ spec: string, lineIdx: number }[]}
 */
export function findMjsSpecifiers(text) {
  const lines = text.split('\n');
  /** @type {{ spec: string, lineIdx: number }[]} */
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const re = /(?:from|import\s*\()\s*['"](\.[^'"]*\.mjs)['"]/g;
    let m;
    while ((m = re.exec(lines[i] ?? '')) !== null) found.push({ spec: m[1], lineIdx: i });
  }
  return found;
}

/**
 * Offending imports in one TypeScript file: a resolvable `.mjs` with no
 * declaration, not enrolled, and not suppressed.
 *
 * @param {string} file repo-relative path to a .ts/.tsx file
 * @param {string} text its contents
 * @param {Set<string>} enrolled
 * @param {string} [root]
 * @returns {{ file: string, line: number, spec: string, target: string }[]}
 */
export function offendersIn(file, text, enrolled, root = ROOT) {
  const lines = text.split('\n');
  /** @type {{ file: string, line: number, spec: string, target: string }[]} */
  const out = [];
  for (const { spec, lineIdx } of findMjsSpecifiers(text)) {
    const abs = resolve(dirname(resolve(root, file)), spec);
    // An unresolvable specifier is a different bug (and tsc reports it as
    // TS2307); this guard only speaks to modules that genuinely exist.
    if (!existsSync(abs)) continue;
    if (existsSync(abs.replace(/\.mjs$/, '.d.mts'))) continue;
    if (enrolled.has(abs)) continue;
    if (isSuppressed(lines, lineIdx)) continue;
    out.push({ file, line: lineIdx + 1, spec, target: relative(root, abs) });
  }
  return out;
}

/**
 * Scan every `.ts`/`.tsx` file, INCLUDING untracked-but-not-ignored ones.
 *
 * Untracked coverage is the point, not a bonus (the WI-6730 reasoning the
 * identity guards use): a brand-new file is invisible to a plain
 * `git ls-files` until it is added, and on this tree that is the entire window
 * in which the author can still fix a bad import cheaply — once git-sync
 * commits it, the next green-checkpoint reds for the whole fleet.
 *
 * @param {string} [root]
 * @returns {{ file: string, line: number, spec: string, target: string }[]}
 */
export function scan(root = ROOT) {
  const enrolled = enrolledModules(root);
  const files = listFilesIncludingUntracked(root).files.filter(
    (f) =>
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.endsWith('.d.ts') &&
      !f.includes('node_modules/') &&
      !f.includes('_retired/'),
  );
  /** @type {{ file: string, line: number, spec: string, target: string }[]} */
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(root, file), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('.mjs')) continue;
    if (projectAllowsJs(file, root)) continue;
    out.push(...offendersIn(file, text, enrolled, root));
  }
  return out;
}

function main() {
  const offenders = scan();
  // Report coverage honestly rather than inferring it from an exit code — a
  // submodule git cannot descend into contributes no files and would otherwise
  // read as "clean" (the shared coverage contract in scripts/lib/tracked-files.mjs).
  const unscanned = describeUnscanned(listFilesIncludingUntracked(ROOT));
  if (unscanned) console.error(unscanned);
  if (offenders.length === 0) {
    console.log('✓ check-unenrolled-mjs-imports: every .mjs imported from TS is enrolled or suppressed');
    return;
  }
  console.error('\n✗ .mjs imported from TypeScript with no declaration and no suppression.');
  console.error('  operator-core is `allowJs: false` + strict, so this is TS7016 at the green gate.\n');
  for (const o of offenders) console.error(`    ${o.file}:${o.line}  ->  ${o.target}`);
  console.error('\n  Fix with EITHER:');
  console.error(`    1. add the module to ${CONFIG} and run \`npm run gen:declarations\` (typed), or`);
  console.error('    2. prefix the import with `// @ts-ignore — pure JS script, no .d.ts` (untyped).');
  console.error(`\n  ${offenders.length} offender(s).`);
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit
// test) must NOT walk the tree or exit the process. Symlink-robust (WI-1443):
// node realpaths import.meta.url while argv[1] keeps the invoked path.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
