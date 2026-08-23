import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS build guard, imported for its scanner predicate.
import { findBundledCliEntryGuards } from '../../../scripts/check-bundled-cli-entry-guards.mjs';

describe('check-bundled-cli-entry-guards', () => {
  it('rejects a raw guard in an esbuild input and ignores non-repo inputs', () => {
    // The production scanner deliberately ignores files outside the repository.
    // Keep the synthetic repo-owned inputs under an allowed source root while
    // retaining a real system-temp file to exercise that boundary.
    const repoRoot = resolve(process.cwd(), '../..');
    const root = mkdtempSync(join(repoRoot, 'apps', '.bundled-cli-entry-guard-'));
    try {
      const apps = join(root, 'operator');
      const scripts = join(root, 'scripts');
      const bad = join(scripts, 'bad.mjs');
      const good = join(scripts, 'good.mjs');
      const outsideRoot = mkdtempSync(join(tmpdir(), 'bundled-cli-entry-guard-outside-'));
      const outside = join(outsideRoot, 'foreign.mjs');
      mkdirSync(scripts, { recursive: true });
      // The helper resolves input keys relative to apps/operator, mirroring bundle-host.sh.
      writeFileSync(bad, 'if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(1);\n');
      writeFileSync(good, 'if (isCliEntry(import.meta.url)) main();\n');
      writeFileSync(outside, 'if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(1);\n');
      const metafile = join(root, 'bundle.meta.json');
      writeFileSync(
        metafile,
        JSON.stringify({
          inputs: {
            [relative(apps, bad)]: {},
            [relative(apps, good)]: {},
            [outside]: {},
          },
        }),
      );

      const findings = findBundledCliEntryGuards({ metafilePath: metafile, baseDir: apps });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        file: relative(repoRoot, bad).replaceAll('\\', '/'),
        kind: 'path-to-file-url',
        line: 1,
      });
      rmSync(outsideRoot, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
