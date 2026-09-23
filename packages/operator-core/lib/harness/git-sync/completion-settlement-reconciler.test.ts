import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeStoredSettlementManifest,
  reconcileProposedCompletionsAtCommit,
  residualPathsForCommit,
  type CompletionSettlementReconcilerDeps,
} from './completion-settlement-reconciler';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import {
  completionBlobHistoryContains,
  completionHeadBlobMap,
  type HeadBlobResolution,
} from '../../agent-tools/work_items/completion-freshness';
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

/** Build a lookup result in the three-valued contract (WI-42441). */
const resolved = (sha: string): HeadBlobResolution => ({ status: 'resolved', sha });
const absent = (): HeadBlobResolution => ({ status: 'absent' });
const unresolvable = (reason: string): HeadBlobResolution => ({ status: 'unresolvable', reason });

describe('residualPathsForCommit', () => {
  it('settles only when every close-time blob is present in the exact commit', async () => {
    expect(
      await residualPathsForCommit(
        manifest,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('d'.repeat(40))],
            ['nested/b.ts', resolved('e'.repeat(40))],
          ]),
      ),
    ).toEqual([]);
  });

  it('reads identities from the emitted commit SHA, independent of later working-tree edits', async () => {
    const lookup = vi.fn(
      () =>
        new Map([
          ['a.ts', resolved('d'.repeat(40))],
          ['nested/b.ts', resolved('e'.repeat(40))],
        ]),
    );
    const laterWorkingTreeIdentity = new Map([
      ['a.ts', resolved('f'.repeat(40))],
      ['nested/b.ts', resolved('f'.repeat(40))],
    ]);

    expect(await residualPathsForCommit(manifest, SHA, lookup)).toEqual([]);
    expect(lookup).toHaveBeenCalledWith('/repo', SHA, ['a.ts', 'nested/b.ts']);
    expect(laterWorkingTreeIdentity).not.toEqual(lookup.mock.results[0]?.value);
  });

  it('persists deterministic residue for partial and mismatched commits', async () => {
    expect(
      await residualPathsForCommit(
        manifest,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('f'.repeat(40))],
            ['nested/b.ts', absent()],
          ]),
      ),
    ).toEqual([
      { path: 'a.ts', reason: 'content-mismatch' },
      { path: 'nested/b.ts', reason: 'missing-from-commit' },
    ]);
  });

  it('fails closed when the exact-tree lookup is unavailable', async () => {
    expect(await residualPathsForCommit(manifest, SHA, () => undefined)).toEqual([
      { path: 'a.ts', reason: 'identity-unavailable' },
      { path: 'nested/b.ts', reason: 'identity-unavailable' },
    ]);
  });

  /**
   * WI-42441 — the defect this contract exists to kill. An unreadable submodule and a
   * path the commit genuinely lacks used to arrive here as the SAME thing (absence from
   * the map), so a resolution failure was reported as `missing-from-commit` — which reads
   * as the closer's fault and sends them to re-commit work that is already committed.
   *
   * The CONTROL below is what makes this falsifiable: the two cases are asserted in ONE
   * test against the SAME path, so an implementation that collapses them cannot pass —
   * whichever single reason it picks, one of the two expectations fails.
   */
  it('separates an unreadable submodule from a path the commit really lacks', async () => {
    const reason = "submodule 'libs/papercusp' could not be read at abc123456789";
    const unreadable = await residualPathsForCommit(
      manifest,
      SHA,
      () =>
        new Map([
          ['a.ts', resolved('d'.repeat(40))],
          ['nested/b.ts', unresolvable(reason)],
        ]),
    );
    // CONTROL: identical shape, the one difference being a tree that was actually read.
    const genuinelyMissing = await residualPathsForCommit(
      manifest,
      SHA,
      () =>
        new Map([
          ['a.ts', resolved('d'.repeat(40))],
          ['nested/b.ts', absent()],
        ]),
    );

    expect(unreadable).toEqual([{ path: 'nested/b.ts', reason: 'identity-unavailable' }]);
    expect(genuinelyMissing).toEqual([{ path: 'nested/b.ts', reason: 'missing-from-commit' }]);
    expect(unreadable).not.toEqual(genuinelyMissing);
  });

  it('fails closed — never `missing-from-commit` — for a path the lookup did not answer at all', async () => {
    // A map that simply omits a requested path is an INCOMPLETE answer, not a verdict
    // that the commit lacks it. Absence must never be promoted to a finding about the tree.
    expect(await residualPathsForCommit(manifest, SHA, () => new Map([['a.ts', resolved('d'.repeat(40))]]))).toEqual([
      { path: 'nested/b.ts', reason: 'identity-unavailable' },
    ]);
  });
});

describe('completionBlobHistoryContains — exact path and repository proof', () => {
  it('settles a committed then superseded blob, but rejects ODB-only, other-path, and ignored blobs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-history-'));
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
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(root, 'superseded.ts'), 'export const value = "before";\n');
    writeFileSync(join(root, 'dirty.ts'), 'export const value = "before dirty";\n');
    writeFileSync(join(root, 'wrong-path.ts'), 'export const value = "before wrong path";\n');
    git('add', '--', '.gitignore', 'superseded.ts', 'dirty.ts', 'wrong-path.ts');
    git('commit', '-q', '-m', 'completion head');
    const closeHeadSha = git('rev-parse', 'HEAD');
    const supersededHeadSha = git('hash-object', 'superseded.ts');
    const dirtyHeadSha = git('hash-object', 'dirty.ts');
    const wrongPathHeadSha = git('hash-object', 'wrong-path.ts');

    writeFileSync(join(root, 'superseded.ts'), 'export const value = "close time";\n');
    const supersededSha = git('hash-object', 'superseded.ts');
    git('add', '--', 'superseded.ts');
    git('commit', '-q', '-m', 'commit close-time blob');
    writeFileSync(join(root, 'superseded.ts'), 'export const value = "later content";\n');

    writeFileSync(join(root, 'dirty.ts'), 'export const value = "ODB only";\n');
    const dirtyOnlySha = git('hash-object', '-w', 'dirty.ts');
    writeFileSync(join(root, 'dirty.ts'), 'export const value = "later dirty content";\n');

    writeFileSync(join(root, 'other-path.ts'), 'export const value = "other path only";\n');
    const otherPathSha = git('hash-object', '-w', 'other-path.ts');
    writeFileSync(join(root, 'wrong-path.ts'), 'export const value = "later wrong content";\n');
    writeFileSync(join(root, 'ignored.ts'), 'export const value = "ignored ODB only";\n');
    const ignoredSha = git('hash-object', '-w', 'ignored.ts');
    git('add', '-A', '--', 'superseded.ts', 'dirty.ts', 'wrong-path.ts', 'other-path.ts');
    git('commit', '-q', '-m', 'supersede and commit controls');
    const emittedSha = git('rev-parse', 'HEAD');

    const historyManifest = {
      ...manifest,
      repositoryRoot: root,
      headSha: closeHeadSha,
      normalizedPaths: ['superseded.ts', 'dirty.ts', 'wrong-path.ts', 'ignored.ts'],
      contentIdentity: [
        { path: 'superseded.ts', workingTreeBlobSha: supersededSha, headBlobSha: supersededHeadSha },
        { path: 'dirty.ts', workingTreeBlobSha: dirtyOnlySha, headBlobSha: dirtyHeadSha },
        { path: 'wrong-path.ts', workingTreeBlobSha: otherPathSha, headBlobSha: wrongPathHeadSha },
        { path: 'ignored.ts', workingTreeBlobSha: ignoredSha, headBlobSha: null },
      ],
    };

    expect(
      await residualPathsForCommit(
        historyManifest,
        emittedSha,
        completionHeadBlobMap,
        undefined,
        completionBlobHistoryContains,
      ),
    ).toEqual([
      { path: 'dirty.ts', reason: 'content-mismatch' },
      { path: 'wrong-path.ts', reason: 'content-mismatch' },
      { path: 'ignored.ts', reason: 'missing-from-commit' },
    ]);
    const settlement = await reconcileProposedCompletionsAtCommit(
      emittedSha,
      { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', repositoryRoot: root },
      { sql: settlementSql({ updateHits: [true], manifest: historyManifest }), emit: settlementEmitMock() },
    );
    expect(settlement).toMatchObject({ inspected: 1, upgraded: [], residual: 3, unreadable: [] });
    expect(
      await completionBlobHistoryContains(root, closeHeadSha, emittedSha, 'ignored.ts', ignoredSha),
    ).toBe(false);
    expect(
      await completionBlobHistoryContains(root, '0'.repeat(40), emittedSha, 'superseded.ts', supersededSha),
    ).toBeUndefined();
  });

  it('reads superseded history from the commit-pinned submodule object database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-history-submodule-'));
    TEMP_ROOTS.push(root);
    const subRoot = join(root, 'modules', 'nested');
    mkdirSync(subRoot, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    const subGit = (...args: string[]) =>
      execFileSync('git', ['-C', subRoot, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Settlement Fixture');
    subGit('init', '-q');
    subGit('config', 'user.email', 'fixture@example.test');
    subGit('config', 'user.name', 'Settlement Fixture');
    writeFileSync(join(subRoot, 'file.ts'), 'export const value = "before";\n');
    subGit('add', '--', 'file.ts');
    subGit('commit', '-q', '-m', 'submodule base');
    const submoduleHeadSha = subGit('rev-parse', 'HEAD');
    writeFileSync(join(root, '.gitmodules'), '[submodule "nested"]\n\tpath = modules/nested\n\turl = ./nested.git\n');
    git('add', '--', '.gitmodules');
    git('update-index', '--add', '--cacheinfo', '160000,' + submoduleHeadSha + ',modules/nested');
    git('commit', '-q', '-m', 'add nested submodule');
    const closeHeadSha = git('rev-parse', 'HEAD');

    writeFileSync(join(subRoot, 'file.ts'), 'export const value = "close time";\n');
    const supersededSha = subGit('hash-object', 'file.ts');
    subGit('add', '--', 'file.ts');
    subGit('commit', '-q', '-m', 'commit close-time submodule blob');
    writeFileSync(join(subRoot, 'file.ts'), 'export const value = "later content";\n');
    subGit('add', '--', 'file.ts');
    subGit('commit', '-q', '-m', 'supersede submodule blob');
    const emittedSubmoduleSha = subGit('rev-parse', 'HEAD');
    git('update-index', '--cacheinfo', '160000,' + emittedSubmoduleSha + ',modules/nested');
    git('commit', '-q', '-m', 'advance submodule pointer');
    const emittedSha = git('rev-parse', 'HEAD');

    expect(
      await completionBlobHistoryContains(
        root,
        closeHeadSha,
        emittedSha,
        'modules/nested/file.ts',
        supersededSha,
      ),
    ).toBe(true);
  });
});

function settlementSql(options: { updateHits: boolean[]; manifest?: unknown }) {
  let updateIndex = 0;
  const payload = {
    [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: options.manifest ?? manifest },
  };
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('SELECT feature_id, harness_slug, payload')) {
      return [{ feature_id: 'WI-42476', harness_slug: 'papercusp', payload }];
    }
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

describe('reconcileProposedCompletionsAtCommit — liveness', () => {
  const scope = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    repositoryRoot: manifest.repositoryRoot,
  };
  const matchingLookup = () =>
    new Map([
      ['a.ts', resolved('d'.repeat(40))],
      ['nested/b.ts', resolved('e'.repeat(40))],
    ]);

  it('reports progress once per candidate, including the inspected total', async () => {
    const onProgress = vi.fn();
    const result = await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql: settlementSql({ updateHits: [true] }),
      lookup: matchingLookup,
      emit: settlementEmitMock(),
      onProgress,
    });

    expect(result.inspected).toBe(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 1, featureId: 'WI-42476' });
  });

  it('stops before a late settlement write when the action signal aborts', async () => {
    const controller = new AbortController();
    const sql = settlementSql({ updateHits: [true] });
    const lookup = vi.fn(async () => {
      controller.abort(new Error('settlement timeout'));
      return matchingLookup();
    });
    const onProgress = vi.fn();

    await expect(
      reconcileProposedCompletionsAtCommit(SHA, scope, {
        sql,
        lookup,
        emit: settlementEmitMock(),
        signal: controller.signal,
        onProgress,
      }),
    ).rejects.toThrow('settlement timeout');

    expect(
      vi
        .mocked(sql)
        .mock.calls.some(([strings]) =>
          (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'),
        ),
    ).toBe(false);
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 1, featureId: 'WI-42476' });
  });
});

describe('reconcileProposedCompletionsAtCommit — WI-1053550 treeStamp refresh', () => {
  const scope = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    repositoryRoot: manifest.repositoryRoot,
  };
  const matchingLookup = () => new Map([
    ['a.ts', resolved('d'.repeat(40))],
    ['nested/b.ts', resolved('e'.repeat(40))],
  ]);

  it('refreshes treeStamp.contentIdentity so the upgrade proves under the migration-972 floor', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [true] });

    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, lookup: matchingLookup, emit });

    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    const nextPayload = updateCall?.[1] as unknown as Record<string, unknown>;
    const evidence = nextPayload[TERMINAL_COMPLETION_EVIDENCE_KEY] as {
      treeStamp?: { headSha: string; repositoryRoot: string; contentIdentity: Array<{
        path: string; workingTreeBlobSha: string | null; headBlobSha: string | null;
      }> };
    };

    // This is the exact predicate migration 972's completion_authority_floor_trg
    // (and its TS mirror completionTreeContentIdentityMatches) requires — proving
    // it here is proving the upgrade this reconciler just wrote SURVIVES the trigger
    // instead of being downgraded straight back to 'proposed' on the same write.
    expect(evidence.treeStamp).toBeDefined();
    expect(evidence.treeStamp!.headSha).toBe(SHA);
    expect(evidence.treeStamp!.repositoryRoot).toBe(manifest.repositoryRoot);
    expect(evidence.treeStamp!.contentIdentity).toHaveLength(2);
    for (const entry of evidence.treeStamp!.contentIdentity) {
      expect(entry.workingTreeBlobSha).not.toBeNull();
      expect(entry.headBlobSha).toBe(entry.workingTreeBlobSha);
    }
  });

  it('does NOT write a treeStamp for a partial/residual reconciliation (nothing to prove yet)', async () => {
    const emit = settlementEmitMock();
    const sql = settlementSql({ updateHits: [true] });

    await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      lookup: () => new Map([['a.ts', resolved('f'.repeat(40))]]),
      emit,
    });

    const updateCall = vi.mocked(sql).mock.calls.find(([strings]) =>
      (strings as unknown as TemplateStringsArray).join('?').includes('UPDATE harness_shared.work_items'));
    const nextPayload = updateCall?.[1] as unknown as Record<string, unknown>;
    const evidence = nextPayload[TERMINAL_COMPLETION_EVIDENCE_KEY] as Record<string, unknown>;
    expect(evidence.treeStamp).toBeUndefined();
  });
});

describe('reconcileProposedCompletionsAtCommit — P-004 settled event', () => {
  const scope = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    repositoryRoot: manifest.repositoryRoot,
  };
  const matchingLookup = () => new Map([
    ['a.ts', resolved('d'.repeat(40))],
    ['nested/b.ts', resolved('e'.repeat(40))],
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
      lookup: () => new Map([['a.ts', resolved('f'.repeat(40))]]),
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

  it('selects by emitted checkout root and settles a row owned by another harness', async () => {
    const portalRoot = '/workspace/apps/portal';
    const crossHarnessManifest = { ...manifest, repositoryRoot: portalRoot };
    const payload = {
      [TERMINAL_COMPLETION_EVIDENCE_KEY]: { settlementManifest: crossHarnessManifest },
    };
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('SELECT feature_id, harness_slug, payload')) {
        expect(query).not.toContain('AND harness_slug =');
        expect(values).toContain(portalRoot);
        return [{ feature_id: 'WI-CROSS-HIVE', harness_slug: 'papercusp', payload }];
      }
      if (query.includes('UPDATE harness_shared.work_items')) {
        expect(values).toContain('papercusp');
        expect(values).toContain(portalRoot);
        return [{ feature_id: 'WI-CROSS-HIVE' }];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }) as unknown as ReturnType<typeof import('@papercusp/db-org').getOrgPg>['sql'];
    (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
    const emit = settlementEmitMock();

    const result = await reconcileProposedCompletionsAtCommit(SHA, {
      installSlug: 'portal',
      workspaceId: 'papercusp-workspace',
      repositoryRoot: portalRoot,
    }, { sql, lookup: matchingLookup, emit });

    expect(result).toMatchObject({ inspected: 1, upgraded: ['WI-CROSS-HIVE'], residual: 0 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: 'work-item:settled:WI-CROSS-HIVE',
      payload: expect.objectContaining({ harness: 'papercusp', commitSha: SHA }),
    }));
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
      if (query.includes('SELECT feature_id, harness_slug, payload')) {
        return authority === 'proposed'
          ? [{ feature_id: 'WI-FIXTURE', harness_slug: 'papercusp', payload }]
          : [];
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
    const scope = {
      installSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      repositoryRoot: root,
    };

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

describe('normalizeStoredSettlementManifest — WI-1409142 stripped-null tolerance', () => {
  /**
   * The exact on-disk shape a recursive `jsonb_strip_nulls` produced: the null-valued
   * key is GONE, not null. `CompletionSettlementManifestSchema` requires it, so before
   * this fix every function below returned undefined and the reconciler skipped the
   * row in silence — permanently, since no later commit can restore a key.
   */
  const stripped = {
    ...manifest,
    contentIdentity: [
      { path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40) },
      { path: 'nested/b.ts', workingTreeBlobSha: 'e'.repeat(40) },
    ],
  };

  it('settles a stripped manifest whose blobs are all present in the commit', async () => {
    expect(
      await residualPathsForCommit(
        stripped,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('d'.repeat(40))],
            ['nested/b.ts', resolved('e'.repeat(40))],
          ]),
      ),
    ).toEqual([]);
  });

  it('still reports honest residue for a stripped manifest that does not match', async () => {
    expect(
      await residualPathsForCommit(
        stripped,
        SHA,
        () =>
          new Map([
            ['a.ts', resolved('d'.repeat(40))],
            ['nested/b.ts', resolved('f'.repeat(40))],
          ]),
      ),
    ).toEqual([{ path: 'nested/b.ts', reason: 'content-mismatch' }]);
  });

  it('fills ONLY a missing key — an explicit null and a real sha both survive', () => {
    const out = normalizeStoredSettlementManifest({
      contentIdentity: [
        { path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40) },
        { path: 'b.ts', workingTreeBlobSha: null, headBlobSha: 'e'.repeat(40) },
      ],
    }) as { contentIdentity: Record<string, unknown>[] };
    expect(out.contentIdentity[0]).toEqual({
      path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null,
    });
    expect(out.contentIdentity[1]).toEqual({
      path: 'b.ts', workingTreeBlobSha: null, headBlobSha: 'e'.repeat(40),
    });
  });

  it('leaves a value that is not a manifest untouched', () => {
    expect(normalizeStoredSettlementManifest(null)).toBeNull();
    expect(normalizeStoredSettlementManifest('nope')).toBe('nope');
    expect(normalizeStoredSettlementManifest({ contentIdentity: 'nope' }))
      .toEqual({ contentIdentity: 'nope' });
  });
});
