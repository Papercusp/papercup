import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findUnresolvedMocks, resolveMockSpecifier } from './check-vitest-mock-paths.mjs';

const ROOT = process.cwd();

describe('check-vitest-mock-paths', () => {
  it('resolves a current internal workspace module and rejects a renamed path', () => {
    const testFile = `${ROOT}/apps/operator/test/dbos-sweep-glue.integration.test.ts`;
    expect(resolveMockSpecifier('@papercusp/operator-core/lib/pot/started', testFile, ROOT).resolved)
      .toMatch(/packages\/operator-core\/lib\/pot\/started\.ts$/);
    expect(resolveMockSpecifier('@papercusp/operator-core/lib/hive/started', testFile, ROOT).resolved)
      .toBeNull();
  });

  it('reports only checkable orphaned mocks and ignores optional third-party mocks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vitest-mock-paths-'));
    const fixture = join(directory, 'fixture.test.ts');
    await writeFile(
      fixture,
      [
        "vi.mock('@papercusp/operator-core/lib/hive/started', () => ({}));",
        "vi.mock('@bytecodealliance/jco', () => ({}));",
      ].join('\n'),
    );
    try {
      const result = findUnresolvedMocks({
        root: ROOT,
        files: [fixture],
      });
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]).toMatchObject({
        line: 1,
        specifier: '@papercusp/operator-core/lib/hive/started',
      });
      expect(result.unresolved[0].file).toMatch(/fixture\.test\.ts$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
