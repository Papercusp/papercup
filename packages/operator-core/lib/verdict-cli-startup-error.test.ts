/**
 * EI-20110538428919633 regression guard — verdict-cli must preserve a daemon's
 * actionable stderr when startup times out instead of reporting only a generic
 * 15-second deadline. The dependency is patched through patch-package, so this
 * test launches the installed CLI and replaces only the spawned `node` command
 * with a deterministic failing daemon fixture.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

describe('verdict-cli startup diagnostics (EI-20110538428919633)', () => {
  it('includes a failed daemon stderr tail in the startup error', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'verdict-cli-startup-error-'));
    const fakeNode = join(fixtureRoot, 'node');
    const dataDir = join(fixtureRoot, 'data');
    const sentinel = "browserType.launch: Executable doesn't exist at /tmp/chromium";

    try {
      await writeFile(
        fakeNode,
        `#!/usr/bin/env bash
printf '%s\\n' '${sentinel}' 'Please run: npx playwright install' >&2
exit 1
`,
        'utf8',
      );
      await chmod(fakeNode, 0o755);

      let failure: unknown = null;
      try {
        await execFileAsync(
          process.execPath,
          [require.resolve('verdict-cli/bin/browse.mjs'), 'status'],
          {
            env: {
              ...process.env,
              PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ''}`,
              VERDICT_DATA_DIR: dataDir,
            },
            maxBuffer: 32 * 1024,
            timeout: 20_000,
          },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).not.toBeNull();
      const stderr =
        typeof failure === 'object' && failure !== null && 'stderr' in failure
          ? String((failure as { stderr?: unknown }).stderr ?? '')
          : '';
      expect(stderr).toContain('Server failed to start within 15 seconds');
      expect(stderr).toContain('--- server stderr ---');
      expect(stderr).toContain(sentinel);
      expect(stderr).toContain('npx playwright install');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
