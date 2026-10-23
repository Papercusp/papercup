import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = fileURLToPath(new URL('./__fixtures__/clone-corpus-20261021/', import.meta.url));
const recipe = createRequire(import.meta.url)('./__fixtures__/clone-corpus-20261021/reconstruct.cjs') as {
  filterFamilies: (groups: string[][]) => string[][];
  verifyFrozenArtifacts: () => Record<string, unknown>;
  verifyHistoricalRoot: (root: string) => unknown;
  verifyOutputEquality: (original: unknown, historical: unknown, filtered: unknown) => unknown;
  resolveSubmodulePins: (manifest: unknown, supplement: unknown) => { path: string; sha: string }[];
};
const json = (name: string) => JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8'));

describe('D-012 frozen historical clone corpus prerequisite', () => {
  it('pins the unchanged archived probe/output and independently approved candidate manifest', () => {
    const provenance = json('provenance.json');
    expect(provenance.artifacts['original-probe.mjs'].sha256)
      .toBe('4ba94672525ef5670cca480392f7830c128383d53f8f6e5125eb933226bf4e04');
    expect(provenance.artifacts['original-output.json'].sha256)
      .toBe('fe06ebbe35adb9b434a7d4eaa7a50b9af411467e135c9d894f5883f35e9fb187');
    expect(provenance.artifacts['candidate-manifest-v2.json'].sha256)
      .toBe('5b818f5451a60b02263da5d672c5ef82306d8d563d580d7c2539d87367351e21');
    expect(provenance.independentApproval).toBe('thread-post:1198490');
    expect(recipe.verifyFrozenArtifacts()).toMatchObject({
      rawFamilies: 327, filteredFamilies: 164, filteredMembers: 404, governorMembers: 10,
      selectedPaths: 10339, submodulePins: 39, originalQualifyingFunctions: 36185,
      historicalQualifyingFunctions: 36183, censusDifference: 2,
    });
    expect(provenance.originalInputIdentity).toMatch(/^UNPROVEN:/);
  });

  it('rejects changed labels even when the raw group and member counts remain equal', () => {
    const historical = json('historical-output.json');
    historical.allType2[0][0] += ' changed';
    expect(() => recipe.verifyOutputEquality(json('original-output.json'), historical,
      json('original-filtered-family-labels.json'))).toThrow('raw family labels changed');
  });

  it('excludes vendored and retired members before checking distinct-file membership', () => {
    const groups = [
      ['_retired/x.ts:1 a m=80', 'packages/x.ts:1 a m=80'],
      ['templates/x.ts:1 a m=80', 'libs/x/template-kit/a.ts:1 a m=80'],
      ['apps/operator/app/x.ts:1 a m=80', 'packages/x.ts:1 a m=80'],
      ['packages/x.ts:1 a m=80', 'packages/x.ts:2 b m=80'],
      ['packages/x.ts:1 a m=80', 'packages/y.ts:2 b m=80'],
    ];
    expect(recipe.filterFamilies(groups)).toEqual([groups[4]]);
  });

  it('rejects a current-tree replay before executing git or the archived probe', () => {
    expect(() => recipe.verifyHistoricalRoot(resolve(fixtureDir, '../../../../../..')))
      .toThrow('canonical staging is not a historical replay target');
  });

  it('preserves the two-function census difference instead of silently normalizing it', () => {
    const historical = json('historical-output.json');
    historical.functionsAtOrAboveMinMass = 36185;
    expect(() => recipe.verifyOutputEquality(json('original-output.json'), historical,
      json('original-filtered-family-labels.json'))).toThrow();
  });

  it('requires explicit gitlink-backed correction for the retained malformed first submodule pin', () => {
    const manifest = json('candidate-manifest-v2.json');
    const supplement = json('submodule-pin-corrections.json');
    expect(manifest.submodules[0].sha).toHaveLength(39);
    expect(() => recipe.resolveSubmodulePins(manifest, { ...supplement, corrections: [] }))
      .toThrow('malformed submodule pin');
    expect(recipe.resolveSubmodulePins(manifest, supplement)[0]).toEqual({
      path: 'apps/slack-asana-bug-drill', sha: 'cf8b670c5aea000eaea8c9616279994b7b3a170b',
    });
    supplement.corrections[0].materializedHead = '0'.repeat(40);
    expect(() => recipe.resolveSubmodulePins(manifest, supplement)).toThrow();
  });
});
