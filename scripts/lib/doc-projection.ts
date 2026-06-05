/**
 * doc-projection.ts — shared plumbing for the `gen-doc-*` Starlight projection
 * generators (starlight-projection-generators-2026-06-05, Brief 29).
 *
 * Each `gen-doc-<x>.ts` script reads a code/registry/PG source, builds a Markdown
 * page string, and calls `emitOrCheck()`. That single helper handles:
 *   - write mode (default): write the page to apps/operator-docs/src/content/docs/reference/<x>.md
 *   - `--check` mode: compare the freshly-projected page to the committed file and
 *     report drift. Gating projectors exit non-zero on drift; advisory ones (heavy
 *     import / PG-dependent / high-churn) only warn (see D-002).
 *
 * Pages are emitted as **.md, not .mdx** on purpose: projected content (tool names
 * like `coord:inbox`, blueprint specs with `<`/`{`) would trip MDX's JSX parser.
 * CommonMark `.md` renders them as text. Starlight's docsLoader accepts both.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: scripts/lib/doc-projection.ts → ../../ */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where every projected reference page lands. */
export const REFERENCE_DIR = join(
  REPO_ROOT,
  'apps',
  'operator-docs',
  'src',
  'content',
  'docs',
  'reference',
);

const CHECK = process.argv.includes('--check');

/**
 * A table-cell-safe rendering of free text: collapse whitespace (a cell can't
 * span lines) and escape the pipe + backslash that would break the column.
 */
export function cell(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();
}

/** The standard "this file is generated" banner, identical in spirit to BORROWABLE.md. */
export function generatedBanner(scriptName: string): string {
  return [
    `> **Generated — do not edit by hand.** Run \`npm run gen:doc-projections\` (or \`npm run ${scriptName}\`).`,
    `> Source: \`scripts/${scriptName.replace(/^gen:doc-/, 'gen-doc-')}.ts\`. Part of \`starlight-projection-generators-2026-06-05\` (Brief 29).`,
  ].join('\n');
}

/** A Starlight frontmatter block (title + description + sidebar order). */
export function frontmatter(opts: {
  title: string;
  description: string;
  sidebarOrder?: number;
}): string {
  const lines = ['---', `title: ${yamlScalar(opts.title)}`, `description: ${yamlScalar(opts.description)}`];
  if (opts.sidebarOrder !== undefined) {
    lines.push('sidebar:', `  order: ${opts.sidebarOrder}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Quote a YAML scalar safely for frontmatter (handles `:`, `#`, quotes). */
function yamlScalar(s: string): string {
  const v = s.replace(/\s+/g, ' ').trim();
  // Always double-quote and escape embedded quotes/backslashes — simplest safe form.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface EmitResult {
  /** true when --check found the committed file already matches the projection. */
  upToDate: boolean;
}

/**
 * Write the page (default) or, under `--check`, compare against the committed file.
 *
 * @param fileName  bare file name under reference/ (e.g. 'blueprint-catalog.md')
 * @param content   the full page string (frontmatter + body); a trailing newline is enforced
 * @param opts.advisory  when true, a `--check` mismatch warns + returns instead of exiting 1
 *                       (heavy/churny projectors per D-002)
 */
export function emitOrCheck(
  fileName: string,
  content: string,
  opts: { advisory?: boolean } = {},
): EmitResult {
  const out = content.endsWith('\n') ? content : content + '\n';
  const target = join(REFERENCE_DIR, fileName);

  if (CHECK) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      /* missing → stale */
    }
    if (current === out) {
      process.stdout.write(`✓ reference/${fileName} is up to date\n`);
      return { upToDate: true };
    }
    const msg = `reference/${fileName} is stale — run \`npm run gen:doc-projections\``;
    if (opts.advisory) {
      process.stdout.write(`⚠ ${msg} (advisory — not gating)\n`);
      return { upToDate: false };
    }
    process.stderr.write(`✗ ${msg}\n`);
    process.exit(1);
  }

  mkdirSync(REFERENCE_DIR, { recursive: true });
  writeFileSync(target, out);
  process.stdout.write(`✓ wrote reference/${fileName}\n`);
  return { upToDate: true };
}

/** True when the script was invoked with `--check`. */
export const isCheck = CHECK;
