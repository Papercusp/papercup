/**
 * Tests for the P-021 output-diff replay harness.
 *
 * These are organised around the ways the harness could LIE rather than around
 * its functions, because "reports clean" is the claim that matters and every
 * interesting bug makes it easier to say. The mutation suite is load-bearing: it
 * breaks a known-good rewrite in specific ways and asserts the harness NOTICES.
 * Without it, a harness that returned `match` unconditionally would pass every
 * other test in this file.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import readTool from '../agent-tools/capability/read';
import { FILE_READ_PAIRS, catFileRead, headFileRead, sedRangeRead, tailFileRead } from './pairs/file-read';
import {
  assertReplayEnvelope,
  createBashExecutor,
  deriveCaseVerdict,
  deriveReplayVerdict,
  firstDivergence,
  deriveSavings,
  isReplaySafe,
  normalizeAnswer,
  replayCase,
  replayPair,
  retargetAtom,
  SAVINGS_NEUTRAL_BAND,
  type ReplayCase,
  type ReplayExecutors,
  type SideResult,
} from './replay';
import type { AnswerEnvelope, SampledCommand, SubstitutionPair } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let dir: string;
let smallPath: string;
let bigPath: string;
let longLinePath: string;

/** 40 lines, each distinguishable, so an off-by-one is visible in the failure text. */
const SMALL_LINES = Array.from({ length: 40 }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bash-replay-'));
  smallPath = join(dir, 'small.txt');
  bigPath = join(dir, 'big.txt');
  longLinePath = join(dir, 'longline.txt');

  writeFileSync(smallPath, `${SMALL_LINES.join('\n')}\n`, 'utf8');
  // Deliberately past capability:read's 2000-line default page, so a whole-file
  // read has something to be wrong about.
  writeFileSync(bigPath, `${Array.from({ length: 2500 }, (_, i) => `big-${i + 1}`).join('\n')}\n`, 'utf8');
  // Past the tool's 2000-char per-line truncation.
  writeFileSync(longLinePath, `${'x'.repeat(2500)}\nshort\n`, 'utf8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The REAL tool, called the way dispatch calls it. */
const runRealRead: ReplayExecutors['runTool'] = async (call) => {
  const result = (await readTool.handler(call.args as never, { projectDir: dir } as never)) as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  const text = result.content?.[0]?.text ?? '';
  return { ok: result.isError !== true, text, failure: result.isError === true ? text : undefined };
};

const realExecutors = (): ReplayExecutors => ({ runBash: createBashExecutor(), runTool: runRealRead });

const options = () => ({ fixturePath: smallPath, cwd: dir });

const sample = (atoms: string[]): SampledCommand[] =>
  atoms.map((atom, i) => ({ sid: `su-test-${i}`, ts: '2026-08-02T00:00:00.000Z', atom }));

const ok = (text: string): SideResult => ({ ok: true, text });
const failed = (failure: string): SideResult => ({ ok: false, text: '', failure });

// ─────────────────────────────────────────────────────────────────────────────
// Trap 1 — a shared failure is not agreement
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCaseVerdict — the both-sides-failed trap', () => {
  it('scores two failures as inconclusive, NEVER as a match', () => {
    const derived = deriveCaseVerdict({
      bash: failed('exit 1: No such file or directory'),
      tool: failed('read_failed: ENOENT'),
      bashAnswer: [],
      toolAnswer: [],
    });

    expect(derived.verdict).toBe('inconclusive');
    expect(derived.reason).toContain('a shared failure is not agreement');
  });

  it('scores two EMPTY answers as inconclusive — nothing was compared', () => {
    const derived = deriveCaseVerdict({ bash: ok(''), tool: ok(''), bashAnswer: [], toolAnswer: [] });
    expect(derived.verdict).toBe('inconclusive');
    expect(derived.reason).toContain('nothing was compared');
  });

  it('scores a one-sided failure as a DIFFERENCE, not as inconclusive', () => {
    expect(
      deriveCaseVerdict({ bash: failed('exit 2'), tool: ok('x'), bashAnswer: [], toolAnswer: ['x'] }).verdict,
    ).toBe('differs');
    expect(
      deriveCaseVerdict({ bash: ok('x'), tool: failed('boom'), bashAnswer: ['x'], toolAnswer: [] }).verdict,
    ).toBe('differs');
  });

  it('matches only when both sides answered and the answers are identical', () => {
    expect(
      deriveCaseVerdict({ bash: ok('a\nb'), tool: ok('a\nb'), bashAnswer: ['a', 'b'], toolAnswer: ['a', 'b'] })
        .verdict,
    ).toBe('match');
  });

  it('reports WHERE the answers diverge, so a failure is diagnosable', () => {
    const derived = deriveCaseVerdict({
      bash: ok(''),
      tool: ok(''),
      bashAnswer: ['a', 'b', 'c'],
      toolAnswer: ['a', 'X', 'c'],
    });
    expect(derived.verdict).toBe('differs');
    expect(derived.firstDivergentLine).toBe(2);
    expect(derived.reason).toContain('"b"');
    expect(derived.reason).toContain('"X"');
  });

  it('catches a length difference even when the shared prefix is identical', () => {
    expect(firstDivergence(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
    expect(firstDivergence(['a', 'b', 'c'], ['a', 'b'])).toBe(2);
    expect(firstDivergence(['a', 'b'], ['a', 'b'])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trap 2 — the normalizer must not eat the difference
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeAnswer — a closed set of strips', () => {
  const envelope: AnswerEnvelope = {
    stripLeadingLines: /^(?!\s*\d+\t).*\(\d+ lines(?:, showing \d+–\d+)?\)$/,
    stripLinePrefix: /^\s*\d+\t/,
    stripTrailing: /\n\n… \[\d+ more lines — re-read with offset=\d+\]$/,
  };

  it('strips header, line numbers and footer to reach the content', () => {
    const framed = ['/tmp/x.txt (3 lines, showing 1–2)', '     1\talpha', '     2\tbeta'].join('\n');
    expect(normalizeAnswer(`${framed}\n\n… [1 more lines — re-read with offset=3]`, envelope)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('does NOT mistake a content line for the header — the line-number guard', () => {
    // A file whose text reads like the tool's own header. Without the
    // `(?!\s*\d+\t)` guard this line is deleted as framing and the answer is a
    // silent line short.
    const framed = ['/tmp/x.txt (2 lines)', '     1\tnotes.txt (7 lines)', '     2\tbeta'].join('\n');
    expect(normalizeAnswer(framed, envelope)).toEqual(['notes.txt (7 lines)', 'beta']);
  });

  it('strips exactly ONE line-number prefix, leaving tab-separated content intact', () => {
    expect(normalizeAnswer('     1\t123\tpayload', envelope)).toEqual(['123\tpayload']);
  });

  it('drops exactly one trailing empty line, so the two sides are comparable', () => {
    // bash streams end with a newline; the tool's joined payload does not.
    expect(normalizeAnswer('a\nb\n')).toEqual(['a', 'b']);
    expect(normalizeAnswer('a\nb')).toEqual(['a', 'b']);
    // ...but only one: a genuinely blank final line survives.
    expect(normalizeAnswer('a\nb\n\n')).toEqual(['a', 'b', '']);
  });

  it('preserves order, blank lines, case and whitespace — the operations it must NOT do', () => {
    const raw = 'b\n\n  A  \na\n';
    expect(normalizeAnswer(raw)).toEqual(['b', '', '  A  ', 'a']);
  });

  it('is a no-op beyond the trailing newline when no envelope is declared', () => {
    expect(normalizeAnswer('     1\talpha\n')).toEqual(['     1\talpha']);
  });
});

describe('assertReplayEnvelope — refusing a normalizer that can destroy content', () => {
  it('refuses an UNANCHORED line-prefix strip', () => {
    expect(() => assertReplayEnvelope({ stripLinePrefix: /\d+\t/ }, 'p')).toThrow(/anchored at \^/);
  });

  it('accepts an anchored one', () => {
    expect(() => assertReplayEnvelope({ stripLinePrefix: /^\s*\d+\t/ }, 'p')).not.toThrow();
  });

  it('refuses stateful g/y flags on every field', () => {
    expect(() => assertReplayEnvelope({ stripLinePrefix: /^\d+\t/g }, 'p')).toThrow(/stateful flag/);
    expect(() => assertReplayEnvelope({ stripLeadingLines: /^h/g }, 'p')).toThrow(/stateful flag/);
    expect(() => assertReplayEnvelope({ stripTrailing: /f$/g }, 'p')).toThrow(/stateful flag/);
  });

  it('demonstrates WHY g is refused: `test` on the SAME input alternates', () => {
    // The hazard is real but narrow, and it is worth being exact about where it
    // bites: `String.replace` resets lastIndex when it finishes, so the prefix
    // strip would survive a stray `g`. `RegExp.test` does not — and that is the
    // call `normalizeAnswer` uses to find header lines. A `g` there makes header
    // detection depend on how many lines were tested before it.
    const stateful = /^header/g;
    expect(stateful.test('header line')).toBe(true);
    expect(stateful.test('header line')).toBe(false); // identical input, opposite answer

    // Hence the ban is uniform across all three fields rather than only the one
    // that can currently bite: which field uses `test` and which uses `replace`
    // is an implementation detail of normalizeAnswer, and a future edit that
    // swaps one for the other must not silently arm a latent bug.
    const safe = /^header/;
    expect(safe.test('header line')).toBe(true);
    expect(safe.test('header line')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The safety gate
// ─────────────────────────────────────────────────────────────────────────────

describe('isReplaySafe — fail-closed', () => {
  it('admits the plain read forms', () => {
    for (const atom of ["sed -n '1,20p' /tmp/f.txt", 'cat /tmp/f.txt', 'head -n 5 /tmp/f.txt', 'tail -n 5 /tmp/f.txt']) {
      expect(isReplaySafe(atom), atom).toMatchObject({ safe: true });
    }
  });

  it.each([
    ['rm -rf /tmp/x', 'verb'],
    ['cat /tmp/a; rm /tmp/b', 'metacharacter'],
    ['cat /tmp/a && rm /tmp/b', 'metacharacter'],
    ['cat /tmp/a > /tmp/b', 'metacharacter'],
    ['cat $(ls)', 'metacharacter'],
    ['cat `ls`', 'metacharacter'],
    ['cat /tmp/*.log', 'metacharacter'],
    ['grep x /tmp/a | head -3', 'metacharacter'],
  ])('refuses %s', (atom, because) => {
    const verdict = isReplaySafe(atom);
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toContain(because);
  });

  it('refuses a non-terminating follow rather than hanging on it', () => {
    expect(isReplaySafe('tail -f /tmp/f.log')).toMatchObject({ safe: false });
    expect(isReplaySafe('tail --follow /tmp/f.log').reason).toContain('does not terminate');
  });

  it('refuses an empty command', () => {
    expect(isReplaySafe('   ')).toMatchObject({ safe: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trap 3 — "no failures" is not "passes"
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveReplayVerdict — partial coverage is not coverage', () => {
  const c = (verdict: ReplayCase['verdict'], reason?: string): ReplayCase => ({
    sourceAtom: 'a',
    replayedAtom: 'a',
    verdict,
    reason,
  });

  it('is clean only when every case ran and matched', () => {
    expect(deriveReplayVerdict([c('match'), c('match')]).verdict).toBe('replay-clean');
  });

  it('a single difference dominates any number of matches', () => {
    expect(deriveReplayVerdict([c('match'), c('match'), c('differs', 'line 1')]).verdict).toBe('replay-differs');
  });

  it('refuses to call a run clean when some cases were never compared', () => {
    expect(deriveReplayVerdict([c('match'), c('inconclusive')]).verdict).toBe('replay-inconclusive');
    expect(deriveReplayVerdict([c('match'), c('refused', 'unsafe')]).verdict).toBe('replay-inconclusive');
    expect(deriveReplayVerdict([c('match'), c('refused', 'unsafe')]).reason).toContain('D-008');
  });

  it('reports an empty run as unavailable rather than clean', () => {
    expect(deriveReplayVerdict([]).verdict).toBe('replay-unavailable');
  });

  it('distinguishes "declares no rewrite" from "every case was unsafe"', () => {
    expect(deriveReplayVerdict([c('refused', 'no rewrite() declared on this pair')]).verdict).toBe(
      'replay-unavailable',
    );
    expect(deriveReplayVerdict([c('refused', 'unsafe to replay: verb rm')]).verdict).toBe('replay-inconclusive');
  });

  it('a difference still dominates when inconclusives are also present', () => {
    expect(deriveReplayVerdict([c('inconclusive'), c('differs', 'x'), c('refused', 'y')]).verdict).toBe(
      'replay-differs',
    );
  });
});

describe('retargetAtom', () => {
  it('points the command at the fixture', () => {
    expect(retargetAtom("sed -n '1,5p' /var/log/x.log", '/var/log/x.log', '/tmp/f.txt')).toBe(
      "sed -n '1,5p' /tmp/f.txt",
    );
  });

  it('leaves the atom alone when there is no path to swap', () => {
    expect(retargetAtom('cat /tmp/f.txt', '', '/tmp/g.txt')).toBe('cat /tmp/f.txt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end, against the REAL capability:read and real files
// ─────────────────────────────────────────────────────────────────────────────

describe('replay against the real capability:read handler', () => {
  it('the fixture is what the test thinks it is', () => {
    // Guards the whole suite: every assertion below is about a diff between two
    // readings of this file, and a wrong fixture makes all of them vacuous.
    const raw = execFileSync('/bin/bash', ['-c', `cat ${smallPath}`], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    expect(raw.split('\n').filter(Boolean)).toHaveLength(40);
  });

  it('matches on a sed line range — the cleanest substitution in the registry', async () => {
    const result = await replayCase(sedRangeRead, `sed -n '5,12p' ${smallPath}`, realExecutors(), options());
    expect(result.reason ?? '').toBe('');
    expect(result.verdict).toBe('match');
    expect(result.toolCall).toEqual({
      toolName: 'capability:read',
      args: { file_path: smallPath, offset: 5, limit: 8 },
    });
    expect(result.bashAnswer).toEqual(SMALL_LINES.slice(4, 12));
  });

  it('matches on tail -n N', async () => {
    const result = await replayCase(tailFileRead, `tail -n 7 ${smallPath}`, realExecutors(), options());
    expect(result.verdict).toBe('match');
    expect(result.toolAnswer).toEqual(SMALL_LINES.slice(-7));
  });

  it('matches on bare `tail FILE` — the POSIX default of 10 is modelled correctly', async () => {
    const result = await replayCase(tailFileRead, `tail ${smallPath}`, realExecutors(), options());
    expect(result.verdict).toBe('match');
    expect(result.toolAnswer).toEqual(SMALL_LINES.slice(-10));
  });

  it('matches on head -n N and on the -N spelling', async () => {
    for (const atom of [`head -n 6 ${smallPath}`, `head -6 ${smallPath}`]) {
      const result = await replayCase(headFileRead, atom, realExecutors(), options());
      expect(result.verdict, atom).toBe('match');
      expect(result.toolAnswer, atom).toEqual(SMALL_LINES.slice(0, 6));
    }
  });

  it('matches on cat of a file that fits inside one page', async () => {
    const result = await replayCase(catFileRead, `cat ${smallPath}`, realExecutors(), options());
    expect(result.verdict).toBe('match');
    expect(result.toolAnswer).toEqual(SMALL_LINES);
  });

  // ── The findings ──────────────────────────────────────────────────────────
  // Each of these pairs is recorded `equivalent` and honestly so: the tool CAN
  // express the command. The replay asks the other question and gets a different
  // answer. This is the entire justification for P-021 existing.

  it('REGRESSION: bare `head FILE` reads 10 lines, not 2000', async () => {
    // The bug this harness was built and immediately caught: the pair defaulted
    // to capability:read's 2000-line page instead of head's own 10, so the
    // advisory asked for a 200x over-read. It replayed as `differs` with
    // bashAnswer 10 lines, toolAnswer 40 (the whole fixture) and the first
    // divergence at line 11. Fixed by HEAD_DEFAULT_LINES; pinned here so it
    // cannot come back silently.
    const result = await replayCase(headFileRead, `head ${smallPath}`, realExecutors(), options());

    expect(result.verdict).toBe('match');
    expect(result.toolCall?.args.limit).toBe(10);
    expect(result.bashAnswer).toEqual(SMALL_LINES.slice(0, 10));
  });

  it('FINDS: `cat` of a file past the page size returns a truncated answer', async () => {
    const result = await replayCase(catFileRead, `cat ${bigPath}`, realExecutors(), {
      fixturePath: bigPath,
      cwd: dir,
    });

    expect(result.verdict).toBe('differs');
    expect(result.bashAnswer).toHaveLength(40); // stored cap; the real answer is 2500 lines
    expect(result.firstDivergentLine).toBe(2001);
  });

  it('FINDS: a line longer than 2000 chars comes back truncated', async () => {
    const result = await replayCase(catFileRead, `cat ${longLinePath}`, realExecutors(), {
      fixturePath: longLinePath,
      cwd: dir,
    });

    expect(result.verdict).toBe('differs');
    expect(result.firstDivergentLine).toBe(1);
    expect(result.toolAnswer?.[0]).toContain('[line truncated]');
  });

  it('reports a missing file as inconclusive, not as a match', async () => {
    const missing = join(dir, 'does-not-exist.txt');
    const result = await replayCase(catFileRead, `cat ${missing}`, realExecutors(), {
      fixturePath: missing,
      cwd: dir,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.reason).toContain('a shared failure is not agreement');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation suite — does the harness actually DETECT a wrong rewrite?
// ─────────────────────────────────────────────────────────────────────────────

describe('mutation — a broken rewrite must be caught', () => {
  /** Clone a pair with a deliberately wrong rewrite. */
  const mutate = (base: SubstitutionPair, mutation: (args: Record<string, unknown>) => Record<string, unknown>) =>
    ({
      ...base,
      id: `${base.id}.mutant`,
      rewrite(atom: string) {
        const original = base.rewrite?.(atom);
        return original ? { ...original, args: mutation(original.args) } : null;
      },
    }) as SubstitutionPair;

  it('catches an off-by-one offset', async () => {
    const mutant = mutate(sedRangeRead, (args) => ({ ...args, offset: Number(args.offset) + 1 }));
    const result = await replayCase(mutant, `sed -n '5,12p' ${smallPath}`, realExecutors(), options());

    expect(result.verdict).toBe('differs');
    expect(result.firstDivergentLine).toBe(1);
  });

  it('catches a dropped limit (the window silently widens)', async () => {
    const mutant = mutate(sedRangeRead, ({ limit: _dropped, ...rest }) => rest);
    const result = await replayCase(mutant, `sed -n '5,12p' ${smallPath}`, realExecutors(), options());

    expect(result.verdict).toBe('differs');
    // The prefix still matches — only the LENGTH gives it away, which is exactly
    // the case a prefix-only comparison would wave through.
    expect(result.firstDivergentLine).toBe(9);
  });

  it('catches an off-by-one limit — the smallest wrong answer there is', async () => {
    const mutant = mutate(sedRangeRead, (args) => ({ ...args, limit: Number(args.limit) - 1 }));
    expect((await replayCase(mutant, `sed -n '5,12p' ${smallPath}`, realExecutors(), options())).verdict).toBe(
      'differs',
    );
  });

  it('catches head/tail confusion — same line COUNT, wrong end of the file', async () => {
    const mutant = mutate(tailFileRead, ({ tail, ...rest }) => ({ ...rest, limit: tail }));
    const result = await replayCase(mutant, `tail -n 7 ${smallPath}`, realExecutors(), options());

    expect(result.verdict).toBe('differs');
    expect(result.toolAnswer).toHaveLength(7); // right shape, wrong content
    expect(result.firstDivergentLine).toBe(1);
  });

  it('catches a rewrite pointed at the wrong file', async () => {
    const mutant = mutate(catFileRead, (args) => ({ ...args, file_path: bigPath }));
    expect((await replayCase(mutant, `cat ${smallPath}`, realExecutors(), options())).verdict).toBe('differs');
  });

  it('refuses, rather than matches, when the rewrite declines the atom', async () => {
    const declining = { ...sedRangeRead, id: 'declining', rewrite: () => null } as SubstitutionPair;
    const result = await replayCase(declining, `sed -n '5,12p' ${smallPath}`, realExecutors(), options());
    expect(result.verdict).toBe('refused');
    expect(result.reason).toContain('declined');
  });

  it('refuses a pair that declares no rewrite at all', async () => {
    const noRewrite = { ...sedRangeRead, id: 'no-rewrite', rewrite: undefined } as SubstitutionPair;
    const result = await replayCase(noRewrite, `sed -n '5,12p' ${smallPath}`, realExecutors(), options());
    expect(result.verdict).toBe('refused');
    expect(result.reason).toContain('no rewrite');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pair-level runs
// ─────────────────────────────────────────────────────────────────────────────

describe('replayPair', () => {
  it('collapses same-shape/different-path atoms into one executed case', async () => {
    const corpus = sample([
      "sed -n '1,5p' /var/log/a.log",
      "sed -n '1,5p' /var/log/b.log",
      "sed -n '1,5p' /home/x/c.txt",
    ]);
    const result = await replayPair(sedRangeRead, corpus, realExecutors(), options());

    expect(result.cases).toHaveLength(1);
    expect(result.verdict).toBe('replay-clean');
    expect(result.matched).toBe(1);
  });

  it('keeps distinct shapes apart and reports clean when all of them match', async () => {
    const corpus = sample(["sed -n '1,5p' /var/log/a.log", "sed -n '10,12p' /var/log/b.log"]);
    const result = await replayPair(sedRangeRead, corpus, realExecutors(), options());

    expect(result.cases).toHaveLength(2);
    expect(result.verdict).toBe('replay-clean');
  });

  it('does not let an unsafe atom be silently skipped into a clean verdict', async () => {
    const corpus = sample(["sed -n '1,5p' /var/log/a.log", "sed -n '1,5p' /var/log/b.log | head -2"]);
    const result = await replayPair(sedRangeRead, corpus, realExecutors(), options());

    expect(result.refused).toBe(1);
    expect(result.verdict).toBe('replay-inconclusive');
  });

  it('honours the case cap', async () => {
    const corpus = sample(Array.from({ length: 12 }, (_, i) => `sed -n '1,${i + 2}p' /var/log/a.log`));
    const result = await replayPair(sedRangeRead, corpus, realExecutors(), { ...options(), maxCases: 3 });
    expect(result.cases).toHaveLength(3);
  });

  it('reports a savings verdict alongside the correctness verdict', async () => {
    const corpus = sample(["sed -n '1,5p' /var/log/a.log"]);
    const result = await replayPair(sedRangeRead, corpus, realExecutors(), options());

    expect(result.verdict).toBe('replay-clean');
    // The point of the axis: clean does not imply cheap, so the field must be
    // populated independently and must carry a real measurement.
    expect(result.savings.measuredCases).toBe(1);
    expect(result.savings.bashBytes).toBeGreaterThan(0);
    expect(result.savings.rewrittenBytes).toBeGreaterThan(0);
    expect(['reduces', 'neutral', 'inflates']).toContain(result.savings.verdict);
  });

  it('every file-read pair declares a rewrite AND an envelope, or is honestly unavailable', () => {
    // The two must travel together: a rewrite with no envelope compares the
    // tool's framing against bash's raw stream and reports a difference that is
    // not one; an envelope with no rewrite is never exercised at all.
    for (const pair of FILE_READ_PAIRS) {
      expect(Boolean(pair.rewrite), pair.id).toBe(Boolean(pair.replayEnvelope));
      if (pair.replayEnvelope) expect(() => assertReplayEnvelope(pair.replayEnvelope!, pair.id)).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The economy axis (P-022, D-057)
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveSavings — a correct rewrite is not automatically a cheaper one', () => {
  /** A measured case: matched, with both byte counts present. */
  const m = (bashBytes: number, toolBytes: number): ReplayCase => ({
    sourceAtom: 'a',
    replayedAtom: 'a',
    verdict: 'match',
    bashBytes,
    toolBytes,
  });

  it('calls a materially larger rewrite an inflation', () => {
    const s = deriveSavings([m(1000, 3400)]);
    expect(s.verdict).toBe('inflates');
    expect(s.deltaBytes).toBe(2400);
    expect(s.ratio).toBeCloseTo(3.4, 5);
    expect(s.reason).toContain('COSTS more');
  });

  it('calls a materially smaller rewrite a saving', () => {
    const s = deriveSavings([m(1000, 400)]);
    expect(s.verdict).toBe('reduces');
    expect(s.deltaBytes).toBe(-600);
  });

  // THE D-057 CASE, as a test. Pipe-filter pushdown returns a byte-identical
  // answer, so the correctness harness reports a clean match — and the rewrite is
  // still worthless. Before this axis existed there was nothing that could say so.
  it('calls a byte-identical rewrite NEUTRAL, not a success', () => {
    const s = deriveSavings([m(1739, 1739)]);
    expect(s.verdict).toBe('neutral');
    expect(s.deltaBytes).toBe(0);
    expect(s.reason).toContain('D-057');
  });

  it('treats movement inside the noise band as neutral, and just outside it as real', () => {
    const inside = Math.round(1000 * (1 + SAVINGS_NEUTRAL_BAND * 0.5));
    const outside = Math.round(1000 * (1 + SAVINGS_NEUTRAL_BAND * 2));
    expect(deriveSavings([m(1000, inside)]).verdict).toBe('neutral');
    expect(deriveSavings([m(1000, outside)]).verdict).toBe('inflates');
  });

  // Rule 2 of the doc comment, and the reason the enum has a fourth member.
  it('reports NO measurement as unmeasured rather than neutral', () => {
    expect(deriveSavings([]).verdict).toBe('unmeasured');
    expect(deriveSavings([]).reason).toContain('not the same as unchanged');
    expect(deriveSavings([]).ratio).toBeNull();
  });

  // Rule 1: a cheaper WRONG answer is the worst outcome available, so a differing
  // case must never be able to contribute a saving.
  it('refuses to measure economy on cases that did not match', () => {
    const differing: ReplayCase = {
      sourceAtom: 'a',
      replayedAtom: 'a',
      verdict: 'differs',
      reason: 'line 1',
      bashBytes: 10_000,
      toolBytes: 10,
    };
    const s = deriveSavings([differing]);
    expect(s.verdict).toBe('unmeasured');
    expect(s.measuredCases).toBe(0);
  });

  it('ignores refused and inconclusive cases, which never produced two texts', () => {
    const refused: ReplayCase = { sourceAtom: 'a', replayedAtom: 'a', verdict: 'refused', reason: 'unsafe' };
    const s = deriveSavings([refused, m(1000, 500)]);
    expect(s.measuredCases).toBe(1);
    expect(s.verdict).toBe('reduces');
  });

  it('drops a matched case that carries no byte measurement instead of scoring it as zero', () => {
    const unmeasured: ReplayCase = { sourceAtom: 'a', replayedAtom: 'a', verdict: 'match' };
    const s = deriveSavings([unmeasured, m(1000, 2000)]);
    expect(s.measuredCases).toBe(1);
    expect(s.bashBytes).toBe(1000);
    expect(s.verdict).toBe('inflates');
  });

  // The statistical trap, pinned. A mean of per-case ratios would report
  // ((15/10) + (9000/10000)) / 2 = 1.2 -> "inflates", for a pair that plainly
  // saves ~1KB every time it is used. Totals are what context is actually paid in.
  it('aggregates as a ratio of totals, not a mean of per-case ratios', () => {
    const s = deriveSavings([m(10, 15), m(10_000, 9_000)]);

    const meanOfRatios = (15 / 10 + 9_000 / 10_000) / 2;
    expect(meanOfRatios).toBeGreaterThan(1 + SAVINGS_NEUTRAL_BAND); // the wrong method says "inflates"

    expect(s.verdict).toBe('reduces'); // the right method says "reduces"
    expect(s.deltaBytes).toBe(-995);
    expect(s.ratio).toBeCloseTo(9_015 / 10_010, 5);
  });

  it('handles a zero-byte bash side without dividing by it', () => {
    expect(deriveSavings([m(0, 0)]).verdict).toBe('neutral');
    expect(deriveSavings([m(0, 0)]).ratio).toBeNull();

    const inflated = deriveSavings([m(0, 250)]);
    expect(inflated.verdict).toBe('inflates');
    expect(inflated.ratio).toBeNull();
    expect(inflated.reason).toContain('bash returned no output');
  });
});

describe('the read family, MEASURED against the real handler rather than asserted', () => {
  // The plan's 3.4x figure for capability:read came from an aggregate over
  // telemetry. This derives the same conclusion from an independent direction —
  // replaying real commands through the real handler — which is what makes it
  // evidence rather than a restatement.
  const REPRESENTATIVE: Array<[SubstitutionPair, string]> = [
    [sedRangeRead, "sed -n '1,5p' /var/log/a.log"],
    [headFileRead, 'head -n 5 /var/log/a.log'],
    [tailFileRead, 'tail -n 5 /var/log/a.log'],
    [catFileRead, 'cat /var/log/a.log'],
  ];

  it('measures a real economy for every pair that declares a rewrite', async () => {
    const measured: string[] = [];

    for (const [pair, atom] of REPRESENTATIVE) {
      const result = await replayPair(pair, sample([atom]), realExecutors(), options());
      const s = result.savings;

      measured.push(
        `${pair.id}: ${result.verdict} / ${s.verdict} — bash ${s.bashBytes}B vs tool ${s.rewrittenBytes}B` +
          `${s.ratio === null ? '' : ` (${Math.round(s.ratio * 100)}%)`}`,
      );

      // A pair that replays clean must carry a real measurement; an unmeasured
      // economy on a clean pair would mean the axis silently did nothing.
      if (result.verdict === 'replay-clean') {
        expect(s.measuredCases, pair.id).toBeGreaterThan(0);
        expect(s.verdict, pair.id).not.toBe('unmeasured');

        // THE FINDING, PINNED (D-058). Every read-family pair returns the right
        // answer and costs MORE to do it — which is why none of them was ever a
        // viable auto-substitution candidate, mechanism aside.
        //
        // Direction, not magnitude: the measured ratio here (1.9x-4.2x) is
        // fixture-dependent, because the tool's per-line numbering and header are
        // overhead that a small answer cannot amortize. The DIRECTION is the
        // durable fact, and it agrees with the plan's independent 3.4x aggregate
        // from telemetry.
        //
        // If this assertion ever fails, the economics have CHANGED — most likely
        // because the P-020 projection stage reached capability:read — and that is
        // a signal to re-open the substitution question for this family, not a
        // test to relax.
        expect(s.verdict, `${pair.id} — read-family economy (see D-058)`).toBe('inflates');
      }
    }

    // eslint-disable-next-line no-console -- the measurement IS the deliverable
    console.log(`\n  measured economy of the read family:\n    ${measured.join('\n    ')}\n`);
  });
});

describe('mutation — a savings verdict that cannot fail is not a measurement', () => {
  // Same discipline as the rewrite mutations above: these assert that the
  // function DISCRIMINATES. A `deriveSavings` hardcoded to any single verdict
  // passes a surprising number of ordinary assertions, so the suite must pin
  // every outcome as reachable from real input.
  const m = (bashBytes: number, toolBytes: number): ReplayCase => ({
    sourceAtom: 'a',
    replayedAtom: 'a',
    verdict: 'match',
    bashBytes,
    toolBytes,
  });

  it('produces all four verdicts from otherwise-identical inputs', () => {
    const verdicts = [
      deriveSavings([m(1000, 100)]).verdict,
      deriveSavings([m(1000, 1000)]).verdict,
      deriveSavings([m(1000, 9000)]).verdict,
      deriveSavings([]).verdict,
    ];
    expect(verdicts).toEqual(['reduces', 'neutral', 'inflates', 'unmeasured']);
    expect(new Set(verdicts).size).toBe(4);
  });

  it('moves the verdict when only the byte counts change', () => {
    const before = deriveSavings([m(1000, 2000)]);
    const after = deriveSavings([m(1000, 500)]);
    expect(before.verdict).not.toBe(after.verdict);
    expect(Math.sign(before.deltaBytes)).toBe(1);
    expect(Math.sign(after.deltaBytes)).toBe(-1);
  });
});
