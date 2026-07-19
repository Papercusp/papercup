/**
 * Cupboard prod-hygiene scan (EI-11118). Hermetic — `browse` is injected;
 * no network. See prod-hygiene.ts for the junk-pattern rationale (P-009).
 */
import { describe, expect, it } from 'vitest';
import { scanCupboardForTestRows, CUPBOARD_TEST_ROW_PATTERN, type CupboardBrowseFn } from './prod-hygiene';

function browseFrom(byKind: Record<string, Record<string, unknown>[]>): CupboardBrowseFn {
  return async (kind) => ({ ok: true, listings: byKind[kind] ?? [] });
}

describe('CUPBOARD_TEST_ROW_PATTERN', () => {
  it('matches every P-009 purge pattern', () => {
    const junk = [
      'papercupai/psu-fed-e2e-1720000000',
      'papercupai/psu-shared-hive-e2e-84b3ab6f',
      'aviynw/shared_hive_test',
      'papercupai/cupboard-verify-smoke',
      'octocat/Hello-World',
      'jonschlinkert/is-even',
      'jonschlinkert/is-odd',
      'githubtraining/hellogitworld',
      'defunkt/dotjs',
      'github/gitignore',
      'sindresorhus/slash',
      'someone/dummy-repo',
      'someone/foobar-repo',
      'a literal test title',
    ];
    for (const s of junk) expect(CUPBOARD_TEST_ROW_PATTERN.test(s), s).toBe(true);
  });

  it('does not flag official-looking content', () => {
    const official = [
      'Papercusp/papercusp',
      'papercupai/coding-blueprint',
      'papercupai/knowledge-packs',
      'acme/shop',
      'Attested Coding Harness',
    ];
    for (const s of official) expect(CUPBOARD_TEST_ROW_PATTERN.test(s), s).toBe(false);
  });
});

describe('scanCupboardForTestRows', () => {
  it('finds junk rows across kinds by title/owner+name/listing_ref', async () => {
    const browse = browseFrom({
      harness: [
        { id: 'h1', title: 'psu-fed-e2e-1720000000', listing_ref: 'papercupai/psu-fed-e2e-1720000000' },
        { id: 'h2', github_owner: 'acme', github_name: 'shop', listing_ref: 'acme/shop' },
      ],
      blueprint: [{ id: 'b1', title: 'cupboard-verify-smoke', listing_ref: 'papercupai/cupboard-verify-smoke' }],
      plugin: [],
      pack: [],
      'knowledge-pack': [],
      template: [],
      app: [],
    });
    const { testRows, errors } = await scanCupboardForTestRows(browse);
    expect(errors).toEqual([]);
    expect(testRows).toEqual([
      { kind: 'harness', id: 'h1', ref: 'papercupai/psu-fed-e2e-1720000000' },
      { kind: 'blueprint', id: 'b1', ref: 'papercupai/cupboard-verify-smoke' },
    ]);
  });

  it('returns empty testRows on a clean storefront', async () => {
    const browse = browseFrom({
      harness: [{ id: 'h2', github_owner: 'acme', github_name: 'shop', listing_ref: 'acme/shop' }],
    });
    const { testRows } = await scanCupboardForTestRows(browse, ['harness']);
    expect(testRows).toEqual([]);
  });

  it('a browse failure for one kind is reported and does not stop the scan of others', async () => {
    const browse: CupboardBrowseFn = async (kind) => {
      if (kind === 'blueprint') return { ok: false, listings: [], error: 'cupboard_http_503' };
      return { ok: true, listings: kind === 'harness' ? [{ id: 'h1', listing_ref: 'papercupai/psu-fed-e2e-1' }] : [] };
    };
    const { testRows, errors } = await scanCupboardForTestRows(browse, ['harness', 'blueprint', 'plugin']);
    expect(testRows).toEqual([{ kind: 'harness', id: 'h1', ref: 'papercupai/psu-fed-e2e-1' }]);
    expect(errors).toEqual([{ kind: 'blueprint', error: 'cupboard_http_503' }]);
  });

  it('a throwing browse fn is caught and reported as an error, not thrown', async () => {
    const browse: CupboardBrowseFn = async () => {
      throw new Error('network exploded');
    };
    const { testRows, errors } = await scanCupboardForTestRows(browse, ['harness']);
    expect(testRows).toEqual([]);
    expect(errors).toEqual([{ kind: 'harness', error: 'network exploded' }]);
  });
});
