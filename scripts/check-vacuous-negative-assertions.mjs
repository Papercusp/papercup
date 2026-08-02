#!/usr/bin/env node
/**
 * check-vacuous-negative-assertions.mjs — mechanical guard for the DEAD NEGATIVE
 * ASSERTION class (EI-18765867705399052).
 *
 * WHY THIS EXISTS
 * A POSITIVE assertion that pins a literal (`toMatch(/foo/)`) is self-healing: reword
 * the string in the source and the test FAILS LOUDLY, forcing you to look at it.
 *
 * A NEGATIVE assertion is the exact inverse. Rewording the string it pins makes it
 * *more* likely to pass — permanently, silently, and as a direct consequence of doing
 * the rename correctly. The test keeps a truthful-looking name and keeps going green,
 * so the suite reports a guard it no longer has.
 *
 * That is not hypothetical. `checkpoint-run.test.ts` asserted
 *
 *     expect(String(b.note)).not.toMatch(/⚠ quiet-cut EXCLUDED/);
 *
 * long after the source had reworded that banner. The regex could no longer match
 * anything the code was capable of emitting, so it passed unconditionally — while the
 * very grammar it existed to exclude drifted back into the file in a new form
 * (EI-18759622667757826). The dead guard and the regression it was supposed to prevent
 * are the same story: this class specifically disarms the guards we wrote *because we
 * already got burned once*.
 *
 *   node scripts/check-vacuous-negative-assertions.mjs            # gate
 *   node scripts/check-vacuous-negative-assertions.mjs --report   # + the non-gating bucket
 *
 * THE RULE
 * A negative assertion on a STATIC literal is vacuous when that literal appears
 * NOWHERE the system could emit it from — not in any tracked non-test file, and not
 * anywhere in its own test file (where a fixture would put it). Two verdicts:
 *
 *   DRIFTED  (GATES)  — a long contiguous fragment of the literal IS in the source.
 *                       The guarded string still exists; the guard is pinned to its
 *                       OLD wording. Dead guard, live emitter. This is the class above.
 *
 *   ORPHANED (report) — nothing resembling the literal exists anywhere. Usually a
 *                       deliberate "this phrasing is gone for good" ratchet, which is
 *                       legitimate and stable (the historical string never changes),
 *                       so it is reported under --report and never gates.
 *
 * THE FALSE-POSITIVE DISCRIMINATORS (why this is not noise). A negative assertion is
 * NOT flagged when the string is producible, by any of:
 *   - it appears in a tracked non-test file (source, prompt, doc, shell hook, SQL, …);
 *   - it appears elsewhere in its own test file — the test builds it as a fixture;
 *   - it CONTAINS a literal this same file asserts POSITIVELY — the "output must not
 *     carry an extra suffix/prefix" shape, e.g. `toContain('a → b')` next to
 *     `not.toContain('a → b →')`;
 *   - it interpolates, or the regex uses real regex power (classes, alternation, …).
 * Every one of those was a live false positive on the first sweep of this repo.
 *
 * SUPPRESSION: put `vacuous-negative-ok: <reason>` on the assertion's line or in the
 * contiguous comment block directly above it. A deliberate exception carries its
 * justification at the site — which is itself the improvement: it turns an invisible
 * always-passes into a documented intentional ratchet.
 *
 * COST: builds a ~110M-char corpus from every tracked text file, so a full run is
 * ~40-60s. It is a gate, not an inner-loop check.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coverageOf, describeUnscanned } from './lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * PROSE IS NOT AN EMITTER, so it is not corpus. A doc or a prompt that *describes* a
 * banner cannot produce it, and counting it as evidence is exactly what hid the
 * motivating instance: `⚠ quiet-cut EXCLUDED` survives today ONLY in
 * `blueprints/base/prompts/release-fixer.md`, which still tells release-fixer agents to
 * look for a warning `checkpoint-run.ts` stopped emitting. Judging against prose scored
 * that string "still exists" and the dead assertion passed the lint too — while the
 * stale prompt (a second, live defect) stayed invisible.
 *
 * This is cheap: measured over the whole repo, dropping prose from the corpus changes
 * exactly ONE assertion's verdict.
 */
const PROSE_RE = /\.(md|mdx|txt|rst|adoc)$/i;
const BINARY_RE =
  /\.(png|jpe?g|gif|ico|svgz|webp|avif|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|bin|wasm|so|dylib|dll|node|exe|mp[34]|mov|webm|wav|ogg|class|jar|pyc|db|sqlite|snap|lock)$/i;

/**
 * Build artifacts, vendored trees and GENERATED mirrors. The docs mirror matters most:
 * `apps/operator/public/internal/docs/llms-full.txt` concatenates the whole doc corpus,
 * so leaving it in would make almost any prose literal "present" and silently gut this
 * lint — the couldn't-measure-reads-as-a-pass failure, aimed at itself.
 */
const SELF = 'scripts/check-vacuous-negative-assertions.mjs';

const isExcluded = (p) =>
  // THIS FILE quotes the banner from the motivating instance verbatim, and it is a .mjs,
  // so leaving it in the corpus makes that string "exist in the source" and renders the
  // one assertion this lint was written to catch undetectable. A checker that cites its
  // own example poisons its own evidence — caught only by replaying the real pre-fix
  // commit through the judge and getting zero findings.
  p === SELF ||
  /(^|\/)(node_modules|dist|dist-host|build|_retired|sidecar|env-sidecars|coverage|\.next|target)\//.test(p) ||
  /\.materialized\//.test(p) ||
  /(^|\/)(package-lock\.json|Cargo\.lock)$/.test(p) ||
  p.startsWith('apps/operator/public/internal/docs/') ||
  p.startsWith('.wi3388-cargo-target/') ||
  p.startsWith('.agent-tmp/');

const MAX_CORPUS_FILE = 2 * 1024 * 1024;
const PRAGMA = 'vacuous-negative-ok:';

/** Shortest literal worth judging — below this, absence proves nothing. */
const MIN_LITERAL = 8;
/** A fragment must be this long AND this share of the literal to count as drift. */
const MIN_FRAGMENT = 12;
const FRAGMENT_SHARE = 0.7;

/** Whole-file exemptions. Prefer the inline pragma. */
const ALLOW = new Set([]);

/**
 * DRIFTED gates: a prose literal that exists nowhere emittable, while a long fragment of
 * it IS in the source — the guard is pinned to that string's OLD wording.
 * ORPHANED reports only: nothing resembling the literal survives, or the literal is not
 * prose (a value pin, a shape guard, fixture-composed output).
 *
 * @typedef {'DRIFTED' | 'ORPHANED'} VacuousVerdict
 */

/**
 * A negative assertion with a static literal argument, as extracted from a test file.
 *
 * @typedef {object} NegativeAssertion
 * @property {number} line - 1-indexed line of the assertion in the test file.
 * @property {string} kind - Rendered matcher form, e.g. `not.toMatch(/…/)`.
 * @property {string} lit - The static string the assertion pins.
 * @property {string} span - The matched assertion text, used to exclude self-references.
 */

/**
 * One judged assertion that did not survive the gate.
 *
 * @typedef {object} VacuousFinding
 * @property {string} file
 * @property {number} line
 * @property {string} kind
 * @property {string} lit
 * @property {VacuousVerdict} verdict
 * @property {string | null} fragment - The reworded fragment the source still carries, or null when nothing is close.
 */

/**
 * Answers "does the non-test corpus contain this string". Injected so the unit tests can
 * drive a synthetic corpus.
 *
 * @typedef {(needle: string) => boolean} IncludesFn
 */

/**
 * The GATE is narrowed to PROSE — multi-word wording with no embedded values. That is
 * where this class actually bites (banners, prompt text, advice strings: copy that gets
 * reworded often, and carries negative guards precisely because a bad phrasing already
 * caused an incident once), and it is the shape that CANNOT be produced by interpolating
 * a value, so its absence is decisive.
 *
 * The non-prose population is dominated by legitimate guards this must not fail:
 * value pins (`SKIP_FROMREPO="${SKIP_FROMREPO:-0}"` — the default must not be 0), shape
 * guards (`kill "$PORT_LOCK_KEEPER_PID"` — stop.sh must not force-kill the keeper), and
 * fixture-composed output (`(subpath "/p")`). Every one of those was a live finding on
 * the first sweep of this repo, and every one is a *good* assertion. They stay visible
 * under --report; they do not gate.
 *
 * @param {string} lit
 * @returns {boolean}
 */
export function proseShaped(lit) {
  if (lit.length < 15) return false;
  if (/\d/.test(lit)) return false; // a digit means a value, and values are interpolated
  if (lit.trim().split(/\s+/).filter(Boolean).length < 3) return false;
  return (lit.match(/[A-Za-z]/g) || []).length / lit.length >= 0.6;
}

// ── literal extraction ────────────────────────────────────────────────────────────
const PUNCT_ESCAPES = new Set([
  '.', '(', ')', '[', ']', '{', '}', '$', '^', '*', '+', '?', '|', '/', '\\', '-', '"', "'", '`',
]);
const META = new Set(['.', '(', ')', '[', ']', '{', '}', '$', '^', '*', '+', '?', '|']);

/**
 * The plain string a regex source encodes, or null when it uses real regex power
 * (`\d`, `\s`, a character class, alternation, a quantifier). Only a pattern that is
 * a plain literal can be judged by "does this string exist anywhere".
 *
 * @param {string} src - The regex source (no delimiters, no flags).
 * @returns {string | null}
 */
export function regexSourceToLiteral(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined) return null;
      if (PUNCT_ESCAPES.has(n)) {
        out += n;
        i++;
        continue;
      }
      return null;
    }
    if (META.has(c)) return null;
    out += c;
  }
  return out;
}

function unescapeJs(s) {
  return s.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|.)/g, (m, tail, uu, u4, x2) => {
    if (uu) return String.fromCodePoint(parseInt(uu, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    const map = { n: '\n', t: '\t', r: '\r' };
    return Object.prototype.hasOwnProperty.call(map, tail) ? map[tail] : tail;
  });
}

const RE_NEG_REGEX = /\.not\.toMatch\(\s*\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/[gimsuvy]*\s*\)/g;
const RE_NEG_STRING = /\.not\.(toContain|toMatch|toContainEqual)\(\s*(['"])((?:\\.|(?!\2)[^\n])*)\2\s*\)/g;
const RE_NEG_TEMPLATE = /\.not\.(toContain|toMatch)\(\s*`([^`$\n]*)`\s*\)/g;

// Positive assertions in the same file — a negative literal that CONTAINS one of these
// is a "no extra suffix/prefix" guard over a string the file proves is producible.
const RE_POS_STRING = /(?<!\.not)\.(toContain|toMatch|toBe|toEqual|toContainEqual)\(\s*(['"])((?:\\.|(?!\2)[^\n])*)\2\s*\)/g;
const RE_POS_REGEX = /(?<!\.not)\.toMatch\(\s*\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/[gimsuvy]*\s*\)/g;

/**
 * Negative assertions with a static literal argument, in source order.
 *
 * @param {string} text - Full source of one test file.
 * @returns {NegativeAssertion[]}
 */
export function extractNegativeLiterals(text) {
  /** @param {number} idx */
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;
  /** @type {NegativeAssertion[]} */
  const out = [];
  for (const m of text.matchAll(RE_NEG_REGEX)) {
    const lit = regexSourceToLiteral(m[1]);
    if (lit !== null) out.push({ line: lineOf(m.index), kind: 'not.toMatch(/…/)', lit, span: m[0] });
  }
  for (const m of text.matchAll(RE_NEG_STRING)) {
    if (!m[3].includes('${')) out.push({ line: lineOf(m.index), kind: `not.${m[1]}('…')`, lit: unescapeJs(m[3]), span: m[0] });
  }
  for (const m of text.matchAll(RE_NEG_TEMPLATE)) {
    out.push({ line: lineOf(m.index), kind: `not.${m[1]}(\`…\`)`, lit: m[2], span: m[0] });
  }
  return out.sort((a, b) => a.line - b.line);
}

function positiveLiterals(text) {
  const out = [];
  for (const m of text.matchAll(RE_POS_STRING)) if (!m[3].includes('${')) out.push(unescapeJs(m[3]));
  for (const m of text.matchAll(RE_POS_REGEX)) {
    const lit = regexSourceToLiteral(m[1]);
    if (lit) out.push(lit);
  }
  return out.filter((s) => s.length >= 4);
}

/** Pragma on the line itself, or anywhere in the contiguous comment block above it. */
function suppressed(lines, lineNo) {
  const i = lineNo - 1;
  if ((lines[i] ?? '').includes(PRAGMA)) return true;
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j] ?? '';
    if (!/^\s*(\/\/|\/\*|\*)/.test(l)) return false;
    if (l.includes(PRAGMA)) return true;
  }
  return false;
}

// ── classification ────────────────────────────────────────────────────────────────
/**
 * A maximal contiguous fragment of `lit` present in `corpus`, long enough to prove the
 * guarded string still exists in a reworded form — plus what it leaves uncovered.
 *
 * Windows of exactly the threshold length are probed and the first hit is then GROWN
 * outward. Growing matters: the residue (what the source does NOT have) is the whole
 * discriminator below, and an un-grown threshold-length window reports residue the
 * source actually contains.
 *
 * `residue` is a fixed PAIR — [before the fragment, after it]. The implementation builds
 * it as an array literal, which infers as `string[]`; the tuple only survives because it
 * is written here.
 *
 * @param {string} lit
 * @param {IncludesFn} includes
 * @returns {{ fragment: string; residue: [string, string] } | null}
 */
export function driftFragment(lit, includes) {
  const need = Math.max(MIN_FRAGMENT, Math.ceil(lit.length * FRAGMENT_SHARE));
  if (lit.length < need) return null;
  for (let start = 0; start + need <= lit.length; start++) {
    if (!includes(lit.slice(start, start + need))) continue;
    let lo = start;
    let hi = start + need;
    while (hi < lit.length && includes(lit.slice(lo, hi + 1))) hi++;
    while (lo > 0 && includes(lit.slice(lo - 1, hi))) lo--;
    return { fragment: lit.slice(lo, hi), residue: [lit.slice(0, lo), lit.slice(hi)] };
  }
  return null;
}

/**
 * A residue segment is EVIDENCE OF COMPOSITION when the test file itself supplies it —
 * that is the signature of a string the code builds at runtime from a template plus a
 * fixture value (`--workspace=` + `null`, `plan:` + `plan-started`), which is a
 * perfectly falsifiable negative assertion and must not be flagged.
 *
 * The ≥2-alphanumeric floor is what keeps the real class in: the motivating instance's
 * residue was the decoration `"⚠ "`, which a test file trivially contains in prose and
 * which no interpolation can produce.
 */
function residueIsComposed(residue, haystack) {
  return residue.some((seg) => {
    const s = seg.trim();
    if ((s.match(/[A-Za-z0-9]/g) || []).length < 2) return false;
    return haystack.includes(s);
  });
}

/**
 * Judge one test file's negative assertions. `includes` answers "does the non-test
 * corpus contain this string" — injected so the unit tests can drive a synthetic corpus.
 *
 * @param {{ file: string; text: string; includes: IncludesFn }} args
 * @returns {{ considered: number; findings: VacuousFinding[] }}
 */
export function judgeFile({ file, text, includes }) {
  const lines = text.split('\n');
  const negatives = extractNegativeLiterals(text);
  if (negatives.length === 0) return { considered: 0, findings: [] };
  const positives = positiveLiterals(text);
  /** @type {VacuousFinding[]} */
  const findings = [];
  let considered = 0;

  // The test file MINUS the negative assertions themselves — so "does this file supply
  // the string" is never answered by the very assertion under judgement.
  let haystack = text;
  for (const n of new Set(negatives.map((n) => n.span))) haystack = haystack.split(n).join('\n');

  for (const c of negatives) {
    const lit = c.lit;
    if (!lit || lit.length < MIN_LITERAL) continue;
    considered++;
    const trimmed = lit.trim();
    if (includes(lit) || (trimmed !== lit && trimmed.length >= MIN_LITERAL && includes(trimmed))) continue;

    // Fixture evidence: the test itself builds this string.
    if (haystack.includes(lit) || (trimmed !== lit && trimmed.length >= MIN_LITERAL && haystack.includes(trimmed))) continue;

    // "No extra suffix/prefix" guard over a string this file proves is producible.
    if (positives.some((p) => p !== lit && lit.includes(p))) continue;

    if (suppressed(lines, c.line)) continue;

    const drift = driftFragment(lit, includes);
    if (drift && residueIsComposed(drift.residue, haystack)) continue; // runtime-composed
    findings.push({
      file,
      line: c.line,
      kind: c.kind,
      lit,
      verdict: drift && proseShaped(lit) ? 'DRIFTED' : 'ORPHANED',
      fragment: drift?.fragment ?? null,
    });
  }
  return { considered, findings };
}

// ── run ───────────────────────────────────────────────────────────────────────────
/**
 * Deliberately `git ls-files --recurse-submodules`: half this repo's emitting code lives
 * in SUBMODULES, and a plain `git ls-files` returns none of it. It would not fail — it
 * would quietly shrink the corpus, and a shrunken corpus turns this lint into a false-
 * positive generator (the first sweep flagged five live `pre-push` hook assertions purely
 * because `bin/git-hooks/pre-push` has no file extension and was outside the corpus).
 */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '--recurse-submodules'], { cwd: ROOT, maxBuffer: 1 << 28 })
    .toString()
    .split('\n')
    .filter(Boolean);
}

/**
 * If the scan resolves to implausibly little, the enumeration broke and a ✓ would be a lie.
 *
 * ⚠ WI-6776 — this is an ABSOLUTE floor, and it does NOT catch the submodule case.
 * In a release-shaped checkout (`papercusp-checkpoint`, `papercusp-release`: submodule
 * source is `git archive`-extracted, so there is no `.git` for `--recurse-submodules` to
 * descend into) the superproject alone clears both thresholds easily while contributing
 * ZERO submodule files — measured 2026-08-02: 20,106 files vs 25,647, with 488 `libs/`
 * files against 3,714.
 *
 * For THIS lint a shrunken corpus is worse than a false clean: per the `trackedFiles`
 * note below, a smaller corpus makes literals look absent, which manufactures DRIFTED
 * findings and gates on them. So coverage is reported on BOTH exits — a red against an
 * incomplete corpus is a red you should not act on before fixing the enumeration.
 */
const MIN_EXPECTED_CORPUS = 2000;
const MIN_EXPECTED_TESTS = 500;

function main(argv) {
  const report = argv.includes('--report');
  const list = trackedFiles();
  const corpusFiles = list.filter(
    (p) => !TEST_RE.test(p) && !BINARY_RE.test(p) && !PROSE_RE.test(p) && !isExcluded(p),
  );
  const testFiles = list.filter((p) => TEST_RE.test(p) && !isExcluded(p) && !ALLOW.has(p));

  if (corpusFiles.length < MIN_EXPECTED_CORPUS || testFiles.length < MIN_EXPECTED_TESTS) {
    console.error(
      `✗ vacuous-negative-assertions: enumeration resolved to ${corpusFiles.length} corpus file(s) / ` +
        `${testFiles.length} test file(s) (expected >= ${MIN_EXPECTED_CORPUS} / ${MIN_EXPECTED_TESTS}).\n\n` +
        '  This scanned essentially nothing, so a PASS would mean "I never looked" — the same\n' +
        '  can-falsely-pass class this lint exists to catch. Fix the enumeration; do not let it\n' +
        '  report green on an empty scan.',
    );
    return 1;
  }

  const parts = [];
  for (const f of corpusFiles) {
    try {
      if (statSync(resolve(ROOT, f)).size > MAX_CORPUS_FILE) continue;
      parts.push(readFileSync(resolve(ROOT, f), 'utf8'));
    } catch {
      /* unreadable / gone since ls-files — skip */
    }
  }
  const corpus = parts.join('\n \n');
  const includes = (s) => corpus.includes(s);

  let considered = 0;
  const drifted = [];
  const orphaned = [];
  for (const f of testFiles) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('.not.to')) continue;
    const r = judgeFile({ file: f, text, includes });
    considered += r.considered;
    for (const finding of r.findings) (finding.verdict === 'DRIFTED' ? drifted : orphaned).push(finding);
  }

  if (report) {
    console.log(
      `scanned ${testFiles.length} test file(s) against ${corpusFiles.length} corpus file(s); ` +
        `${considered} static-literal negative assertion(s) judged.\n`,
    );
    console.log(
      `ORPHANED (non-gating — the literal is absent, but it is not reworded PROSE, so it is\n` +
        `most likely a deliberate value/shape guard or a "this phrasing is gone for good"\n` +
        `ratchet. A "near:" line means a long fragment IS in the source — worth a look): ${orphaned.length}\n`,
    );
    for (const f of orphaned) {
      console.log(`    ${f.file}:${f.line}  ${f.kind}  ${JSON.stringify(f.lit)}`);
      if (f.fragment) console.log(`        near: ${JSON.stringify(f.fragment)}`);
    }
    console.log('');
  }

  // WI-6776: the corpus is the instrument here, so every verdict states its coverage.
  const cov = coverageOf(list, ROOT);
  const coverageNote = describeUnscanned(cov, ROOT);

  if (drifted.length === 0) {
    console.log(
      `✓ vacuous negative assertions: none of ${considered} static-literal negative assertion(s) ` +
        `pins a reworded string (${orphaned.length} orphaned, non-gating). Corpus: ${corpusFiles.length} file(s) ` +
        `across the superproject + ${cov.scanned.length}/${cov.declared.length} submodule(s).` +
        coverageNote,
    );
    return 0;
  }

  console.error('✗ vacuous-negative-assertions: negative assertion(s) that can NEVER fail.\n');
  console.error(
    '  Each literal below appears nowhere the system could emit it — not in any tracked\n' +
      '  non-test file, not as a fixture in its own test — yet a long fragment of it IS in the\n' +
      "  source. The string it guards still exists; the guard is pinned to that string's OLD\n" +
      '  wording, so it passes unconditionally no matter what the code does.\n',
  );
  for (const f of drifted) {
    console.error(`    ${f.file}:${f.line}  ${f.kind}`);
    console.error(`      pins:      ${JSON.stringify(f.lit)}`);
    console.error(`      source has: ${JSON.stringify(f.fragment)}\n`);
  }
  console.error(
    `  ${drifted.length} finding(s). Re-point each assertion at the CURRENT wording, or delete it\n` +
      `  if the guard is obsolete. If the absence is deliberate, annotate the line with\n` +
      `  "// ${PRAGMA} <reason>". See EI-18765867705399052.`,
  );
  if (coverageNote) {
    // WI-6776: a finding here means "this literal exists nowhere emittable". If the
    // corpus never opened a subtree, that premise is unproven and these may be
    // artefacts of the gap rather than real dead guards — fix coverage FIRST.
    console.error(
      `\n  ⚠ READ THIS BEFORE ACTING ON THE FINDINGS — the corpus was INCOMPLETE:` +
        `${coverageNote}\n` +
        `  Every verdict above rests on "the literal appears in no tracked non-test file", which\n` +
        `  an incomplete corpus cannot establish. Re-run where the enumeration is whole before\n` +
        `  editing any assertion.`,
    );
  }
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) process.exit(main(process.argv.slice(2)));
