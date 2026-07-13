import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
// The production entrypoint deliberately stays executable by plain Node.
// @ts-expect-error — the .mjs CLI has no declaration file.
import { discoverVitestRoute, groupRoutes, listedFiles, REPO_ROOT } from '../../../../scripts/test-files.mjs';

describe('test-files router', () => {
  it('discovers the package cwd/config and rewrites the file relative to that cwd', () => {
    const route = discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts');
    expect(route.cwd).toBe(resolve(REPO_ROOT, 'libs/generic/tooldef'));
    expect(route.config).toBe('vitest.config.ts');
    expect(route.requested).toBe('src/strict-args.test.ts');
  });

  it('groups only files sharing one cwd and config', () => {
    const routes = [
      discoverVitestRoute('libs/generic/tooldef/src/strict-args.test.ts'),
      discoverVitestRoute('packages/operator-core/lib/search/self-session.test.ts'),
    ];
    expect(groupRoutes(routes)).toHaveLength(2);
  });

  it('extracts the distinct files Vitest says it will execute and ignores process warnings', () => {
    const cwd = resolve(REPO_ROOT, 'libs/generic/tooldef');
    expect(listedFiles('(node:1) Warning: irrelevant\nsrc/a.test.ts > suite > one\nsrc/a.test.ts > suite > two\nsrc/b.test.ts > suite', cwd)).toEqual([
      resolve(cwd, 'src/a.test.ts'),
      resolve(cwd, 'src/b.test.ts'),
    ]);
  });

  it('rejects a missing request before running Vitest', () => {
    expect(() => discoverVitestRoute('libs/generic/tooldef/src/no-such.test.ts')).toThrow(/does not exist/);
  });
});
