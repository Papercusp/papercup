import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinnedImplicitTestExclusions, pinnedSelectionPage, type PinnedPrecheckSelection, type PinnedSelectionFile } from './pinned-precheck-selection';
import { parsePinnedPrecheckSelection } from './precheck-selection';

const root = resolve(import.meta.dirname, '../../../..');
const paths = ['vitest.config.ts', 'vitest.integration.config.ts', 'scripts/test-files.mjs',
  'libs/test-config/src/vitest-config.ts', 'libs/test-config/src/execution-details.ts'];
function file(content: string): PinnedSelectionFile {
  return { content, sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex') };
}
function fixture() { return new Map(paths.map(path => [path, file(readFileSync(resolve(root, path), 'utf8'))])); }
const commit = 'a'.repeat(40);
const retired = 'libs/papercusp/_retired/deep/old.test.ts';
const integration = 'libs/papercusp/_retired/deep/old.integration.test.ts';
const scratch = '.papercusp/reports/old.test.ts';

describe('pinned implicit root Vitest exclusions', () => {
  it('derives both actual root configurations and retains the matched rule and every pinned evidence blob', () => {
    const files = fixture();
    const result = pinnedImplicitTestExclusions({ commit, files, tests: [retired, integration, scratch], explicitTests: [] });
    expect(result.unavailable).toBeUndefined();
    expect(result.excluded.map(row => row.path)).toEqual([scratch, integration, retired].sort());
    for (const row of result.excluded) {
      expect(row.pattern).toBe(row.path === scratch ? '**/.papercusp/**' : '**/_retired/**');
      expect(row.config).toBe(row.path === integration ? 'vitest.integration.config.ts' : 'vitest.config.ts');
      expect(row.evidence).toHaveLength(4);
      for (const proof of row.evidence) expect(proof.blob).toBe(files.get(proof.path)!.sha);
    }
  });

  it('preserves explicit signature/admitted paths, including workspace-relative signature aliases', () => {
    const result = pinnedImplicitTestExclusions({ commit, files: fixture(), tests: [retired, integration, scratch],
      explicitTests: ['_retired/deep/old.test.ts', integration, scratch] });
    expect(result.excluded).toEqual([]);
  });

  it('proves forwarded explicit root exclusions when the pinned unit factory has no base defaults', () => {
    const files = fixture(), shared = 'libs/test-config/src/vitest-config.ts';
    const original = files.get(shared)!.content!;
    const historical = original.replace('...configDefaults.exclude, ...baseExclude, ...(opts.exclude ?? [])',
      '...configDefaults.exclude, ...(opts.exclude ?? [])');
    expect(historical).not.toBe(original);
    files.set(shared, file(historical));
    const result = pinnedImplicitTestExclusions({ commit, files, tests: [retired, integration, scratch], explicitTests: [] });
    expect(result.unavailable).toBeUndefined();
    expect(result.excluded.map(row => row.path)).toEqual([retired, integration, scratch].sort());
    files.set('vitest.config.ts', file(`import {defineConfig} from 'vitest/config';
      import {gateParticipationConfig} from '@papercusp/test-config/vitest-config';
      export default defineConfig({test: gateParticipationConfig()});`));
    expect(pinnedImplicitTestExclusions({ commit, files, tests: [retired, scratch], explicitTests: [] }).excluded).toEqual([]);
  });

  it.each(['opts.exclude = [];', 'changePolicy(opts);', 'changePolicy(opts.exclude);'])(
    'does not prove forwarded options when the pinned factory mutates or leaks them: %s', mutation => {
      const files = fixture(), shared = 'libs/test-config/src/vitest-config.ts';
      const historical = files.get(shared)!.content!
        .replace('...configDefaults.exclude, ...baseExclude, ...(opts.exclude ?? [])', '...configDefaults.exclude, ...(opts.exclude ?? [])')
        .replace("const gate = gateOwnedParts('unit', env);", `${mutation}\n  const gate = gateOwnedParts('unit', env);`);
      files.set(shared, file(historical));
      const result = pinnedImplicitTestExclusions({ commit, files, tests: [retired, scratch], explicitTests: [] });
      expect(result.excluded).toEqual([]);
      expect(result.unavailable).toContain('unproved pinned exclusion sources');
    },
  );

  it('retains active names, nearer owners, registered cross-tree and custom Node runners', () => {
    const files = fixture();
    files.set('custom/vitest.config.ts', file('export default {};'));
    files.set('configless/package.json', file(JSON.stringify({ scripts: { test: 'vitest run' } })));
    const tests = ['active/src/retired-reader.test.ts', 'active/src/papercusp-report.test.ts',
      'custom/_retired/owned.test.ts', 'configless/_retired/owned.test.ts',
      'templates/_retired/example/checks/runtime.fixture.test.ts', 'papercusp-desktop/test/_retired/native.test.js',
      'scripts/_retired/maintenance.test.mjs', retired];
    expect(pinnedImplicitTestExclusions({ commit, files, tests, explicitTests: [] }).excluded.map(row => row.path)).toEqual([retired]);
  });

  it('derives recognized config names from the pinned router instead of treating every variant as an owner', () => {
    const files = fixture(), router = 'scripts/test-files.mjs';
    const test = 'libs/papercusp/_retired/orchestrator-run-loop/src/main-loop.test.ts';
    files.set('libs/papercusp/_retired/orchestrator-run-loop/vitest.dispatcher.config.ts', file('export default {};'));
    files.set('libs/papercusp/_retired/orchestrator-run-loop/vitest.slow.config.ts', file('export default {};'));
    expect(pinnedImplicitTestExclusions({ commit, files, tests: [test], explicitTests: [] }).excluded.map(row => row.path)).toEqual([test]);
    const original = files.get(router)!.content!;
    const changed = original.replace('vitest\\.config', 'vitest\\.(?:config|dispatcher\\.config)');
    expect(changed).not.toBe(original);
    files.set(router, file(changed));
    expect(pinnedImplicitTestExclusions({ commit, files, tests: [test], explicitTests: [] }).excluded).toEqual([]);
  });

  it('retains every test when the pinned runner declaration is unavailable or dynamic', () => {
    for (const replacement of [null, 'const NON_WORKSPACE_VITEST_ROUTES = loadRoutes();']) {
      const files = fixture();
      files.set('scripts/test-files.mjs', { sha: 'b'.repeat(40), content: replacement });
      const result = pinnedImplicitTestExclusions({ commit, files, tests: [retired, integration], explicitTests: [] });
      expect(result.excluded).toEqual([]);
      expect(result.unavailable).toBeTruthy();
    }
  });

  it('honors a final explicit exclude override instead of inferring a factory default', () => {
    const files = fixture();
    files.set('vitest.config.ts', file("import { defineConfig } from 'vitest/config'; export default defineConfig({test:{exclude:[]}});"));
    expect(pinnedImplicitTestExclusions({ commit, files, tests: [retired], explicitTests: [] }).excluded).toEqual([]);
  });

  it.each(['get exclude() { return []; }', 'exclude() { return []; }', 'exclude'])(
    'retains implicit tests for an unsupported exclude override: %s', override => {
      for (const factoryOptions of [false, true]) {
        const files = fixture();
        const options = `exclude: ['**/_retired/**'], ${override}`;
        files.set('vitest.config.ts', file(`
          import { defineConfig } from 'vitest/config';
          import { gateParticipationConfig } from '@papercusp/test-config/vitest-config';
          const exclude = readExclusions();
          export default defineConfig({test: ${factoryOptions
            ? `gateParticipationConfig({${options}})`
            : `{...gateParticipationConfig(), ${override}}`}});
        `));
        const result = pinnedImplicitTestExclusions({ commit, files, tests: [retired, integration], explicitTests: [] });
        expect(result.excluded).toEqual([]);
        expect(result.unavailable).toContain('unsupported pinned property: exclude');
      }
    },
  );

  it('retains tests when literal exclusion bindings are mutated or escape into an unknown call', () => {
    for (const mutation of ['baseExclude.splice(0);', 'changePolicy(baseExclude);']) {
      const files = fixture();
      const shared = 'libs/test-config/src/vitest-config.ts';
      files.set(shared, file(files.get(shared)!.content! + '\n' + mutation));
      const result = pinnedImplicitTestExclusions({ commit, files, tests: [integration], explicitTests: [] });
      expect(result.excluded).toEqual([]);
      expect(result.unavailable).toContain('escapes or mutates');
    }
  });

  it('does not treat comments, near-match directory names or non-universal globs as exclusion proof', () => {
    const files = fixture();
    files.set('vitest.config.ts', file("import {defineConfig} from 'vitest/config'; // '**/_retired/**'\nexport default defineConfig({test:{exclude:['**/_retired/*.test.ts']}});"));
    expect(pinnedImplicitTestExclusions({ commit, files, tests: [retired, '_retired-looking/active.test.ts'], explicitTests: [] }).excluded).toEqual([]);
  });

  it('uses pinned policy bytes after working policy changes and is independent of input order', () => {
    const files = fixture();
    const tests = [retired, integration, scratch];
    const first = pinnedImplicitTestExclusions({ commit, files, tests, explicitTests: [] });
    expect(pinnedImplicitTestExclusions({ commit, files, tests: [...tests].reverse(), explicitTests: [] })).toEqual(first);
    files.set('vitest.integration.config.ts', file('export default computeConfig();'));
    const changed = pinnedImplicitTestExclusions({ commit, files, tests, explicitTests: [] });
    expect(changed.excluded).toEqual([]);
    expect(first.excluded).toHaveLength(3);
  });
});

describe('complete pinned selection recovery', () => {
  it.each([39, 40, 41, 121])('recovers all %i exclusions across page boundaries and a serialized restart', count => {
    const selection: PinnedPrecheckSelection = { schemaVersion: 1, commit, excluded: Array.from({ length: count }, (_, i) => ({
      path: `_retired/${String(i).padStart(4, '0')}/decisive.test.ts`, pattern: '**/_retired/**', config: 'vitest.config.ts',
      evidence: [{ path: 'vitest.config.ts', blob: 'b'.repeat(40) }],
    })) };
    let page = pinnedSelectionPage(selection);
    const recovered = [...page.rows];
    while (page.next) {
      const restart = JSON.parse(JSON.stringify(selection)) as PinnedPrecheckSelection;
      page = pinnedSelectionPage(restart, page.next);
      recovered.push(...page.rows);
    }
    expect(recovered).toEqual(selection.excluded);
    expect(recovered.at(-1)?.path).toBe(selection.excluded.at(-1)?.path);
    expect(page).toMatchObject({ total: count, remaining: 0, next: null });
  });

  it('rejects stale or foreign cursors and invalid display limits without slicing an identity', () => {
    const selection: PinnedPrecheckSelection = { schemaVersion: 1, commit, excluded: [] };
    expect(() => pinnedSelectionPage(selection, { identity: 'changed' })).toThrow('stale');
    expect(() => pinnedSelectionPage(selection, { after: 'absent' })).toThrow('absent');
    for (const limit of [0, 201, 1.5]) expect(() => pinnedSelectionPage(selection, { limit })).toThrow('limit');
  });

  it('keeps a recovery identity across jsonb key reordering and rejects a malformed proof after a page boundary', () => {
    const selection: PinnedPrecheckSelection = { schemaVersion: 1, commit, excluded: Array.from({ length: 41 }, (_, i) => ({
      path: `_retired/${i}/item.test.ts`, pattern: '**/_retired/**', config: 'vitest.config.ts',
      evidence: [{ path: 'vitest.config.ts', blob: 'b'.repeat(40) }],
    })) };
    const first = pinnedSelectionPage(selection);
    const reordered = { excluded: selection.excluded.map(row => ({ evidence: row.evidence.map(p => ({ blob: p.blob, path: p.path })),
      config: row.config, pattern: row.pattern, path: row.path })), commit, schemaVersion: 1 as const };
    expect(pinnedSelectionPage(reordered, first.next!).rows).toEqual(selection.excluded.slice(40));
    reordered.excluded[40]!.evidence[0]!.blob = 'invalid';
    expect(parsePinnedPrecheckSelection(reordered)).toBeNull();
  });
});
