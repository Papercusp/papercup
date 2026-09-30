/**
 * Lint: a prompt or blueprint that NAMES a verb absent from the live tool
 * catalog fails the build (agent-trap-guards-2026-07-26 P-007).
 *
 * Sibling to `lint:no-retired` (which only catches `_retired/` IMPORTS and is
 * blind to a prompt STRING) and blueprint-deps-catalog.test.ts (which checks a
 * blueprint's declared `dependencies.tools` FIELD, not free prose). This test
 * scans apps/operator/prompts/**\/*.md and
 * libs/papercusp/packages/harness/blueprints/**\/*.{yaml,md} (the same
 * surfaces P-004's retiring-a-surface sweep names) for the actual motivating
 * shape — "step 6: call `messages:send`" — and asserts every such reference
 * resolves against the static tool catalog (../static-tool-catalog.ts —
 * SHARED with blueprint-deps-catalog.test.ts, so this is not a second
 * catalog-building scanner).
 *
 * SURFACE-PRECISE, not word-level (P-005's lesson, this same plan): an EARLIER
 * version of this test matched every bare backtick `word:word`/`word.word`
 * token in the corpus and diffed it against the catalog. That produced ~130
 * false positives on the real corpus — blueprint YAML is dense with
 * structurally-similar-but-unrelated identifiers that are NOT tool verbs:
 * schema field-access paths (`payload.classId`, `knobs.pattern`,
 * `spine.decider`), internal `system:*` / per-blueprint scheduled-trigger
 * action ids (`system:blueprint-run`, `calibration:resolve`), fence-language
 * tags (`` `promote:plan` ``, `` `proposal:contract` ``), and — the exact
 * trap flagged by this same plan's leader ruling D-003 — a capability-tier
 * vocabulary table in `scanner.md` that legitimately reuses tool-shaped
 * strings (`` `messages:write` ``, `` `tasks:read` ``) for an unrelated
 * permission namespace. Building an allowlist big enough to cover that noise
 * would just relocate the false-positive problem into an ever-growing,
 * easily-stale list — the anti-pattern P-005 exists to avoid, not follow.
 *
 * Instead this scans for the NARROW shape that is actually an instruction to
 * CALL a tool: a calling verb (call/calls/calling/invoke/invokes/invoking)
 * immediately followed by a backtick-quoted `group:verb`/`group.verb` token,
 * with a negation guard so a documented "don't call `X`" caution (a
 * deliberate, correct reference to a retired/internal identifier — see
 * `orchestrator.spawn` in the su playbooks) isn't misread as an instruction.
 * Verified empirically (P-007, 2026-07-26): this shape matches 27 real
 * candidate tokens across the whole corpus with ZERO false positives, versus
 * ~130 for the bare-token approach — no hand-maintained allowlist needed.
 *
 * (This test found + P-007 fixed one real live regression while landing:
 * `apps/operator/prompts/papercusp-compaction.protocol.md` instructed calling
 * `session:request_compaction` — underscore — when the real tool is
 * `session:request-compaction` — hyphen.)
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildFullToolNameCatalog } from '../static-tool-catalog';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, '../../../../');

const SCAN_ROOTS = ['apps/operator/prompts', 'libs/papercusp/packages/harness/blueprints'];

function listScannedFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    if (!existsSync(join(REPO, root))) continue;
    // --recurse-submodules is REQUIRED: libs/papercusp is a git submodule, so a
    // plain `git ls-files` from the superproject returns NOTHING for anything
    // under it — every blueprint/prompt file (the P-004/P-007 convention's
    // primary named surface) was silently unscanned without this (caught
    // empirically, P-007, by cross-checking scanner.md's known
    // `messages:read`/`messages:write` capability-tier strings, which should
    // have surfaced as candidate hits and initially didn't).
    let files: string[] = [];
    try {
      files = execSync(`git ls-files --recurse-submodules -- ${JSON.stringify(root)}`, {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
        killSignal: 'SIGKILL',
      })
        .split('\n')
        .filter(Boolean)
        .filter((f) => /\.(md|ya?ml)$/i.test(f))
        // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
        .filter((f) => existsSync(join(REPO, f)));
    } catch {
      files = [];
    }
    // WI-6235: git ls-files is not a reliable enumerator in EVERY tree this test
    // runs in. The green-checkpoint judges a worktree materialized with `git
    // archive` (apps/operator/bin/release/setup-release-checkout.sh) — the files
    // are all physically present, but `libs/papercusp` is not REGISTERED as a
    // submodule there, so `--recurse-submodules` silently returns ZERO for the
    // blueprints root. That is exactly the silent under-scan this file's header
    // says the flag was added to prevent, relocated into the gate environment:
    // the scan quietly measured 72 files instead of 194 and the sanity assertion
    // below is what caught it (candidate f9bc6fc0, 2026-07-26).
    //
    // So: git first (it respects .gitignore and is the cheap path), but when a
    // root that EXISTS on disk yields nothing from git, walk the filesystem
    // instead of trusting the empty answer. A scan that cannot see the corpus
    // must not be able to report success.
    if (files.length === 0) {
      files = walkFiles(join(REPO, root))
        .map((abs) => abs.slice(REPO.length).replace(/^\/+/, ''))
        .filter((f) => /\.(md|ya?ml)$/i.test(f));
    }
    out.push(...files);
  }
  return out;
}

/** Recursive on-disk enumeration — the fallback when git cannot see a root
 *  (see the `git archive` note in listScannedFiles). Skips node_modules/.git so
 *  it enumerates the same corpus git would, not vendored copies of it. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

// A calling verb immediately before a backtick-quoted `group:verb`/`group.verb`
// token — the actual "call `messages:send`" shape this lint targets, not any
// backtick token in prose (see the file header for why bare-token matching
// was rejected).
const CALL_RE =
  /\b(?:call|calls|calling|invoke|invokes|invoking)\s+`([a-zA-Z][a-zA-Z0-9_-]*)([:.])([a-zA-Z][a-zA-Z0-9_:.\-]*)`/gi;

// A "don't/never/not call `X`" caution is a deliberate, correct reference to a
// retired/internal/prohibited identifier — not an instruction to call it.
// Looks back a short window before the calling verb for a negator.
const NEGATION_RE = /\b(?:don'?t|do not|never|not)\b\s*$/i;

interface Hit {
  token: string;
  file: string;
  line: number;
}

/** The PURE core of the scan: text in, candidate hits out. Split out from the
 *  file-walking wrapper so the surface-precision contract below can be pinned
 *  against synthetic fixtures instead of whatever the live corpus happens to
 *  contain today — a guard that depends on corpus CONTENT silently stops
 *  guarding the moment the content changes. */
function scanTextForCallReferences(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(CALL_RE)) {
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 24), idx);
    if (NEGATION_RE.test(before)) continue; // "Do NOT call `X`"
    const token = m[1] + m[2] + m[3];
    const line = text.slice(0, idx).split('\n').length;
    hits.push({ token, file, line });
  }
  return hits;
}

function scanForCallReferences(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of files) {
    const full = join(REPO, f);
    if (!existsSync(full)) continue;
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    hits.push(...scanTextForCallReferences(text, f));
  }
  return hits;
}

describe('prompt/blueprint "call `verb`" references vs the live tool catalog', () => {
  const catalog = buildFullToolNameCatalog(REPO);
  const files = listScannedFiles();
  const hits = scanForCallReferences(files);

  it('scan sanity — found real files (including inside the libs/papercusp submodule) and real candidate references', () => {
    expect(files.length).toBeGreaterThan(150); // apps/operator/prompts + the whole blueprints submodule tree
    expect(files.some((f) => f.startsWith('libs/papercusp/'))).toBe(true);
    expect(hits.length).toBeGreaterThan(15);
    expect(catalog.size).toBeGreaterThan(100);
  });

  it('every "call `verb`" reference resolves against the live tool catalog', () => {
    const unresolved = hits.filter((h) => !catalog.has(h.token));
    const lines = [
      `${unresolved.length} prompt/blueprint reference(s) instruct calling a verb absent from the live tool `,
      `catalog (a retired/renamed/typo'd tool — the exact WI-6097-style silent mid-procedure failure this lint `,
      `exists to catch):`,
      ...unresolved.map((h) => `  ${h.file}:${h.line}  [${h.token}]`),
      ``,
      `Each is either a genuine dead reference to fix, or (rare, given the narrow calling-verb shape this scans `,
      `for) a new false positive — extend the CALL_RE/NEGATION_RE shape above with a reason rather than `,
      `hand-listing the token (surface-precise convention, P-005: narrowing the SHAPE beats growing an allowlist).`,
    ];
    expect(unresolved, lines.join('\n')).toEqual([]);
  });

  /* ------------------------------------------------------------------ *
   * SURFACE-PRECISION CONTRACT (EI-18742214647740308).
   *
   * The two tests above scan the LIVE corpus, so they only assert that the
   * corpus is clean TODAY. Neither pins WHY the scan is shaped the way it is,
   * and that rationale currently lives only in this file's header prose.
   *
   * The regression this guards against is a plausible-looking "improvement":
   * widening CALL_RE to match every backtick `group:verb` token, on the
   * reasoning that the lint should catch ALL references to dead verbs and not
   * just the ones spelled "call `X`". That change reintroduces the ~130 false
   * positives the header describes — and, per this plan's leader ruling
   * agent-trap-guards-2026-07-26#D-003, it reds the build on the CAPABILITY
   * namespace (`messages:write`, `coord:read`, `plans:read`, `data:read:*`),
   * which shares the `namespace:verb` spelling with tool verbs but is a
   * DIFFERENT SURFACE that the tool catalog does not and should not contain.
   * A lint that noisy gets silenced, after which it guards nothing.
   *
   * These fixtures are synthetic on purpose: a guard asserted against live
   * corpus content stops guarding the moment that content changes.
   * ------------------------------------------------------------------ */
  describe('surface-precision contract (D-003: a capability name is not a tool verb)', () => {
    it('does NOT flag capability names that merely APPEAR — the D-003 collision', () => {
      // The real shape from blueprints/base/prompts/scanner.md: a capability
      // tier table reusing tool-shaped strings for a permission namespace.
      const fixture = [
        '| capability | tier |',
        '| --- | --- |',
        '| `messages:write` | medium |',
        '| `tasks:read` | low |',
        '| `coord:read` | low |',
        '| `data:read:*` | medium |',
        '',
        'The kettle role is granted `messages:write` so it can forward a directive.',
      ].join('\n');
      expect(scanTextForCallReferences(fixture, 'fixture.md')).toEqual([]);
    });

    it('does NOT flag a tool verb mentioned without a calling verb — this is what keeps the capability namespace safe', () => {
      // If someone widens CALL_RE to bare-token matching, THIS is the test that
      // fails first — before the D-003 capability collision reappears in CI.
      const fixture = [
        'Read the `plans:list` result before building.',
        'The `work_items:get` response carries a checkpoint.',
        'See `messages:send` in the retirement notes.',
      ].join('\n');
      expect(scanTextForCallReferences(fixture, 'fixture.md')).toEqual([]);
    });

    it('does NOT flag a documented "do NOT call `X`" caution', () => {
      const fixture = 'Do NOT call `orchestrator.spawn` directly — it is internal.';
      expect(scanTextForCallReferences(fixture, 'fixture.md')).toEqual([]);
    });

    it('DOES flag a genuine instruction to call a retired verb, and that verb is absent from the live catalog', () => {
      // The motivating shape the lint exists for ("step 6: call `messages:send`").
      // Both halves matter: the scanner must SEE it, and the catalog must not
      // resolve it — together that is what reds the build.
      const hits = scanTextForCallReferences('Step 6: call `messages:send` to notify the holder.', 'fixture.md');
      expect(hits.map((h) => h.token)).toEqual(['messages:send']);
      expect(catalog.has('messages:send')).toBe(false); // retired in WI-6097
    });

    it('DOES flag a typo\'d verb — the class P-007 caught live (underscore vs hyphen)', () => {
      const hits = scanTextForCallReferences('When context fills, call `session:request_compaction`.', 'fixture.md');
      expect(hits.map((h) => h.token)).toEqual(['session:request_compaction']);
      expect(catalog.has('session:request_compaction')).toBe(false);
    });
  });
});
