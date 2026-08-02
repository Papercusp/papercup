/**
 * no-proc-path-fixture-guard.test.ts — the detection predicate for the made-up
 * `/proc/...` path ban (EI-19369372064589484).
 *
 * The guard (`scripts/check-no-proc-path-fixture.mjs`) runs green on the clean tree,
 * which only proves the no-false-POSITIVE direction. The property that actually
 * matters is the other one — that a NEW `/proc/` fixture FAILS the build — and that
 * direction is invisible to a green run by construction: on a clean tree there is,
 * by definition, no violation to catch. A guard whose gating property is only ever
 * exercised by the violation that has not happened yet is indistinguishable from a
 * guard that does nothing. So it is locked here instead.
 *
 * Same posture as `no-raw-setinterval-guard.test.ts` (P-007) and
 * `no-bespoke-state-read-guard.test.ts`, for the same reason.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { findProcFixtureOffenders, classifyProcSegment, stripComments, KNOWN_PROCFS_ENTRIES, ALLOWLIST, findOffenders } from '../../../scripts/check-no-proc-path-fixture.mjs';

import { UNWRITABLE_PATH_FIXTURE, UNWRITABLE_PATH_ROOT, unwritablePath } from './testing/unwritable-path';

describe('no-proc-path-fixture guard: it CATCHES the trap', () => {
  it('FLAGS the exact literal that wedged the run on 2026-08-02', () => {
    const src = `const p = '/proc/definitely/not/writable/reds.jsonl';`;
    const hits = findProcFixtureOffenders(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].segment).toBe('definitely');
  });

  it('FLAGS the literal that wedged every gate for hours on 2026-07-11', () => {
    expect(findProcFixtureOffenders(`{ DIR: '/proc/nonexistent/slots' }`)).toHaveLength(1);
  });

  it('FLAGS it under every quoting style, including a template literal', () => {
    expect(findProcFixtureOffenders(`x = "/proc/bogus/x"`)).toHaveLength(1);
    expect(findProcFixtureOffenders("x = '/proc/bogus/x'")).toHaveLength(1);
    expect(findProcFixtureOffenders('x = `/proc/bogus/x`')).toHaveLength(1);
  });

  it('FLAGS a bare made-up entry with no second segment', () => {
    expect(findProcFixtureOffenders(`readFileSync('/proc/madeup')`)).toHaveLength(1);
  });

  it('reports EVERY offender in a file, not just the first', () => {
    const src = `a='/proc/aaa/x'; b='/proc/bbb/y';`;
    expect(findProcFixtureOffenders(src).map((h: { segment: string }) => h.segment)).toEqual(['aaa', 'bbb']);
  });
});

describe('no-proc-path-fixture guard: it does NOT flag legitimate procfs reads', () => {
  it('allows an interpolated pid — the overwhelmingly common real use', () => {
    expect(findProcFixtureOffenders('readFileSync(`/proc/${pid}/cmdline`)')).toEqual([]);
    expect(findProcFixtureOffenders('`/proc/${p.pid}/cwd`')).toEqual([]);
    expect(findProcFixtureOffenders('"/proc/$pid/cgroup"')).toEqual([]);
  });

  it('allows a literal pid', () => {
    expect(findProcFixtureOffenders(`files['/proc/999/cgroup'] = x`)).toEqual([]);
  });

  it('allows the well-known procfs entries this repo actually reads', () => {
    for (const entry of ['self', 'version', 'sys', 'net', 'pressure', 'loadavg', 'vmstat', 'uptime']) {
      expect(findProcFixtureOffenders(`'/proc/${entry}/x'`)).toEqual([]);
    }
  });

  it('allows a MID-PATH /proc/ — a "no such root" argument is not a procfs path', () => {
    // Regression: '/no/such/proc/root' is a legitimate fixture in proc-guard.test.ts.
    // The predicate is anchored on the opening quote precisely so this stays clean.
    expect(findProcFixtureOffenders(`matchExternalProcesses('x', { procRoot: '/no/such/proc/root' })`)).toEqual([]);
  });

  it('allows a COMMENT warning about the trap — teaching must not red the build', () => {
    // psu-launcher.test.ts carries exactly such a warning inline.
    expect(findProcFixtureOffenders(`// NEVER '/proc/whatever' here: it hangs forever\nconst x = 1;`)).toEqual([]);
    expect(findProcFixtureOffenders(`/* see '/proc/definitely/not/writable' */\nconst x = 1;`)).toEqual([]);
  });

  it('allows a bare /proc/ prefix that is concatenated at runtime', () => {
    expect(findProcFixtureOffenders(`const base = '/proc/' + pid;`)).toEqual([]);
  });
});

describe('no-proc-path-fixture guard: predicate internals', () => {
  it('classifies segments by whether they CAN exist', () => {
    expect(classifyProcSegment('definitely')).toBe('made-up');
    expect(classifyProcSegment('nonexistent')).toBe('made-up');
    expect(classifyProcSegment('self')).toBe('ok');
    expect(classifyProcSegment('1234')).toBe('ok');
    expect(classifyProcSegment('${pid}')).toBe('ok');
    expect(classifyProcSegment('')).toBe('ok');
  });

  it('stripComments leaves a scheme-relative URL intact', () => {
    // Guards the one risky case in the comment stripper: '//' inside 'https://'.
    expect(stripComments(`const u = 'https://example.com/x';`)).toContain('example.com');
  });

  it('allowlists ONLY this guard and its own test', () => {
    // A growing allowlist is how a ban quietly dies; assert its exact membership.
    expect([...ALLOWLIST].sort()).toEqual([
      'packages/operator-core/lib/no-proc-path-fixture-guard.test.ts',
      'scripts/check-no-proc-path-fixture.mjs',
    ]);
  });

  it('KNOWN_PROCFS_ENTRIES covers every entry the tree reads today', () => {
    for (const e of ['self', 'version', 'sys', 'net', 'pressure', 'loadavg', 'vmstat', 'uptime', 'cmdline']) {
      expect(KNOWN_PROCFS_ENTRIES.has(e)).toBe(true);
    }
  });
});

describe('no-proc-path-fixture guard: the tree stays clean', () => {
  // The predicate tests above prove the guard CAN catch the trap; this proves it
  // IS catching it, on the real tree, in the routine local loop. Without this, a
  // new offender only reds in CI — and this bug's whole signature is that it wedges
  // a vitest run into a silent, output-free hang that reads as queue contention.
  // Catching it in test:affected is the difference between a 15ms red and an hour
  // of someone misdiagnosing a stalled gate. Same posture as the design-primitives
  // lint, which likewise scans the tree from a vitest test.
  it('has NO made-up /proc/… literal anywhere in tracked source', () => {
    const { offenders } = findOffenders() as { offenders: Array<{ file: string; literal: string }> };
    const rendered = offenders.map((o) => `${o.file} → ${o.literal}`);
    expect(
      rendered,
      "A made-up '/proc/…' path hangs Node's recursive mkdir FOREVER (see testing/unwritable-path.ts). " +
        "Use UNWRITABLE_PATH_FIXTURE / unwritablePath() from '@papercusp/operator-core/lib/testing/unwritable-path' instead.",
    ).toEqual([]);
  });
});

describe('the replacement fixture actually fails fast', () => {
  it('is rooted at a path component that exists but is NOT a directory', () => {
    expect(UNWRITABLE_PATH_ROOT).toBe('/dev/null');
    expect(UNWRITABLE_PATH_FIXTURE.startsWith('/dev/null/')).toBe(true);
  });

  it('throws ENOTDIR — synchronously, not a hang — under recursive mkdir', async () => {
    const { mkdirSync } = await import('node:fs');
    // The whole point: this is the assertion that would NEVER COMPLETE under a
    // '/proc/…' path. If this suite ever hangs here, the fixture root regressed.
    expect(() => mkdirSync(unwritablePath('a', 'b'), { recursive: true })).toThrow(/ENOTDIR/);
  });

  it('throws ENOTDIR for a file write beneath it too', async () => {
    const { writeFileSync } = await import('node:fs');
    expect(() => writeFileSync(unwritablePath('reds.jsonl'), 'x')).toThrow(/ENOTDIR/);
  });

  it('unwritablePath composes segments and tolerates stray slashes', () => {
    expect(unwritablePath('reds.jsonl')).toBe(`${UNWRITABLE_PATH_FIXTURE}/reds.jsonl`);
    expect(unwritablePath('slots', 'heavy')).toBe(`${UNWRITABLE_PATH_FIXTURE}/slots/heavy`);
    expect(unwritablePath('/slots/')).toBe(`${UNWRITABLE_PATH_FIXTURE}/slots`);
    expect(unwritablePath()).toBe(UNWRITABLE_PATH_FIXTURE);
  });
});
