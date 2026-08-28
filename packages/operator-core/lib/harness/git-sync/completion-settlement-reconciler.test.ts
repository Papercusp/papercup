import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reconcileProposedCompletionsAtCommit,
  residualPathsForCommit,
  type CompletionSettlementReconcilerDeps,
} from './completion-settlement-reconciler';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import { isCompletionSettled } from '../../work-item-completion-authority';

const SHA = 'a'.repeat(40);
const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});
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
    expect((updateCall?.[0] as unknown as TemplateStringsArray).join('?')).toContain("authority = 'proposed'");
    expect(updateCall?.slice(1)).toEqual(expect.arrayContaining([
      String(manifest.generation),
      manifest.evidenceHash,
    ]));
    expect(result).toMatchObject({ inspected: 1, upgraded: [] });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('reconcileProposedCompletionsAtCommit — P-008 causal git fixture', () => {
  it('holds dependencies on a partial commit, then upgrades and emits exactly once on the complete commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-settlement-'));
    TEMP_ROOTS.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Settlement Fixture');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
    const aBlob = git('hash-object', 'a.ts');
    const bBlob = git('hash-object', 'b.ts');
    git('add', 'a.ts');
    git('commit', '-q', '-m', 'partial');
    const partialSha = git('rev-parse', 'HEAD');

    const fixtureManifest = {
      ...manifest,
      repositoryRoot: root,
      normalizedPaths: ['a.ts', 'b.ts'],
      contentIdentity: [
        { path: 'a.ts', workingTreeBlobSha: aBlob, headBlobSha: null },
        { path: 'b.ts', workingTreeBlobSha: bBlob, headBlobSha: null },
      ],
    };
    let authority: 'proposed' | 'committed' = 'proposed';
    let payload: Record<string, unknown> = {
      [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: fixtureManifest },
    };
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT feature_id, payload')) {
        return authority === 'proposed' ? [{ feature_id: 'WI-FIXTURE', payload }] : [];
      }
      if (query.includes('UPDATE harness_shared.work_items')) {
        const evidence = payload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
          settlementManifest: typeof fixtureManifest;
        };
        if (
          authority !== 'proposed'
          || values[7] !== String(evidence.settlementManifest.generation)
          || values[9] !== evidence.settlementManifest.evidenceHash
        ) return [];
        payload = values[0] as Record<string, unknown>;
        if (values[1] === 0) authority = 'committed';
        return [{ feature_id: 'WI-FIXTURE' }];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
    (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
    const emit = settlementEmitMock();
    const scope = { installSlug: 'papercusp', workspaceId: 'papercusp-workspace' };

    const partial = await reconcileProposedCompletionsAtCommit(partialSha, scope, { sql, emit });
    expect(partial).toMatchObject({ upgraded: [], residual: 1 });
    expect((payload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
      settlementManifest: { residualPaths: unknown };
    }).settlementManifest.residualPaths).toEqual([{ path: 'b.ts', reason: 'missing-from-commit' }]);
    expect(isCompletionSettled(authority, true)).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    git('add', 'b.ts');
    git('commit', '-q', '-m', 'complete');
    const completeSha = git('rev-parse', 'HEAD');
    const complete = await reconcileProposedCompletionsAtCommit(completeSha, scope, { sql, emit });
    const replay = await reconcileProposedCompletionsAtCommit(completeSha, scope, { sql, emit });

    expect(complete).toMatchObject({ upgraded: ['WI-FIXTURE'], residual: 0 });
    expect(replay).toMatchObject({ inspected: 0, upgraded: [], residual: 0 });
    expect(isCompletionSettled(authority, true)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: 'work-item:settled:WI-FIXTURE',
      payload: expect.objectContaining({ commitSha: completeSha, generation: manifest.generation }),
    }));
  });
});
