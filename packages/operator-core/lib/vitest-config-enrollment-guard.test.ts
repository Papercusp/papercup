import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchForWorkspaceRoot } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  collectVitestConfigs,
  findNestedRootConfigsWithoutServerFragment,
  findStaleExemptions,
  findUnenrolledConfigs,
  isGateEnrolled,
  PLAIN_CONFIG_EXEMPTIONS,
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- guard script is plain .mjs and intentionally has no declaration file.
} from '../../../scripts/check-vitest-config-enrollment.mjs';

describe('Vitest config enrollment guard', () => {
  it('recognizes the shared base and the gate-participation fragment', () => {
    expect(
      isGateEnrolled(
        `import { defineVitestConfig } from '@papercusp/test-config/vitest-config';\nexport default defineVitestConfig({ layer: 'unit' });`,
      ),
    ).toBe(true);
    expect(
      isGateEnrolled(
        [
          "import { defineConfig } from 'vitest/config';",
          "import { gateParticipationConfig, sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';",
          'export default defineConfig({ test: { ...sharedHostWorkerCap(), ...gateParticipationConfig() } });',
        ].join('\n'),
      ),
    ).toBe(true);
  });

  // WI-10003716: twelve configs passed the old guard this way while recording zero pass proofs.
  it('does NOT accept a hand-wired admin reporter as gate participation', () => {
    expect(
      isGateEnrolled(
        `import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config/vitest-config';\nexport default { test: { reporters: [ADMIN_TEST_RUNS_REPORTER_PATH] } };`,
      ),
    ).toBe(false);
  });

  it('requires the fragment to be called, not merely imported', () => {
    expect(
      isGateEnrolled(
        `import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';\nexport default { test: {} };`,
      ),
    ).toBe(false);
  });

  it('ignores comments and flags a plain config outside the exact exemption set', () => {
    expect(
      findUnenrolledConfigs([
        {
          path: 'libs/generic/new-package/vitest.config.ts',
          content: '// defineVitestConfig is intentionally not called here\nexport default {};',
        },
        {
          path: 'libs/generic/card-stack/vitest.config.ts',
          content: 'export default {};',
        },
      ]),
    ).toEqual(['libs/generic/new-package/vitest.config.ts']);
    expect(PLAIN_CONFIG_EXEMPTIONS.has('libs/generic/new-package/vitest.config.ts')).toBe(false);
  });

  it('does not treat reporter tokens quoted in config data as live enrollment code', () => {
    expect(
      isGateEnrolled(
        [
          "import { defineVitestConfig } from '@papercusp/test-config/vitest-config';",
          "const explanation = 'defineVitestConfig(';",
          "const reporterName = 'ADMIN_TEST_RUNS_REPORTER_PATH';",
          'export default {};',
        ].join('\n'),
        'vitest.config.ts',
      ),
    ).toBe(false);
  });

  it('keeps every declared workspace config enrolled at repository HEAD', () => {
    const findings = findUnenrolledConfigs(collectVitestConfigs());
    expect(findings, findings.join('\n')).toEqual([]);
  });
});

// WI-10003808: the exemption set may only shrink, and a hand-rolled enrolled config under a nested
// Vite workspace root needs the server fragment or its jsdom files cannot load the gate's setup file.
describe('Vitest config enrollment guard: stale exemptions and nested workspace roots', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const viteRootOf = (dir: string): string => searchForWorkspaceRoot(dir);
  const BLOOM_GRID = 'libs/generic/papergrid/bloom-grid/vitest.config.ts';

  const PLAIN = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });";
  const FRAGMENT_ONLY = [
    "import { defineConfig } from 'vitest/config';",
    "import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';",
    'export default defineConfig({ test: { ...gateParticipationConfig() } });',
  ].join('\n');
  const WITH_SERVER = [
    "import { defineConfig } from 'vitest/config';",
    "import { gateParticipationConfig, gateParticipationServerConfig } from '@papercusp/test-config/vitest-config';",
    'export default defineConfig({ server: gateParticipationServerConfig(), test: { ...gateParticipationConfig() } });',
  ].join('\n');
  const SHARED_BASE =
    "import { defineVitestConfig } from '@papercusp/test-config/vitest-config';\nexport default defineVitestConfig({ layer: 'unit' });";

  it('reports an exemption whose config enrolled or disappeared, and keeps a still-plain one', () => {
    const exemptions = new Set(['libs/a/vitest.config.ts', 'libs/b/vitest.config.ts', 'libs/c/vitest.config.ts']);
    expect(
      findStaleExemptions(
        [
          { path: 'libs/a/vitest.config.ts', content: FRAGMENT_ONLY },
          { path: 'libs/b/vitest.config.ts', content: PLAIN },
        ],
        exemptions,
      ),
    ).toEqual([
      'libs/a/vitest.config.ts (enrolled: remove the exemption)',
      'libs/c/vitest.config.ts (missing: no such declared workspace config)',
    ]);
  });

  it('requires the server fragment only for a hand-rolled config under a nested workspace root', () => {
    const root = '/repo';
    const rootOf = (dir: string): string => (dir.startsWith('/repo/libs/nested') ? '/repo/libs/nested' : root);
    expect(
      findNestedRootConfigsWithoutServerFragment(
        [
          { path: 'libs/nested/missing/vitest.config.ts', content: FRAGMENT_ONLY },
          { path: 'libs/nested/fixed/vitest.config.ts', content: WITH_SERVER },
          { path: 'libs/nested/base/vitest.config.ts', content: SHARED_BASE },
          { path: 'libs/nested/plain/vitest.config.ts', content: PLAIN },
          { path: 'libs/flat/vitest.config.ts', content: FRAGMENT_ONLY },
        ],
        rootOf,
        root,
      ),
    ).toEqual(['libs/nested/missing/vitest.config.ts']);
  });

  it('does not accept a server fragment that is imported but only named in a comment', () => {
    const commented = WITH_SERVER.replace('server: gateParticipationServerConfig(), ', '/* server: gateParticipationServerConfig() */ ');
    expect(commented).not.toBe(WITH_SERVER);
    expect(
      findNestedRootConfigsWithoutServerFragment(
        [{ path: 'libs/nested/x/vitest.config.ts', content: commented }],
        () => '/repo/libs/nested',
        '/repo',
      ),
    ).toEqual(['libs/nested/x/vitest.config.ts']);
  });

  // Calibration: the rule is only as good as the resolver it is handed. Vite must see papergrid
  // (package.json with `workspaces`) as a nested root and a plain workspace as the repo root.
  it("derives nested roots from Vite's own resolver on the real tree", () => {
    expect(viteRootOf(join(REPO_ROOT, 'libs/generic/papergrid/bloom-grid'))).toBe(join(REPO_ROOT, 'libs/generic/papergrid'));
    expect(viteRootOf(join(REPO_ROOT, 'packages/operator-core'))).toBe(REPO_ROOT);
  });

  it('keeps PLAIN_CONFIG_EXEMPTIONS free of stale entries at repository HEAD', () => {
    const stale = findStaleExemptions(collectVitestConfigs());
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('gives every nested-root hand-rolled config at repository HEAD the server fragment', () => {
    const findings = findNestedRootConfigsWithoutServerFragment(collectVitestConfigs(), viteRootOf);
    expect(findings, findings.join('\n')).toEqual([]);
  });

  // Falsifiability control, in memory only: the real bloom-grid config with its server line
  // removed must be caught, so the HEAD check above cannot pass vacuously.
  it('would flag the real bloom-grid config if its server fragment were dropped', () => {
    const real = collectVitestConfigs().filter(({ path }) => path === BLOOM_GRID);
    expect(real).toHaveLength(1);
    const mutated = real.map((c) => ({ ...c, content: c.content.replace('server: gateParticipationServerConfig(),', '') }));
    expect(mutated[0].content).not.toBe(real[0].content);
    expect(findNestedRootConfigsWithoutServerFragment(mutated, viteRootOf)).toEqual([BLOOM_GRID]);
  });
});
