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

/**
 * Validate a leading YAML frontmatter block (--- … ---). astro parses the
 * frontmatter as YAML *before* it compiles the MDX body, so a frontmatter YAML
 * error — classically an UNQUOTED value containing `": "` (a quoted phrase) or
 * any `key: value`-looking substring, which YAML reads as a nested mapping and
 * rejects with "bad indentation of a mapping entry" — fails `astro build` HARD
 * and wedges the WHOLE apps/operator-docs build fleet-wide. Yet
 * `findMdxCompileError` blanks the frontmatter and never sees it: EI-438 closed
 * only the body-JSX half; this closes the frontmatter half (EI-1449).
 *
 * Returns the YAML error mapped to the real 1-based source line, or null when the
 * frontmatter parses cleanly (or there is none). `js-yaml` is astro's frontmatter
 * loader (the "bad indentation…" wording is its own), lazily imported like the
 * MDX core. Fails OPEN if the loader shape ever changes (don't wedge the guard).
 */
export async function findFrontmatterYamlError(text: string): Promise<MdxCompileError | null> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null; // no frontmatter block
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return null; // unterminated fence — the MDX compile path reports it
  const body = lines.slice(1, end).join('\n');
  const mod = (await import('js-yaml')) as {
    load?: (s: string) => unknown;
    default?: { load?: (s: string) => unknown };
  };
  const load = mod.load ?? mod.default?.load;
  if (typeof load !== 'function') return null; // loader shape changed — fail open
  try {
    load(body);
    return null;
  } catch (err) {
    const e = err as { mark?: { line?: number; column?: number }; reason?: string; message?: string };
    // js-yaml `mark.line` is 0-based WITHIN `body` (which starts after the opening
    // `---` on source line 1) → +2 maps to the 1-based source line.
    const line = typeof e?.mark?.line === 'number' ? e.mark.line + 2 : null;
    const col = typeof e?.mark?.column === 'number' ? e.mark.column + 1 : null;
    const reason = `frontmatter YAML: ${(e?.reason ?? e?.message ?? String(err)).split('\n')[0]}`;
    return { line, col, reason };
  }
}

/**
 * Deterministically repair the SINGLE most common MDX offender (WI-276): a bare
 * `<` immediately followed by a DIGIT in prose — `<1s`, `<5min`, `responds in
 * <100ms` — which MDX parses as an unclosed JSX tag and which broke the whole
 * docs build (the 2026-06-20 5-tick quarantine). Escapes it to `\<` (which MDX
 * renders as a literal `<`).
 *
 * SAFE BY CONSTRUCTION — scoped to `<`+digit ONLY: a JSX tag name can never start
 * with a digit, so this can't mangle a real component (`<Card>`), and it skips
 * frontmatter, fenced code blocks, and inline-code spans (where `<1` is literal
 * and must stay). The riskier `<word>` case (could be a component) is left to the
 * LLM content-fixer. Idempotent (won't double-escape `\<`).
 *
 * Shared so `check-mdx.mjs --fix` (agent-facing) and the git-sync content-fixer
 * (the deterministic pre-pass before the LLM role) apply the IDENTICAL repair.
 */
export function autoFixMdxAngles(text: string): { fixed: string; changed: boolean } {
  const lines = text.split('\n');
  // Skip a leading YAML frontmatter block — `<1s` there is a YAML string, not MDX.
  let fmEnd = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { fmEnd = i; break; }
    }
  }
  let inFence = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (i <= fmEnd) continue;
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; } // fence open/close — leave code literal
    if (inFence) continue;
    // Prose line: escape `<`+digit only OUTSIDE inline-code spans (odd segments).
    const parts = line.split(/(`[^`]*`)/g);
    const next = parts.map((p, idx) => (idx % 2 === 1 ? p : p.replace(/(?<!\\)<(?=\d)/g, '\\<'))).join('');
    if (next !== line) { lines[i] = next; changed = true; }
  }
  return { fixed: changed ? lines.join('\n') : text, changed };
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
  // astro parses the YAML frontmatter BEFORE it compiles the MDX body, so a
  // frontmatter YAML error wedges the build just as hard (EI-1449). Check it
  // first — the body compile below blanks the frontmatter and can't see it.
  const fmErr = await findFrontmatterYamlError(text);
  if (fmErr) return fmErr;

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
