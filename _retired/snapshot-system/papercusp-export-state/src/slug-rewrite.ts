/**
 * §15.6 step 9 — slug rewrite over text artifacts in **structured contexts only**.
 *
 * The naive substring rewrite re-introduces the same bug ALTER SCHEMA was
 * designed to avoid: slug `sheet` inside words like `worksheet`,
 * `cheatsheet`, `spreadsheet` would corrupt prose. So we only touch:
 *
 *   - Front-matter fields:    `slug:`, `harness:`, `harness_slug:`
 *   - Path components:        `worktrees/sheets/` → `worktrees/<new>/`
 *   - DB schema references:   `harness_<orig>.X` → `harness_<new>.X`
 *   - Explicit `<slug>` placeholders the substrate writes
 *
 * Anything else (prose, code-fence content, JSON values not under a known
 * key) surfaces as `SlugRewriteAmbiguous[]` for the caller to confirm /
 * skip. Default: skip-all (better stale ref than corrupt prose).
 */

import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { assertValidSlug } from './shared-table-filters';
import type { SlugRewriteAmbiguous } from './restore-types';

export interface SlugRewriteResult {
  rewrittenFiles: number;
  ambiguous: SlugRewriteAmbiguous[];
}

const TEXT_FILE_PATTERNS = /\.(md|json|yaml|yml|txt|csv|sql|sh)$/i;

export async function rewriteSlugInDir(args: {
  rootDir: string;
  originalSlug: string;
  newSlug: string;
  /** 'skip-all' (default) | 'rewrite-all' */
  ambiguousPolicy?: 'skip-all' | 'rewrite-all';
  signal?: AbortSignal;
}): Promise<SlugRewriteResult> {
  assertValidSlug(args.originalSlug);
  assertValidSlug(args.newSlug);
  const policy = args.ambiguousPolicy ?? 'skip-all';
  const ambiguous: SlugRewriteAmbiguous[] = [];
  let rewritten = 0;

  await walkText(args.rootDir, async (abs) => {
    if (args.signal?.aborted) throw new Error('aborted');
    if (!TEXT_FILE_PATTERNS.test(abs)) return;
    let buf: string;
    try {
      buf = await fs.readFile(abs, 'utf8');
    } catch {
      return;
    }
    const before = buf;
    const after = rewriteText(buf, args.originalSlug, args.newSlug, {
      onAmbiguous: (line, lineNum, match) => {
        ambiguous.push({
          file: relative(args.rootDir, abs).split(sep).join('/'),
          line: lineNum,
          context: line.slice(0, 200),
          match,
        });
      },
      ambiguousPolicy: policy,
    });
    if (after !== before) {
      await fs.writeFile(abs, after);
      rewritten++;
    }
  });

  return { rewrittenFiles: rewritten, ambiguous };
}

async function walkText(
  dir: string,
  visit: (abs: string) => Promise<void>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next') continue;
      await walkText(abs, visit);
    } else if (e.isFile()) {
      await visit(abs);
    }
  }
}

interface RewriteCtx {
  onAmbiguous: (line: string, lineNum: number, match: string) => void;
  ambiguousPolicy: 'skip-all' | 'rewrite-all';
}

export function rewriteText(
  text: string,
  orig: string,
  next: string,
  ctx: RewriteCtx,
): string {
  // Pattern A — front-matter fields (top-of-file YAML or per-line `key: <orig>`)
  // Examples we rewrite:
  //   slug: sheets
  //   harness: sheets
  //   harness_slug: sheets
  const FRONT = new RegExp(
    `^(\\s*(?:slug|harness|harness_slug)\\s*[:=]\\s*"?)${escapeRe(orig)}("?\\s*)$`,
    'gm',
  );
  text = text.replace(FRONT, (_m, p1, p2) => `${p1}${next}${p2}`);

  // Pattern B — path components: anywhere `<orig>` is preceded and followed by `/`
  //   worktrees/sheets/foo  → worktrees/<new>/foo
  //   ./harness_<orig>/...  is handled in pattern C
  const PATH = new RegExp(`/${escapeRe(orig)}/`, 'g');
  text = text.replace(PATH, `/${next}/`);
  // Path-end:  worktrees/sheets  (no trailing slash, end of string or whitespace/quotes)
  const PATH_END = new RegExp(`/${escapeRe(orig)}(?=$|[\\s"'\\)\\]\\,])`, 'gm');
  text = text.replace(PATH_END, `/${next}`);

  // Pattern C — DB schema references `harness_<orig>.<x>`
  const SCHEMA = new RegExp(`harness_${escapeRe(orig)}\\.`, 'g');
  text = text.replace(SCHEMA, `harness_${next}.`);

  // Pattern D — explicit placeholder `<slug>` substituted at write time —
  // the substrate writes literal "<slug>" into some templates; if those
  // templates were filled to contain orig, no further work needed
  // (already covered by patterns above).

  // Pattern E — ambiguous bare-word match in prose / unstructured text.
  // We scan for `\borig\b` matches NOT covered above. Caller decides.
  const AMBIGUOUS = new RegExp(`\\b${escapeRe(orig)}\\b`, 'g');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (AMBIGUOUS.test(line)) {
      // re-test isn't reliable on a global regex with state; rebuild.
      const r2 = new RegExp(`\\b${escapeRe(orig)}\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = r2.exec(line)) !== null) {
        // Skip if this match is inside a token we already rewrote (e.g.
        // `harness_<orig>` which is now `harness_<new>`).
        // The "we already rewrote" check is implicit: if the line still
        // contains the bare orig token, it wasn't part of pattern A-C.
        ctx.onAmbiguous(line, i + 1, m[0]);
      }
      if (ctx.ambiguousPolicy === 'rewrite-all') {
        lines[i] = line.replace(r2, next);
      }
    }
  }
  return lines.join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
