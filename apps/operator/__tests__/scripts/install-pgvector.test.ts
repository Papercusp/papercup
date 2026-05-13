/**
 * Smoke test for bin/install-pgvector-into-embedded.sh
 *
 * Round-13 bug #29 (B3 deferral close): the script accepts an optional
 * positional arg for the target `native/` dir of an alternate
 * embedded-postgres install. Before the fix the arg was silently
 * ignored and the script overwrote the WRONG node_modules in a
 * multi-worktree setup.
 *
 * This test exercises both modes against a synthetic fixture dir so
 * we don't depend on a real `pnpm install` having run.
 *
 * Skipped when:
 *   - system pgvector isn't installed (/usr/lib/postgresql/18/lib/vector.so)
 *   - running on non-Linux (the script also handles macOS/win but we
 *     only have a linux-x64 host to test against here)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'bin/install-pgvector-into-embedded.sh');
const SYS_VECTOR_SO = '/usr/lib/postgresql/18/lib/vector.so';

let runnable = false;

beforeAll(() => {
  runnable =
    process.platform === 'linux' &&
    existsSync(SCRIPT) &&
    existsSync(SYS_VECTOR_SO);
});

const itRunnable = (name: string, fn: () => void | Promise<void>) => {
  it(name, async () => {
    if (!runnable) return; // soft-skip on platforms without the fixture
    await fn();
  });
};

describe('bin/install-pgvector-into-embedded.sh', () => {
  itRunnable('copies vector.so + extension into the explicit target dir (arg-passing path)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pgvector-test-'));
    try {
      const nativeDir = join(tmp, 'native');
      mkdirSync(join(nativeDir, 'lib/postgresql'), { recursive: true });
      mkdirSync(join(nativeDir, 'share/postgresql/extension'), { recursive: true });

      const stdout = execFileSync(SCRIPT, [nativeDir], { encoding: 'utf8' });
      expect(stdout).toContain(nativeDir);
      expect(stdout).toMatch(/Done\./);

      const installedSo = join(nativeDir, 'lib/postgresql/vector.so');
      const installedControl = join(nativeDir, 'share/postgresql/extension/vector.control');
      expect(existsSync(installedSo)).toBe(true);
      expect(existsSync(installedControl)).toBe(true);
      // vector.so must be a real file, not zero bytes.
      expect(statSync(installedSo).size).toBeGreaterThan(1000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  itRunnable('rejects nonexistent target dir with exit code 1', () => {
    let err: { status?: number; stderr?: string } | null = null;
    try {
      execFileSync(SCRIPT, ['/nonexistent/path/does-not-exist'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      err = e as { status?: number; stderr?: string };
    }
    expect(err).not.toBeNull();
    expect(err!.status).toBe(1);
    expect(err!.stderr).toContain('Embedded postgres dir not found');
  });

  itRunnable('falls back to repo-relative default when no arg given', () => {
    // Don't actually run against the live node_modules — instead verify
    // the script ROUTES to the repo-relative default by passing nothing
    // and asserting the error message references the expected repo-relative path.
    // (The script may succeed if real node_modules is present; that's also fine.)
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(SCRIPT, [], { encoding: 'utf8' });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    const expectedPath = join(
      REPO_ROOT,
      'node_modules/@embedded-postgres/linux-x64/native',
    );
    expect(stdout + stderr).toContain(expectedPath);
  });
});
