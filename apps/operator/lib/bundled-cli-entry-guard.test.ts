import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS build guard, imported for its scanner predicate.
import { findBundledCliEntryGuards } from '../../../scripts/check-bundled-cli-entry-guards.mjs';

describe('check-bundled-cli-entry-guards', () => {
  it('rejects a raw guard in an esbuild input and ignores non-repo inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundled-cli-entry-guard-'));
    try {
      const apps = join(root, 'apps', 'operator');
      const scripts = join(root, 'scripts');
      const bad = join(scripts, 'bad.mjs');
      const good = join(scripts, 'good.mjs');
      const outside = join(root, 'node_modules', 'foreign.mjs');
      // The helper resolves input keys relative to apps/operator, mirroring bundle-host.sh.
      writeFileSync(bad, 'if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(1);\n');
      writeFileSync(good, 'if (isCliEntry(import.meta.url)) main();\n');
      writeFileSync(outside, 'if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(1);\n');
      const metafile = join(root, 'bundle.meta.json');
      writeFileSync(metafile, JSON.stringify({ inputs: { '../../scripts/bad.mjs': {}, '../../scripts/good.mjs': {}, '../../node_modules/foreign.mjs': {} } }));

      const findings = findBundledCliEntryGuards({ metafilePath: metafile, baseDir: apps });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ file: 'scripts/bad.mjs', kind: 'path-to-file-url', line: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

