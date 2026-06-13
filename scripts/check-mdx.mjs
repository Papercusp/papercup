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
 *   node scripts/check-mdx.mjs
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
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';

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

/**
 * Blank a leading YAML frontmatter block (--- … ---) to empty lines, preserving
 * line count. `@mdx-js/mdx` alone can't parse frontmatter (no remark-frontmatter
 * on this box), and astro strips it before the MDX core sees it — so stripping
 * here matches astro, and keeping line numbers means a compile error still
 * points at the offending source line.
 */
export function blankFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return text; // unterminated fence — leave it for the compiler
  for (let i = 0; i <= end; i++) lines[i] = '';
  return lines.join('\n');
}

/**
 * Pure detector: compile one .mdx with the MDX core. Returns `null` when it
 * compiles, or `{ line, col, reason }` on a syntax error. Exported for reuse.
 */
export async function findMdxCompileError(fileName, text) {
  try {
    await compile(blankFrontmatter(text), { format: 'mdx', remarkPlugins: [remarkGfm] });
    return null;
  } catch (err) {
    const start = err?.place?.start ?? err?.place ?? {};
    const line = err?.line ?? start.line ?? null;
    const col = err?.column ?? start.column ?? null;
    const reason = (err?.reason ?? err?.message ?? String(err)).split('\n')[0];
    return { line, col, reason };
  }
}

async function main() {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
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
    const hit = await findMdxCompileError(f, text);
    if (hit) {
      const at = hit.line != null ? `:${hit.line}${hit.col != null ? `:${hit.col}` : ''}` : '';
      offenders.push(`${f}${at}  ${hit.reason}`);
    }
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
