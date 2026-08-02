#!/usr/bin/env node
/**
 * check-mock-cast-escape.mjs — ratchet guard against NEW `as never` / `as any` casts
 * that close a vitest `.mock*(...)` call (EI-19282401068515102).
 *
 * THE TRAP: `vi.mocked(realFn)` is meant to typecheck whatever you install via
 * `.mockImplementation(...)` / `.mockResolvedValue(...)` / `.mockReturnValue(...)` /
 * `.mockRejectedValue(...)` (and their `Once` siblings) against `realFn`'s OWN real
 * signature — that is the entire point of calling `vi.mocked()` instead of using a bare
 * `vi.fn()`. Casting the installed value `as never` (or `as any`) defeats that check
 * completely: the argument becomes assignable to ANY signature, so a fixture that goes
 * stale the moment the real function's return type changes (most commonly: a shared
 * interface gains a REQUIRED field) is invisible to tsc. It fails at RUNTIME instead, in
 * a file the actual change never touched, and `test:affected` will not even select it.
 *
 * CONFIRMED LIVE (2026-08-01, WI-6673): adding the required `admitted` field to
 * `IssueClaimabilityReading` silently broke 14 tests across two files — both committed
 * red — precisely because each fixture's mocked return value was cast `as never`. See
 * `claimable.test.ts`'s own `HEALTHY_ADMITTED` comment, which now documents the trap at
 * the site it bit. CLAUDE.md already documents the required-field trap in general terms
 * ("Tests after editing" / `lint:required-field-strands`); this guard targets the
 * SPECIFIC idiom that makes tsc blind to it even when a fixture DOES go stale.
 *
 * NOT a mandate to fix the ~750 pre-existing occurrences across ~515 files — `as never`
 * on a vitest mock argument is the dominant idiom in this codebase's tests, in no small
 * part because a complex async signature is genuinely awkward to type by hand without a
 * helper (see `packages/operator-core/lib/testing/typed-mock.ts`, added alongside this
 * guard as the ergonomic typed alternative). This is the SAME ratchet-only-down pattern
 * as `lint:vite-externalized` / `lint:tsc` / `KNOWN_DARK_FLAGS`: a single committed
 * baseline COUNT (`.mock-cast-escape-baseline.json`) gates only a NEW increase; a bare
 * run below baseline is check-only and never silently locks in a lower number — only
 * `--update`, run deliberately, ratchets it down.
 *
 * Usage:
 *   node scripts/check-mock-cast-escape.mjs             # gate: fail iff the count rose above baseline
 *   node scripts/check-mock-cast-escape.mjs --update     # ratchet the baseline down to the current count
 *   node scripts/check-mock-cast-escape.mjs --json       # machine-readable report
 *
 * Exit codes:
 *   0 — at or below baseline (below-baseline only locks in with --update)
 *   1 — count exceeded baseline (a NEW escape was added), or the baseline file is unreadable
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = resolve(ROOT, '.mock-cast-escape-baseline.json');

/** `.mockImplementation(`, `.mockResolvedValueOnce(`, … — every vitest mock-install verb. */
const MOCK_CALL_RE =
  /\.mock(Implementation(?:Once)?|ReturnValue(?:Once)?|ResolvedValue(?:Once)?|RejectedValue(?:Once)?)\s*\(/g;

/** The installed argument ends in a bare `as never` / `as any` — the type-escape idiom. */
const AS_ESCAPE_RE = /\bas\s+(never|any)\s*$/;

/**
 * Mask out string/template-literal contents and comments with spaces (preserving line
 * breaks and overall length, so reported line numbers stay correct), so a stray paren or
 * the literal text "as never" inside a STRING can never be mistaken for real code. `${…}`
 * interpolation inside a template literal is left live (it is real code), tracked via a
 * simple brace-depth counter; nested template literals inside an interpolation are not
 * specially handled (a rare-enough shape in test fixtures to accept as a known gap for a
 * narrow, advisory guard).
 *
 * @param {string} text
 * @returns {string}
 */
export function maskStringsAndComments(text) {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : '';

    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }

    if (c === '/' && c2 === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      out[i] = ' ';
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') {
          out[i] = ' ';
          i++;
          if (i < n) {
            out[i] = text[i] === '\n' ? '\n' : ' ';
            i++;
          }
          continue;
        }
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        i++;
      }
      continue;
    }

    if (c === '`') {
      out[i] = ' ';
      i++;
      let depth = 0;
      while (i < n) {
        if (depth === 0 && text[i] === '\\') {
          out[i] = ' ';
          i++;
          if (i < n) {
            out[i] = text[i] === '\n' ? '\n' : ' ';
            i++;
          }
          continue;
        }
        if (depth === 0 && text[i] === '`') {
          out[i] = ' ';
          i++;
          break;
        }
        if (depth === 0 && text[i] === '$' && text[i + 1] === '{') {
          i += 2;
          depth = 1;
          continue;
        }
        if (depth > 0) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') depth--;
          i++;
          continue;
        }
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    i++;
  }
  return out.join('');
}

/**
 * Index of the `)` matching the `(` at `openIndex`, scanning `text` (already
 * comment/string-masked, so stray parens inside literals cannot desync the count).
 * @param {string} text
 * @param {number} openIndex - must point at a `(`.
 * @returns {number} -1 if unbalanced (never closes) — callers must skip, not crash.
 */
export function findMatchingParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * @typedef {object} MockCastEscape
 * @property {number} line - 1-based line number of the `.mockXxx(` call itself.
 * @property {string} verb - e.g. 'mockResolvedValue'.
 * @property {'never'|'any'} kind
 * @property {string} snippet - the source line, trimmed, for display.
 */

/**
 * Every `.mock*(...)` call in `rawText` whose installed argument(s) end in a bare
 * `as never` / `as any` — regardless of how many lines the call spans.
 *
 * @param {string} rawText
 * @returns {MockCastEscape[]}
 */
export function findMockCastEscapesInText(rawText) {
  const masked = maskStringsAndComments(rawText);
  /** @type {MockCastEscape[]} */
  const results = [];
  MOCK_CALL_RE.lastIndex = 0;
  let m;
  while ((m = MOCK_CALL_RE.exec(masked)) !== null) {
    const openParenIndex = m.index + m[0].length - 1;
    const closeIndex = findMatchingParen(masked, openParenIndex);
    if (closeIndex === -1) continue; // unbalanced — a masking edge case, not a crash
    const argsText = masked.slice(openParenIndex + 1, closeIndex);
    const escMatch = AS_ESCAPE_RE.exec(argsText.replace(/\s+$/, ''));
    if (!escMatch) continue;

    const lineNum = rawText.slice(0, m.index).split('\n').length;
    const lineStart = rawText.lastIndexOf('\n', m.index) + 1;
    const lineEndIdx = rawText.indexOf('\n', m.index);
    const lineText = rawText.slice(lineStart, lineEndIdx === -1 ? rawText.length : lineEndIdx).trim();

    results.push({
      line: lineNum,
      verb: `mock${m[1]}`,
      kind: /** @type {'never'|'any'} */ (escMatch[1]),
      snippet: lineText,
    });
  }
  return results;
}

/**
 * Pure gate decision — mirrors `check-vite-externalized-warnings.mjs`'s `decide()`
 * (the same ratchet-only-down, `--update`-only policy), unit-testable in isolation.
 * @param {{ count: number, baselineCount: number, updateFlag?: boolean }} args
 * @returns {{ verdict: 'fail-exceeds'|'ok-ratchet'|'ok-below'|'ok', newBaseline?: number, belowBy?: number }}
 */
export function decide({ count, baselineCount, updateFlag = false }) {
  if (count > baselineCount) return { verdict: 'fail-exceeds' };
  if (count < baselineCount) {
    return updateFlag ? { verdict: 'ok-ratchet', newBaseline: count } : { verdict: 'ok-below', belowBy: baselineCount - count };
  }
  return { verdict: 'ok' };
}

function listTestFiles() {
  const out = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function readBaseline() {
  const json = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'));
  return json.count;
}

function writeBaseline(count) {
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify(
      {
        count,
        _comment:
          'RATCHET-ONLY-DOWN (see scripts/check-mock-cast-escape.mjs). Raising this is a deliberate ' +
          'hand-edit with a justification, never an automatic write. Regenerate with --update on a quiet tree.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Baseline updated → ${count}`);
}

function main() {
  const argv = process.argv.slice(2);
  const updateFlag = argv.includes('--update');
  const json = argv.includes('--json');

  const baselineCount = readBaseline();

  const files = listTestFiles();
  /** @type {Record<string, MockCastEscape[]>} */
  const byFile = {};
  let count = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, file), 'utf-8');
    } catch {
      continue; // deleted/renamed since `git ls-files` ran — not a crash
    }
    const found = findMockCastEscapesInText(text);
    if (found.length) {
      byFile[file] = found;
      count += found.length;
    }
  }

  const decision = decide({ count, baselineCount, updateFlag });

  if (json) {
    console.log(JSON.stringify({ count, baselineCount, verdict: decision.verdict, byFile }, null, 2));
  }

  switch (decision.verdict) {
    case 'fail-exceeds': {
      if (!json) {
        console.error(`❌ mock-cast-escape count exceeded baseline: ${count} > ${baselineCount} (+${count - baselineCount}).`);
        console.error(`   A NEW \`as never\`/\`as any\` cast now closes a vitest .mock*() call — this is the exact`);
        console.error(`   idiom that made WI-6673's stale fixtures invisible to tsc (EI-19282401068515102).`);
        console.error('');
        const sorted = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
        console.error('   Files carrying at least one occurrence (existing debt may be baselined; find the NEW one):');
        for (const [file, hits] of sorted.slice(0, 25)) {
          console.error(`     ${file} (${hits.length})`);
          for (const h of hits.slice(0, 3)) console.error(`       L${h.line}: ${h.snippet}`);
        }
        console.error('');
        console.error('   Fix the fixture instead of casting it away: use the typed helpers in');
        console.error('   packages/operator-core/lib/testing/typed-mock.ts (mockResolvedTyped / mockReturnTyped /');
        console.error('   mockImplementationTyped) so a stale fixture is a tsc error, not a silent runtime failure.');
        console.error('   If this genuinely cannot be typed, that is a deliberate exception — lower the count back');
        console.error('   down elsewhere, or raise the baseline with an explicit justification (never a silent bump).');
      }
      process.exit(1);
      break;
    }
    case 'ok-ratchet':
      writeBaseline(decision.newBaseline);
      process.exit(0);
      break;
    case 'ok-below':
      if (!json) {
        console.log(
          `✓ ${decision.belowBy} under baseline (${count} < ${baselineCount}) — NOT locked in. Run ` +
            '`node scripts/check-mock-cast-escape.mjs --update` on a quiet tree to lower it deliberately.',
        );
      }
      process.exit(0);
      break;
    default:
      if (!json) {
        if (updateFlag) console.log('✓ --update: count equals baseline — nothing to lower.');
        console.log(`✓ mock-cast-escape count is at baseline (${count})`);
      }
      process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
