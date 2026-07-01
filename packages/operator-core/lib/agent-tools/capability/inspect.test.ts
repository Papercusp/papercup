/**
 * Unit tests for capability:inspect's command resolution (EI-524 / P-035).
 * The exec itself reuses the bash-jobs runner (tested in bash-jobs.test.ts); the
 * security-load-bearing part is the PURE command construction + path validation,
 * which is what these cover — proving the agent can never inject a shell command.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveInspectCommand,
  filterTscOutputToPaths,
  clampForegroundTimeoutMs,
  foregroundTimeoutHint,
  FOREGROUND_TIMEOUT_CEILING_MS,
  MCP_TRANSPORT_CAP_MS,
} from './inspect';

const BASE = '/repo';

describe('resolveInspectCommand — verb mapping', () => {
  it('typecheck requires a package', () => {
    const r = resolveInspectCommand({ check: 'typecheck' }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_args');
  });

  it('typecheck with a package → `npx tsc --noEmit` in the package dir', () => {
    expect(resolveInspectCommand({ check: 'typecheck', package: 'packages/operator-core' }, BASE)).toEqual({
      ok: true,
      command: 'npx tsc --noEmit',
      cwd: '/repo/packages/operator-core',
    });
  });

  it('test with no package → repo `npm run test:affected` at the root', () => {
    expect(resolveInspectCommand({ check: 'test' }, BASE)).toEqual({
      ok: true,
      command: 'npm run test:affected',
      cwd: BASE,
    });
  });

  it('test with a package → `npx vitest run` in the package', () => {
    expect(resolveInspectCommand({ check: 'test', package: 'libs/flags' }, BASE)).toEqual({
      ok: true,
      command: 'npx vitest run',
      cwd: '/repo/libs/flags',
    });
  });

  it('test with a package + path → narrows the vitest run to the file', () => {
    expect(resolveInspectCommand({ check: 'test', package: 'libs/flags', path: 'src/x.test.ts' }, BASE)).toEqual({
      ok: true,
      command: 'npx vitest run src/x.test.ts',
      cwd: '/repo/libs/flags',
    });
  });

  it('path requires a package', () => {
    const r = resolveInspectCommand({ check: 'test', path: 'x.test.ts' }, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_args');
  });

  it('path is rejected for typecheck', () => {
    expect(resolveInspectCommand({ check: 'typecheck', package: 'p', path: 'x' }, BASE).ok).toBe(false);
  });
});

describe('resolveInspectCommand — security (no shell injection / traversal)', () => {
  it('rejects shell metacharacters in package', () => {
    for (const bad of ['p; rm -rf /', 'p && curl evil', 'p`whoami`', 'p|tee', 'p$(x)', 'p x', 'p>out', 'p*']) {
      expect(resolveInspectCommand({ check: 'test', package: bad }, BASE).ok, `package "${bad}" must be rejected`).toBe(false);
    }
  });

  it('rejects shell metacharacters in path', () => {
    for (const bad of ['a.test.ts; rm -rf /', 'a && x', 'a|b', 'a $(b)']) {
      expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: bad }, BASE).ok, `path "${bad}" must be rejected`).toBe(false);
    }
  });

  it('rejects parent-dir traversal in package and path', () => {
    expect(resolveInspectCommand({ check: 'test', package: '../etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'a/../../etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: '../../../etc/passwd' }, BASE).ok).toBe(false);
  });

  it('rejects an absolute package or path', () => {
    expect(resolveInspectCommand({ check: 'test', package: '/etc' }, BASE).ok).toBe(false);
    expect(resolveInspectCommand({ check: 'test', package: 'pkg', path: '/etc/passwd' }, BASE).ok).toBe(false);
  });
});

describe('filterTscOutputToPaths — "did MY change add a NEW error" (WI-1255)', () => {
  const OUT = [
    "lib/agent-tools/docs/author.ts(46,26): error TS2307: Cannot find module 'x'.",
    "../plugin-loader/src/wasm/jco-transpiler.ts(46,26): error TS2307: Cannot find module '@bytecodealliance/jco'.",
    "lib/other/foo.ts(1,1): error TS1005: ';' expected.",
    'Found 3 errors in 3 files.',
  ].join('\n');

  it('counts all errors but matches only the requested file', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/agent-tools/docs/author.ts']);
    expect(r.totalErrors).toBe(3);
    expect(r.matchedErrors).toBe(1);
    expect(r.matchedLines[0]).toContain('author.ts');
  });

  it('matches loosely (a basename fragment finds the file)', () => {
    expect(filterTscOutputToPaths(OUT, ['author.ts']).matchedErrors).toBe(1);
  });

  it('a directory fragment matches every file under it (and excludes others)', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/']);
    expect(r.matchedErrors).toBe(2); // author.ts + other/foo.ts, NOT the ../plugin-loader one
  });

  it('an unmatched path → 0 matched, full total (the clean signal)', () => {
    const r = filterTscOutputToPaths(OUT, ['lib/nope/missing.ts']);
    expect(r.matchedErrors).toBe(0);
    expect(r.totalErrors).toBe(3);
  });

  it('ignores non-error lines (summary, blank)', () => {
    expect(filterTscOutputToPaths('Found 3 errors in 3 files.\n\n', ['x']).totalErrors).toBe(0);
  });

  it('empty output → zeros', () => {
    expect(filterTscOutputToPaths('', ['x'])).toEqual({ matchedErrors: 0, totalErrors: 0, matchedLines: [] });
  });
});

// EI-6073: a FOREGROUND typecheck/test on a large package (operator-core's tsc ~60-90s) was
// hard-killed by the ~55s MCP transport cap with an opaque request_timeout — the handler never
// got to hint "use run_in_background". These pin the clamp (self-time-out below the cap) + the hint.
describe('clampForegroundTimeoutMs — keep a foreground run under the MCP transport cap (EI-6073)', () => {
  it('caps the ceiling below the transport cap (with serialize headroom)', () => {
    expect(FOREGROUND_TIMEOUT_CEILING_MS).toBeLessThan(MCP_TRANSPORT_CAP_MS);
  });

  it('clamps a request ABOVE the ceiling down to it (the operator-core 120s default case)', () => {
    expect(clampForegroundTimeoutMs(120_000)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
    expect(clampForegroundTimeoutMs(600_000)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
  });

  it('leaves a request BELOW the ceiling untouched (a fast package is unaffected)', () => {
    expect(clampForegroundTimeoutMs(5_000)).toBe(5_000);
    expect(clampForegroundTimeoutMs(FOREGROUND_TIMEOUT_CEILING_MS)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
  });
});

describe('foregroundTimeoutHint — actionable hint on a clamped timeout (EI-6073)', () => {
  it('on a timed_out status → points to run_in_background + bash_output', () => {
    const h = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS);
    expect(h).toMatch(/run_in_background/);
    expect(h).toMatch(/capability:bash_output/);
    expect(h).toContain('50s'); // the clamped ceiling, human-readable
  });

  it('is EMPTY for any non-timeout status (completed / failed) — no false hint', () => {
    expect(foregroundTimeoutHint('completed', FOREGROUND_TIMEOUT_CEILING_MS)).toBe('');
    expect(foregroundTimeoutHint('failed', FOREGROUND_TIMEOUT_CEILING_MS)).toBe('');
    expect(foregroundTimeoutHint('killed', FOREGROUND_TIMEOUT_CEILING_MS)).toBe('');
  });
});
