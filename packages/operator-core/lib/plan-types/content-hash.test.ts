/**
 * The first-party definition hashes are FIXED here (plan-item-types-registry-cupboard P-005,
 * D-006). Migration 1545 backfills every pre-registry activated plan's pins with these same
 * literals, and a pinned plan whose definition no longer matches its pin fails safe to the
 * strictest module set. So editing a first-party definition in builtin-catalog.ts must fail
 * this test: the edit needs a new revision, not a silent change to revision 1.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG } from './builtin-catalog';
import { definitionContentHash } from './content-hash';
import { buildTypeRegistrySnapshot } from './registry';

const FIRST_PARTY_HASHES: Record<string, string> = {
  'papercusp/code': 'b3845721014d94609a14b7076381cc25e033979c00d077620ede2fd7da8d63a8',
  'papercusp/doc': '03961bf29818a0811a1be0714ea416d707dcbda53ff03ebcd849a3b8d9a2ff10',
  'papercusp/decision': 'b4b4381dbcdacf850fc06c4c972f3e91c9edda6fa5ecb5bb4092fa984381db33',
  'papercusp/research': '01f4fe2ffe230eb3f4e4185841bb63f59f1d9e19c9d552e972cb7c34e113c48f',
  'papercusp/operation': '3248c2c0a553462bf8fc542131c12a2be87d2a5e6807a96eafba4e7ffd97c82a',
  'papercusp/artifact': 'bab794a1a29e1e663be6659bf5bcec54fe687a9f62375507f9157d2e74448d80',
  'papercusp/coding': '1a12288396d2c39c6169e92eb7a50a882e9612172b6bcd45bbb4286e70c3e1cf',
  'papercusp/general': '7caa0494d37bce4d8e64c310853c03a9059edca6daf4bfa4265f4ceca77ced37',
};

// These presets were introduced after migration 1545. Keep their revision-1
// contracts fixed without rewriting the historical legacy-pin migration.
const RISK_PRESET_HASHES: Record<string, string> = {
  'papercusp/code-trivial': '8d5a3e19259c2a17e414687ca42da21c9dd47d0c1f9422524ec3e22e16d91714',
  'papercusp/code-low': '8e0c48251bba7affa027c39a367721b9b4e86b5704bd8f6a2852905cd6bedf0e',
  'papercusp/code-moderate': '63e534fd86bfc8b61107de4ab6ea1be7e747757eb1352a2939922541bde8987b',
  'papercusp/code-high': '66b1249deabf405fcdd3b82745c719811cd55c0553bd09748d0fc7c69f65d5fb',
  'papercusp/code-critical': '9badc7f0d7cea06f21cd30d055acd1623df49adec343bd4851c7e6c7871f048a',
  'papercusp/coding-trivial': 'dc3416842dc33d8059e712a05bd2c9303c8610cbe1949706c176ba2e02d5fded',
  'papercusp/coding-low': 'a32ca7837f8535999a02c7db529d7ff848ca474d6b96dfdf70955af986ca237f',
  'papercusp/coding-moderate': '44d03347bcf854fa94f7caabfb3507f923d583fdd76646107d06a5b61683e537',
  'papercusp/coding-high': '7c351c4255f501781ca939d947494ef3b2bd82f62be02df61c32d7505435ad5c',
  'papercusp/coding-critical': 'aa9f01b85d90538667a4bc701b69dee59f40286da580abc04f3830b4d7423cba',
};

describe('definition content hashes', () => {
  it('fixes every first-party revision-1 hash (edit a built-in only with a new revision)', () => {
    const actual = Object.fromEntries(
      [...BUILTIN_CATALOG.itemTypes, ...BUILTIN_CATALOG.planTypes].map((d) => [d.id, definitionContentHash(d)]),
    );
    expect(actual).toEqual({ ...FIRST_PARTY_HASHES, ...RISK_PRESET_HASHES });
  });

  it('matches the literals migration 1545 backfills into plan_type_pins', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const sqlPath = fileURLToPath(
      new URL('../../../../libs/papercusp/libs/db/sql/1545-plan-type-pins.sql', import.meta.url),
    );
    const sql = await readFile(sqlPath, 'utf8');
    for (const [id, hash] of Object.entries(FIRST_PARTY_HASHES)) {
      expect(sql, id).toMatch(new RegExp(`'${id}',\\s*'${hash}'`));
    }
  });

  it('ignores key order but not content', () => {
    const a = { schemaVersion: 1, id: 'acme/x', revision: 1, title: 'X', modules: ['generic-core'] };
    const b = { modules: ['generic-core'], title: 'X', revision: 1, id: 'acme/x', schemaVersion: 1 };
    expect(definitionContentHash(a)).toBe(definitionContentHash(b));
    expect(definitionContentHash({ ...a, title: 'Y' })).not.toBe(definitionContentHash(a));
    expect(definitionContentHash({ ...a, modules: ['generic-core', 'code'] })).not.toBe(definitionContentHash(a));
  });

  it('the registry snapshot carries the stored definition hash on every candidate', () => {
    const registry = buildTypeRegistrySnapshot();
    expect(registry.itemType('papercusp/code')?.contentHash).toBe(FIRST_PARTY_HASHES['papercusp/code']);
    expect(registry.planTypeAt('papercusp/general', 1)?.contentHash).toBe(FIRST_PARTY_HASHES['papercusp/general']);
  });
});
