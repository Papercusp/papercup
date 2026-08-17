/**
 * mutation-probe-example-is-runnable.test.ts — WI-39608.
 *
 * THE CLAIM THIS PINS: the copy-paste EXAMPLE in `scripts/mutation-probe.sh` is an
 * invocation that actually runs and actually probes what it says it probes.
 *
 * WHY A GUARD AND NOT A REVIEW. A mutation probe is the instrument you reach for when
 * you want to know whether a guard is real, so a broken example does not fail like a
 * broken example — it fails like EVIDENCE ABOUT THE GUARD. Measured on 2026-08-17, the
 * one documented example had accumulated THREE independent defects, none of which any
 * test could see:
 *
 *   1. `--test` named `apps/operator/lib/verify-tauri-headless-bind-retry.test.ts`,
 *      which did NOT read PROBE_SCRIPT — it resolved its subject from a hardcoded
 *      path. So `{}` substituted into an env var nothing consumed, the guard ran
 *      against the UNMUTATED tracked file, passed, and the probe reported
 *      "mutant SURVIVED": a false verdict that the guard is weak, about a guard that
 *      is fine. This is the failure mode worth the most: it LIES, quietly, in the
 *      confident direction.
 *   2. The `--mutate` pattern `s/^\s*port_lost_to_squatter .*$//` matched ZERO lines,
 *      because the call site had since become `if port_lost_to_squatter; then ...; fi`.
 *      A no-op mutation makes any guard look weak.
 *   3. The subject contains `rm`/`unlink`, so the destructive-primitive gate refuses
 *      the invocation outright unless `--fake-destructive` is passed.
 *
 * Defects 2 and 3 fail LOUDLY (exit 2, with an explanation). Defect 1 did not — which
 * is why the example is now pinned mechanically rather than by reading it carefully.
 *
 * NOTE ON SCOPE. `CLAUDE.md` / `AGENTS.md` carry a copy of this example, but they are
 * PROJECTIONS of `harness_shared.harness_doc_parts` and there is currently no
 * agent-facing write path for a part (`validateDocPart` has zero production callers),
 * so this guard deliberately judges only the in-tree script it can keep green. See the
 * follow-up filed alongside WI-39608.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * PROBE_SCRIPT makes this suite's own subject redirectable, so its falsifiability can
 * be proven by the tier-2 copy-out the script documents — never by mutating the
 * tracked file, which git-sync would happily commit mid-probe.
 */
const PROBE = process.env.PROBE_SCRIPT ?? resolve(REPO_ROOT, 'scripts/mutation-probe.sh');

/** A parsed `scripts/mutation-probe.sh` invocation. */
interface Example {
  /** `--file` — the subject whose mutation is being probed. */
  file: string;
  /** The PATTERN half of the `--mutate` `s/PAT/REPL/` expression. */
  mutatePattern: string;
  /** The full `--test` guard command. */
  test: string;
  /** Every bare `--flag` present in the invocation. */
  flags: string[];
}

/**
 * Pull the EXAMPLE invocation out of the script's own comment header.
 *
 * Deliberately parses the COMMENT, not a duplicated copy kept in this file: a copy here
 * would be a second thing to keep in sync, and the whole defect class is a copy drifting
 * from what it describes.
 */
export function parseExample(src: string): Example | null {
  const block = src.match(/^# EXAMPLE\b[\s\S]*?(?=\n# [A-Z][A-Z ]{3,}\n)/m)?.[0];
  if (!block) return null;
  // Strip the leading `#` and any line-continuation backslashes to recover one command.
  const uncommented = block
    .split('\n')
    .map((l) => l.replace(/^#\s?/, ''))
    .join('\n')
    .replace(/\\\n/g, ' ');

  // Take the INVOCATION only, discarding the explanatory prose above it. This is not
  // tidiness: the prose names the very flags being asserted on, so parsing the whole
  // block let a `--fake-destructive` MENTIONED in a comment satisfy a check about the
  // flag being PASSED. Measured — the copy-out probe that deleted the real flag reported
  // MUTANT SURVIVED until this narrowing landed.
  const start = uncommented.indexOf('scripts/mutation-probe.sh');
  if (start < 0) return null;
  const cmd = uncommented.slice(start);

  const file = cmd.match(/--file\s+(\S+)/)?.[1];
  const mutate = cmd.match(/--mutate\s+'([^']*)'/)?.[1];
  const test = cmd.match(/--test\s+'([^']*)'/)?.[1];
  if (!file || !mutate || !test) return null;

  // `s<delim>PAT<delim>REPL<delim>flags` — take the delimiter from the expression itself
  // rather than assuming `/`, since the script's own docs use `s|...|...|` too.
  const delim = mutate[1];
  if (mutate[0] !== 's' || !delim) return null;
  const parts = splitUnescaped(mutate.slice(2), delim);
  if (parts.length < 2) return null;

  return {
    file,
    mutatePattern: parts[0],
    test,
    flags: [...cmd.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map((m) => m[1]),
  };
}

/** Split on `delim`, honouring backslash escapes (a `\/` inside a pattern is literal). */
function splitUnescaped(s: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      cur += s[i] + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (s[i] === delim) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

/**
 * Translate the script's POSIX-ERE destructive-primitive pattern into a JS RegExp.
 *
 * Bounded on purpose: `[[:alnum:]]` is the only POSIX class the ERE uses, and anything
 * else throws rather than silently matching differently from the gate.
 */
export function ereToRegExp(ere: string): RegExp {
  const translated = ere.replace(/\[:alnum:\]/g, 'a-zA-Z0-9');
  const leftover = translated.match(/\[:[a-z]+:\]/)?.[0];
  if (leftover) throw new Error(`untranslated POSIX class ${leftover} — widen ereToRegExp before trusting this guard`);
  return new RegExp(translated);
}

const src = readFileSync(PROBE, 'utf8');

describe('WI-39608 — mutation-probe.sh EXAMPLE is a runnable invocation', () => {
  it('is reading the right script (guards a vacuous suite)', () => {
    expect(src).toContain('mutation-probe');
    expect(src).toContain('DESTRUCTIVE_ERE=');
  });

  it('parses an EXAMPLE invocation out of the script header', () => {
    const ex = parseExample(src);
    expect(ex).not.toBeNull();
    expect(ex!.file).toBeTruthy();
    expect(ex!.mutatePattern).toBeTruthy();
    expect(ex!.test).toBeTruthy();
  });

  it('substitutes {} in --test, as copy-out mode requires', () => {
    // Without this the mutated copy's path is never handed to the guard at all, and the
    // script itself refuses the invocation (`--test must contain {}`).
    expect(parseExample(src)!.test).toContain('{}');
  });

  it('names a --test target that actually READS PROBE_SCRIPT (defect 1)', () => {
    const ex = parseExample(src)!;
    // The `{}` is substituted into PROBE_SCRIPT, so the named suite must consume it.
    // A suite that resolves its subject from a hardcoded path measures the UNMUTATED
    // tracked file and reports a false "mutant SURVIVED".
    expect(ex.test).toMatch(/PROBE_SCRIPT=\{\}/);
    const named = ex.test.match(/(\S+\.test\.tsx?)\b/)?.[1];
    expect(named, 'the --test command must name a .test.ts file').toBeTruthy();
    const target = readFileSync(resolve(REPO_ROOT, named!), 'utf8');
    expect(target, `${named} must read process.env.PROBE_SCRIPT`).toMatch(
      /process\.env\.PROBE_SCRIPT/,
    );
  });

  it('carries a --mutate pattern that still MATCHES the subject (defect 2)', () => {
    const ex = parseExample(src)!;
    const subject = readFileSync(resolve(REPO_ROOT, ex.file), 'utf8');
    // Perl applies the expression per line, so `^`/`$` anchor to lines: 'm' is the
    // faithful JS equivalent.
    const re = new RegExp(ex.mutatePattern, 'm');
    expect(re.test(subject), `--mutate ${re} matches nothing in ${ex.file} — a no-op mutation makes any guard look weak`).toBe(true);
  });

  it('passes --fake-destructive when the subject trips the destructive gate (defect 3)', () => {
    const ex = parseExample(src)!;
    // Read the gate's OWN pattern out of the script rather than re-spelling it here, so
    // widening the gate cannot leave this guard judging by a stale copy.
    const ere = src.match(/^DESTRUCTIVE_ERE='([^']+)'/m)?.[1];
    expect(ere, 'DESTRUCTIVE_ERE must be readable from the script').toBeTruthy();
    const subject = readFileSync(resolve(REPO_ROOT, ex.file), 'utf8');
    const trips = ereToRegExp(ere!).test(subject) || ereToRegExp(ere!).test(ex.test);
    if (trips) {
      expect(
        ex.flags.some((f) => f === '--fake-destructive' || f === '--i-know-this-deletes'),
        `${ex.file} matches the destructive-primitive gate, so the example must pass --fake-destructive or it is refused (exit 2)`,
      ).toBe(true);
    } else {
      // Not vacuous: record that the branch was evaluated against a real subject.
      expect(subject.length).toBeGreaterThan(0);
    }
  });
});

/**
 * PERMANENT CONTROLS — deliberately-wrong examples kept in the test file so the
 * assertions above can never pass on dead code, and so falsifiability never requires
 * mutating the tracked script.
 *
 * Each control is the exact defect the matching assertion exists to catch.
 */
describe('WI-39608 — the checks above are falsifiable (permanent controls)', () => {
  const header = (body: string) => `# EXAMPLE (control)\n${body}\n#\n# EXIT CODES\n`;

  it('the {} check rejects a --test with no substitution marker', () => {
    const ex = parseExample(
      header(
        "#   scripts/mutation-probe.sh --file scripts/mutation-probe.sh \\\n#     --mutate 's/set -uo/set -u/' \\\n#     --test 'npm run test:file -- packages/operator-core/lib/doc-claims/mutation-probe-example-is-runnable.test.ts'",
      ),
    );
    expect(ex).not.toBeNull();
    expect(ex!.test).not.toContain('{}');
  });

  it('the PROBE_SCRIPT check rejects a target that hardcodes its subject', () => {
    // A file that provably does NOT read PROBE_SCRIPT — the repo's own package.json.
    const notASubject = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
    expect(notASubject).not.toMatch(/process\.env\.PROBE_SCRIPT/);
  });

  it('the --mutate check rejects a pattern that matches nothing', () => {
    const subject = readFileSync(resolve(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
    // The ORIGINAL, now-stale pattern from the pre-fix example. If this ever starts
    // matching again, the control has stopped controlling — and the message says so.
    const stale = new RegExp(String.raw`^\s*port_lost_to_squatter .*$`, 'm');
    expect(stale.test(subject), 'the stale pattern matches again — pick a fresh negative control').toBe(false);
  });

  it('the destructive-gate check sees the example subject as destructive', () => {
    const ere = src.match(/^DESTRUCTIVE_ERE='([^']+)'/m)?.[1];
    const subject = readFileSync(resolve(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
    // Calibration: the real subject MUST trip the gate, or the `trips` branch above is
    // never exercised and the assertion is decorative.
    expect(ereToRegExp(ere!).test(subject)).toBe(true);
  });

  it('a flag MENTIONED in prose does not count as a flag PASSED', () => {
    // The exact false-pass a copy-out probe caught in the first cut of this guard: the
    // example's prose explains why --fake-destructive is needed, so parsing the whole
    // comment block found the flag even after it was deleted from the invocation.
    const ex = parseExample(
      header(
        "#   ...so --fake-destructive is required to run it at all.\n#   scripts/mutation-probe.sh --file scripts/mutation-probe.sh \\\n#     --mutate 's/set -uo/set -u/' \\\n#     --test 'PROBE_SCRIPT={} true'",
      ),
    );
    expect(ex).not.toBeNull();
    expect(ex!.flags).not.toContain('--fake-destructive');
  });

  it('ereToRegExp refuses a POSIX class it cannot translate', () => {
    expect(() => ereToRegExp('\\b[[:digit:]]+\\b')).toThrow(/untranslated POSIX class/);
  });
});
