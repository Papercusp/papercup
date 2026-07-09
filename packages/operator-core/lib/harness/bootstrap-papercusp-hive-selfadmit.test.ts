/**
 * EI-8793 — the release-install self-improvement loop's commit leg.
 *
 * A packaged install self-admits the canonical papercusp hive with the seeded
 * clone as its registry entry. Two things make that clone git-syncable (and
 * were MISSING on the 0.0.3 Mac install, where agent edits stranded
 * uncommitted forever):
 *
 *   1. `defaultSelfAdmitCanonical` marks the entry `self_repo: true` — the flag
 *      git-sync eligibility + the boot reconcile key on (`remote_hive` alone
 *      reads as a repo-less view and is skipped).
 *   2. `seedCanonicalCloneGitSyncRoutine` (fired when the deferred git seed
 *      lands) seeds the joiner-side routine on FIRST boot, without waiting for
 *      the next restart's reconcile sweep.
 *
 * Focused file (cf. bootstrap-papercusp-hive-seed-flag.test.ts) so the mocks
 * here never leak into the big seam-driven bootstrap suite.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// defaultSelfAdmitCanonical lazy-imports these two; override ONLY the verbs it
// calls (importOriginal keeps the rest real for the module graph).
const mutateMock = vi.fn(
  async (
    mutator: (cur: { projects: Array<Record<string, unknown>> }) => {
      projects: Array<Record<string, unknown>>;
    },
    _ws: string,
  ) => mutator({ projects: [] }),
);
vi.mock('../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mutateHarnessRegistry: (...a: unknown[]) => mutateMock(a[0] as never, a[1] as string),
}));
const upsertIdentityMock = vi.fn(async () => undefined);
vi.mock('../hive-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  upsertRemoteHiveIdentity: (..._a: unknown[]) => upsertIdentityMock(),
}));

import {
  defaultSelfAdmitCanonical,
  seedCanonicalCloneGitSyncRoutine,
  seedTargetDirs,
  type BootstrapPapercuspHiveDeps,
} from './bootstrap-papercusp-hive';
import { PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import type { seedGitSyncRoutineForMember } from './git-sync/git-sync-routine';

type SeedFn = typeof seedGitSyncRoutineForMember;

// Redirect the on-disk side effects (defaultSelfAdmitCanonical mkdirs the
// target repo dir) into a throwaway tmp root.
const tmpRoot = mkdtempSync(join(tmpdir(), 'bootstrap-selfadmit-'));
const prevRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
process.env.PAPERCUSP_WORKSPACES_ROOT = tmpRoot;
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
  else process.env.PAPERCUSP_WORKSPACES_ROOT = prevRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  mutateMock.mockClear();
  upsertIdentityMock.mockClear();
});

const invite = { pubkeyBase64: 'pk-canonical' } as Parameters<typeof defaultSelfAdmitCanonical>[0];

describe('defaultSelfAdmitCanonical — the registry entry is git-syncable (EI-8793)', () => {
  it('registers the canonical clone remote_hive + self_repo with the seeded checkout as path', async () => {
    const res = await defaultSelfAdmitCanonical(invite);
    expect(res.state).toBe('admitted');
    expect(mutateMock).toHaveBeenCalledOnce();
    // Re-run the captured mutator against an empty registry and inspect the write.
    const mutator = mutateMock.mock.calls[0][0] as (cur: {
      projects: Array<Record<string, unknown>>;
    }) => { projects: Array<Record<string, unknown>> };
    const written = mutator({ projects: [] }).projects.find((p) => p.slug === PAPERCUSP_HIVE_SLUG)!;
    expect(written).toMatchObject({
      slug: PAPERCUSP_HIVE_SLUG,
      harness_kind: 'hive',
      remote_hive: true,
      // THE flag: without it, git-sync eligibility calls this entry a repo-less
      // remote_hive_view and the reconcile never visits it — the loop is dead.
      self_repo: true,
      hive_pubkey: 'pk-canonical',
      path: seedTargetDirs().targetRepoDir,
    });
  });

  it('upserts over an existing entry without dropping the flags (idempotent re-admit)', async () => {
    await defaultSelfAdmitCanonical(invite);
    const mutator = mutateMock.mock.calls[0][0] as (cur: {
      projects: Array<Record<string, unknown>>;
    }) => { projects: Array<Record<string, unknown>> };
    const out = mutator({
      projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/old', extra_field: 'kept' }],
    }).projects;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ self_repo: true, remote_hive: true, extra_field: 'kept' });
  });
});

describe('seedCanonicalCloneGitSyncRoutine — first-boot loop activation (EI-8793)', () => {
  it('seeds JOINER-side for the canonical clone with the per-install salted cron key', async () => {
    const calls: Array<Parameters<SeedFn>[0]> = [];
    const seedMember = (async (opts: Parameters<SeedFn>[0]) => {
      calls.push(opts);
      return { seeded: true, active: true, push: false, pushReason: 'joiner_side', cron: '0 0 * * * *' };
    }) as SeedFn;
    const record = vi.fn();
    await seedCanonicalCloneGitSyncRoutine(record as BootstrapPapercuspHiveDeps['recordProgress'], {
      seedMember,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workspaceId: PAPERCUSP_WORKSPACE_ID,
      installSlug: PAPERCUSP_HIVE_SLUG,
      joinerSide: true, // this box is a peer — never the origin pusher
      cronKey: `${PAPERCUSP_HIVE_SLUG}:${PAPERCUSP_WORKSPACE_ID}`,
      entry: {
        slug: PAPERCUSP_HIVE_SLUG,
        harness_kind: 'hive',
        remote_hive: true,
        self_repo: true,
        path: seedTargetDirs().targetRepoDir,
      },
    });
    expect(record).toHaveBeenCalledWith('clone', 'running', {
      detail: 'seed: git-sync routine seeded (self-improvement loop active)',
    });
  });

  it('NEVER throws — a spine failure degrades to the boot reconcile backfill', async () => {
    const seedMember = (async () => {
      throw new Error('pg down');
    }) as unknown as SeedFn;
    await expect(
      seedCanonicalCloneGitSyncRoutine(undefined, { seedMember }),
    ).resolves.toBeUndefined();
  });

  it('routine_exists is a quiet no-op (idempotent across restore retries)', async () => {
    const seedMember = (async () => ({ seeded: false as const, reason: 'routine_exists' as const })) as SeedFn;
    const record = vi.fn();
    await seedCanonicalCloneGitSyncRoutine(record as BootstrapPapercuspHiveDeps['recordProgress'], {
      seedMember,
    });
    expect(record).not.toHaveBeenCalled();
  });
});
