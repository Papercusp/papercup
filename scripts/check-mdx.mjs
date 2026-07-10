#!/usr/bin/env node
/**
 * check-mdx.mjs — fail-loud guard for MDX that won't compile (EI-438).
 *
 * A bare angle-bracket token in prose — `<date>`, `<id>`, `<slug>`, `<n>` —
 * written OUTSIDE a code span is parsed by MDX as a JSX element open tag. With
 * no matching close it is a HARD `astro build` failure
 * (`@astrojs/mdx` vite-plugin parse error), which blocks the ENTIRE
 * apps/operator-docs build — and therefore every agent's doc regeneration —
 * not just the author's. git-sync auto-commits the broken file first, so the
 * only current signal arrives AFTER it ships to the shared tree (EI-438; the
 * 2026-06-13 break was `A "resets <date>" string` in a fleet-token insight).
 *
 *   npm run lint:mdx        # = tsx scripts/check-mdx.mjs
 *
 * Run it with tsx (via the npm script), NOT bare `node`: this file imports the
 * TypeScript ../packages/operator-core/lib/content-lint/mdx module, which the
 * plain node ESM loader can't resolve (ERR_MODULE_NOT_FOUND) without tsx.
 *
 * Detection is the REAL MDX compiler, not a regex: each tracked .mdx is
 * compiled with `@mdx-js/mdx` (the same MDX core astro runs). Undefined
 * components (`<Aside>`, `<Steps>` — provided by Starlight at render, never
 * imported in the source) compile cleanly; only genuine SYNTAX errors fail, so
 * there are zero false positives on the docs that currently build. Fix a hit
 * by backticking the placeholder (`` `<date>` ``) or escaping it.
 *
 * Scope: tracked .mdx under apps/operator-docs/src/content/docs/ (exactly the
 * astro-built set). remark-gfm is applied to match starlight's pipeline so
 * table cells with inline-code angle brackets (`` `<ArchitectChat>` ``) don't
 * false-positive. YAML frontmatter (--- … ---) is blanked before compile —
 * `@mdx-js/mdx` has no remark-frontmatter here — with line count preserved so
 * reported positions still point at source.
 */
import { execSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// D-003 (git-sync-content-guard): the pure detector now lives in ONE importable
// module shared by this CI lint, the git-sync content guard, and the
// content-fixer's success-check — so "is this .mdx valid" has a single source of
// truth. Re-exported below so existing importers (check-mdx-guard.test.ts) keep
// working unchanged. This .mjs is run via `tsx` (package.json `lint:mdx`) so it
// can import the TypeScript module.
import { findMdxCompileError, blankFrontmatter, autoFixMdxAngles } from '../packages/operator-core/lib/content-lint/mdx';

export { findMdxCompileError, blankFrontmatter };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The astro-built docs set (apps/operator-docs runs starlight, whose MDX
// pipeline includes remark-gfm — matched below). Scope to exactly what
// `astro build` compiles, so the lint's pass/fail mirrors the real build and a
// stray .mdx that astro never touches can't false-positive.
const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/');

async function main() {
  // --fix: deterministically repair the safe `<`+digit offender in place (WI-276)
  // before reporting; anything still broken (e.g. `<word>` components) is reported
  // for a human/LLM fixer as before.
  const doFix = process.argv.includes('--fix');
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  const autofixed = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!f.endsWith('.mdx')) continue;
    if (!f.startsWith(DOCS_PREFIX)) continue; // only the astro-built docs set
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    let hit = await findMdxCompileError(f, text);
    if (hit && doFix) {
      const res = autoFixMdxAngles(text);
      if (res.changed) {
        writeFileSync(new URL(f, `file://${ROOT}/`), res.fixed); // <+digit escape is always valid
        autofixed.push(f);
        text = res.fixed;
        hit = await findMdxCompileError(f, text); // re-check; may still have a `<word>` offender
      }
    }
    if (hit) {
      const at = hit.line != null ? `:${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : '';
      offenders.push(`${f}${at}  ${hit.reason}`);
    }
  }

  if (autofixed.length > 0) {
    console.log(`✓ auto-fixed (escaped \`<\`+digit) in ${autofixed.length} file(s):`);
    for (const f of autofixed) console.log('    ' + f);
  }

  if (offenders.length === 0) {
    console.log('✓ every tracked .mdx compiles (MDX core).');
    process.exit(0);
  }

  console.error('✗ MDX that will NOT compile — `astro build` fails hard on these and blocks');
  console.error('  the entire apps/operator-docs build (every agent\'s doc regen), not just yours.');
  console.error('  Most common cause: a bare `<word>` placeholder in prose (e.g. `<date>`, `<id>`)');
  console.error('  parsed as an unclosed JSX tag. Backtick it (`` `<date>` ``) or escape it.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See EI-438.`);
  process.exit(1);
}

// Run only as the entry point — importing the detector for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
