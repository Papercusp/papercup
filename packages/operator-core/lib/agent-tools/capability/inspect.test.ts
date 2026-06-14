/**
 * Unit tests for capability:inspect's command resolution (EI-524 / P-035).
 * The exec itself reuses the bash-jobs runner (tested in bash-jobs.test.ts); the
 * security-load-bearing part is the PURE command construction + path validation,
 * which is what these cover — proving the agent can never inject a shell command.
 */
import { describe, expect, it } from 'vitest';
import { resolveInspectCommand } from './inspect';

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
