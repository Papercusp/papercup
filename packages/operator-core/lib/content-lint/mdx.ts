/**
 * MDX compile detector — the pure half of `scripts/check-mdx.mjs` (EI-438),
 * lifted into an importable module so the CI lint, the git-sync content guard,
 * and the content-fixer's success-check all call the SAME implementation
 * (git-sync-content-guard-2026-06-13 P-007 / D-003). "Is this .mdx valid" then
 * has one source of truth — the three can never disagree.
 *
 * A bare angle-bracket token in prose — `<date>`, `<id>`, `<slug>`, `<n>` —
 * written OUTSIDE a code span is parsed by MDX as a JSX element open tag. With
 * no matching close it is a HARD `astro build` failure that blocks the ENTIRE
 * apps/operator-docs build (every agent's doc regeneration). Detection is the
 * REAL MDX compiler, not a regex: each .mdx is compiled with `@mdx-js/mdx` (the
 * same MDX core astro runs) + remark-gfm (matching starlight's pipeline), so
 * undefined Starlight components compile cleanly and only genuine SYNTAX errors
 * fail — zero false positives on the docs that currently build.
 *
 * `@mdx-js/mdx` + `remark-gfm` are LAZILY imported (the operator process loads
 * this module via the content-detector registry at boot; the heavy MDX core
 * should load only when a dirty `.mdx` actually needs compiling).
 */

/** A single MDX syntax error: source position (1-based) + the compiler's reason. */
export interface MdxCompileError {
  line: number | null;
  col: number | null;
  reason: string;
}

/**
 * Blank a leading YAML frontmatter block (--- … ---) to empty lines, preserving
 * line count. `@mdx-js/mdx` alone can't parse frontmatter (no remark-frontmatter
 * here), and astro strips it before the MDX core sees it — so stripping here
 * matches astro, and keeping line numbers means a compile error still points at
 * the offending source line.
 */
export function blankFrontmatter(text: string): string {
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

// Memoised lazy loaders for the MDX core + remark-gfm (heavy; only when needed).
type MdxCompile = (value: string, opts?: Record<string, unknown>) => Promise<unknown>;
let _compile: MdxCompile | null = null;
let _remarkGfm: unknown = null;
async function loadMdx(): Promise<{ compile: MdxCompile; remarkGfm: unknown }> {
  if (!_compile) {
    const mdx = (await import('@mdx-js/mdx')) as { compile: MdxCompile };
    _compile = mdx.compile;
  }
  if (!_remarkGfm) {
    const gfm = (await import('remark-gfm')) as { default: unknown };
    _remarkGfm = gfm.default;
  }
  return { compile: _compile, remarkGfm: _remarkGfm };
}

/**
 * Pure detector: compile one .mdx with the MDX core. Returns `null` when it
 * compiles, or `{ line, col, reason }` on a syntax error. Never throws on a
 * compile error (it is caught + returned); a failure to LOAD the MDX core
 * propagates so the caller can decide (the git-sync guard treats a loader throw
 * as "can't check — don't block").
 */
export async function findMdxCompileError(fileName: string, text: string): Promise<MdxCompileError | null> {
  const { compile, remarkGfm } = await loadMdx();
  try {
    await compile(blankFrontmatter(text), { format: 'mdx', remarkPlugins: [remarkGfm] });
    return null;
  } catch (err) {
    const e = err as { place?: { start?: { line?: number; column?: number } } | { line?: number; column?: number }; line?: number; column?: number; reason?: string; message?: string };
    const start = (e?.place && 'start' in e.place ? e.place.start : e?.place) ?? {};
    const line = e?.line ?? (start as { line?: number }).line ?? null;
    const col = e?.column ?? (start as { column?: number }).column ?? null;
    const reason = (e?.reason ?? e?.message ?? String(err)).split('\n')[0];
    return { line, col, reason };
  }
}
