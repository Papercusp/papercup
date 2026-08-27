import { describe, expect, it, vi } from 'vitest';
import {
  reconcileProposedCompletionsAtCommit,
  residualPathsForCommit,
  type CompletionSettlementReconcilerDeps,
} from './completion-settlement-reconciler';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';

const SHA = 'a'.repeat(40);
const manifest = {
  version: 1 as const,
  generation: 2,
  evidenceHash: 'b'.repeat(64),
  repositoryRoot: '/repo',
  headSha: 'c'.repeat(40),
  normalizedPaths: ['a.ts', 'nested/b.ts'],
  contentIdentity: [
    { path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null },
    { path: 'nested/b.ts', workingTreeBlobSha: 'e'.repeat(40), headBlobSha: null },
  ],
};

describe('residualPathsForCommit', () => {
  it('settles only when every close-time blob is present in the exact commit', () => {
    expect(residualPathsForCommit(manifest, SHA, () => new Map([
      ['a.ts', 'd'.repeat(40)],
      ['nested/b.ts', 'e'.repeat(40)],
    ]))).toEqual([]);
  });

  it('reads identities from the emitted commit SHA, independent of later working-tree edits', () => {
    const lookup = vi.fn(() => new Map([
      ['a.ts', 'd'.repeat(40)],
      ['nested/b.ts', 'e'.repeat(40)],
    ]));
    const laterWorkingTreeIdentity = new Map([
      ['a.ts', 'f'.repeat(40)],
      ['nested/b.ts', 'f'.repeat(40)],
    ]);

    expect(residualPathsForCommit(manifest, SHA, lookup)).toEqual([]);
    expect(lookup).toHaveBeenCalledWith('/repo', SHA, ['a.ts', 'nested/b.ts']);
    expect(laterWorkingTreeIdentity).not.toEqual(lookup.mock.results[0]?.value);
  });

  it('persists deterministic residue for partial and mismatched commits', () => {
    expect(residualPathsForCommit(manifest, SHA, () => new Map([
      ['a.ts', 'f'.repeat(40)],
    ]))).toEqual([
      { path: 'a.ts', reason: 'content-mismatch' },
      { path: 'nested/b.ts', reason: 'missing-from-commit' },
    ]);
  });

  it('fails closed when the exact-tree lookup is unavailable', () => {
    expect(residualPathsForCommit(manifest, SHA, () => undefined)).toEqual([
      { path: 'a.ts', reason: 'identity-unavailable' },
      { path: 'nested/b.ts', reason: 'identity-unavailable' },
    ]);
  });
});

function settlementSql(options: { updateHits: boolean[] }) {
  let updateIndex = 0;
  const payload = { [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: manifest } };
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('SELECT feature_id, payload')) return [{ feature_id: 'WI-42476', payload }];
    if (query.includes('UPDATE harness_shared.work_items')) {
      return options.updateHits[updateIndex++] ? [{ feature_id: 'WI-42476' }] : [];
    }
    throw new Error(`unexpected SQL: ${query}`);
  }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
  (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
  return sql;
}

function settlementEmitMock() {
  return vi.fn<NonNullable<CompletionSettlementReconcilerDeps['emit']>>(async (opts) => ({
    ok: true,
    key: opts.key,
    woken: 0,
    notified: [],
    msgId: null,
    waiters: 0,
  }));
}

describe('reconcileProposedCompletionsAtCommit — P-004 settled event', () => {
  const scope = { installSlug: 'papercusp', workspaceId: 'papercusp-workspace' };
  const matchingLookup = () => new Map([
    ['a.ts', 'd'.repeat(40)],
    ['nested/b.ts', 'e'.repeat(40)],
  ]);

  it('emits the latched settlement receipt once, only after a successful proposed→committed CAS', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [true, false] });

    const first = await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, lookup: matchingLookup, emit });
    const replay = await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, lookup: matchingLookup, emit });

    expect(first.upgraded).toEqual(['WI-42476']);
    expect(replay.upgraded).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      key: 'work-item:settled:WI-42476',
      summary: `WI-42476 settlement committed at ${SHA.slice(0, 12)}`,
      payload: {
        id: 'WI-42476',
        harness: 'papercusp',
        commitSha: SHA,
        generation: 2,
        evidenceHash: 'b'.repeat(64),
      },
      source: 'git-sync-completion-settlement',
      workspaceId: 'papercusp-workspace',
    });
  });

  it('does not emit for residue or a missed CAS', async () => {
    const emit = settlementEmitMock();
    const residue = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql: settlementSql({ updateHits: [true] }),
      lookup: () => new Map([['a.ts', 'f'.repeat(40)]]),
      emit,
    });
    const missed = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql: settlementSql({ updateHits: [false] }),
      lookup: matchingLookup,
      emit,
    });

    expect(residue).toMatchObject({ upgraded: [], residual: 2 });
    expect(missed.upgraded).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps stale or out-of-order generations silent behind the evidence-scoped CAS', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [false] });

    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: matchingLookup,
      emit,
    });

    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    expect(updateCall?.slice(1)).toEqual(expect.arrayContaining([
      'proposed',
      String(manifest.generation),
      manifest.evidenceHash,
    ]));
    expect(result).toMatchObject({ inspected: 1, upgraded: [] });
    expect(emit).not.toHaveBeenCalled();
  });
});
