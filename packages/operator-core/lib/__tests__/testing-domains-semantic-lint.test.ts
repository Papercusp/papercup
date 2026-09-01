/**
 * EI-211141 — declaration-side semantic attestation controls.
 *
 * These tests exercise the exported pure-ish checker with synthetic contracts
 * and file inventories.  They are deliberately falsifier-shaped: removing a
 * finding class, weakening glob matching, or accepting an unknown admin suite
 * makes one of the negative controls fail.
 */
import { describe, expect, it } from 'vitest';
import { attestDeclarations, type ContractDomain } from '../../../../apps/operator/scripts/lint-tests';

const repoRoot = '/synthetic-repo';
const files = [
  'packages/operator-core/lib/example.test.ts',
  'packages/operator-core/lib/runner.mjs',
  'packages/operator-core/package.json',
];

function findings(domains: ContractDomain[], existing: string[] = files) {
  const seen: string[] = [];
  const result = attestDeclarations(
    { domains },
    repoRoot,
    existing,
    (path) => {
      seen.push(path);
      return path === `${repoRoot}/packages/operator-core/lib/runner.mjs` ||
        path === `${repoRoot}/packages/operator-core/package.json`;
    },
  );
  return { result, seen };
}

describe('attestDeclarations (EI-211141)', () => {
  it('accepts a live glob and an existing explicit runner target', async () => {
    const { result } = findings([
      {
        id: 'runtime',
        sections: [{
          id: 'tests',
          globs: ['packages/operator-core/lib/**/*.test.ts'],
          runners: [{ kind: 'node', filePath: 'packages/operator-core/lib/runner.mjs' }],
        }],
      },
    ]);

    await expect(result).resolves.toEqual([]);
  });

  it('falsifies stale globs and empty sections when declarations match no tests', async () => {
    const { result } = findings([
      {
        id: 'runtime',
        sections: [{ id: 'removed', globs: ['packages/removed/**/*.test.ts'] }],
      },
    ], files);

    await expect(result).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'stale-glob',
        domain: 'runtime',
        section: 'removed',
        value: 'packages/removed/**/*.test.ts',
      }),
      expect.objectContaining({ kind: 'empty-section', domain: 'runtime', section: 'removed' }),
    ]));
  });

  it('falsifies a runner that points at a missing file or manifest', async () => {
    const { result, seen } = findings([
      {
        id: 'runtime',
        sections: [{
          id: 'runner',
          runners: [{
            kind: 'node',
            filePath: 'packages/operator-core/lib/missing.mjs',
            manifestPath: 'packages/operator-core/missing-package.json',
          }],
        }],
      },
    ]);

    await expect(result).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing-runner-target', value: 'packages/operator-core/lib/missing.mjs' }),
      expect.objectContaining({ kind: 'missing-runner-target', value: 'packages/operator-core/missing-package.json' }),
    ]));
    await expect(result).resolves.toHaveLength(2);
    expect(seen).toEqual(expect.arrayContaining([
      `${repoRoot}/packages/operator-core/lib/missing.mjs`,
      `${repoRoot}/packages/operator-core/missing-package.json`,
    ]));
  });

  it('falsifies repository file arguments while ignoring command flags and package names', async () => {
    const { result } = findings([
      {
        id: 'runtime',
        sections: [{
          id: 'runner',
          runners: [{ kind: 'node', args: ['--prefix', 'packages/operator-core', 'scripts/missing.ts'] }],
        }],
      },
    ]);

    await expect(result).resolves.toEqual([
      expect.objectContaining({ kind: 'missing-runner-target', value: 'scripts/missing.ts' }),
    ]);
  });

  it('falsifies unknown and missing admin suite ids', async () => {
    const { result } = findings([
      {
        id: 'admin',
        sections: [{
          id: 'suites',
          runners: [
            { kind: 'admin-suite', suiteId: 'not-registered' },
            { kind: 'admin-suite' },
          ],
        }],
      },
    ]);

    await expect(result).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'unknown-admin-suite', value: 'not-registered' }),
      expect.objectContaining({ kind: 'unknown-admin-suite', value: '<missing>' }),
    ]));
    await expect(result).resolves.toHaveLength(2);
  });

  it('matches recursive globs without treating a sibling prefix as live', async () => {
    const { result } = findings([
      {
        id: 'runtime',
        sections: [{
          id: 'tests',
          globs: ['packages/operator-core/lib/**/*.test.ts'],
        }],
      },
    ], ['packages/operator-core/lib-extra/nope.test.ts']);

    await expect(result).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'stale-glob', value: 'packages/operator-core/lib/**/*.test.ts' }),
      expect.objectContaining({ kind: 'empty-section', section: 'tests' }),
    ]));
  });
});
