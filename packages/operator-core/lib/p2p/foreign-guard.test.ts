/**
 * foreign-guard.test.ts — P-109 leg (i): the registry-derived worktree-guard
 * policy (design §2). Pure policy over injected seams; the §6 acceptance
 * "guard matrix" rows are the spine:
 *   - foreign session denied outside its root
 *   - host denied inside a foreign root
 *   - foreign session with no registry row denied EVERYWHERE (fail-closed)
 */
import { describe, expect, it } from 'vitest';
import { evaluateForeignGuard } from './foreign-guard';
import type { ForeignRootEntry, ForeignWorkspace } from './foreign-workspaces';

const ROOT = '/home/host/.papercusp/foreign-work/gh-777/offer-abc';
const row = (over: Partial<ForeignWorkspace> = {}): ForeignWorkspace => ({
  workspaceId: 'ws-1',
  offerId: 'offer-abc',
  fleetSlug: 'gh-777/widgets',
  originGithubUserId: 777,
  executorDevice: 'ab12cd34',
  rootPath: ROOT,
  clonePath: `${ROOT}/repo`,
  sessionId: 'sess-token-1',
  executionEpoch: 1,
  state: 'active',
  parkReason: null,
  baseSha: null,
  ...over,
});
const roots: ForeignRootEntry[] = [
  { offerId: 'offer-abc', rootPath: ROOT, workspaceId: 'ws-1', fleetSlug: 'gh-777/widgets', state: 'active' },
];
const seams = (r: ForeignWorkspace | null, rs: ForeignRootEntry[] = roots) => ({
  getByOffer: async () => r,
  listRoots: async () => rs,
});

describe('host direction', () => {
  it('denies a host edit inside a foreign root, naming the offer id (M21)', async () => {
    const v = await evaluateForeignGuard(
      { paths: [`${ROOT}/repo/src/x.ts`] },
      seams(null),
    );
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') {
      expect(v.reason).toContain('offer-abc');
      expect(v.refusalCode).toBe('foreign_guard_host_edit_in_foreign_root');
      expect(v.workspaceId).toBe('ws-1');
    }
  });

  it('allows host edits everywhere else and returns the cacheable roots', async () => {
    const v = await evaluateForeignGuard({ paths: ['/home/host/papercupai-workspace/papercusp/a.ts'] }, seams(null));
    expect(v.decision).toBe('allow');
    expect(v.roots).toEqual([{ offerId: 'offer-abc', rootPath: ROOT }]);
  });

  it('a prefix-sibling dir does NOT match (path-segment boundary, not startsWith)', async () => {
    const v = await evaluateForeignGuard({ paths: [`${ROOT}-sibling/x.ts`] }, seams(null));
    expect(v.decision).toBe('allow');
  });
});

describe('foreign-marked session direction (fail-closed)', () => {
  it('no registry row → denied everywhere', async () => {
    const v = await evaluateForeignGuard(
      { paths: [`${ROOT}/repo/src/x.ts`], offerId: 'offer-abc', sessionId: 'sess-token-1' },
      seams(null),
    );
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') expect(v.refusalCode).toBe('foreign_guard_no_registry_row');
  });

  it('session token mismatch → denied (env is never trusted alone)', async () => {
    const v = await evaluateForeignGuard(
      { paths: [`${ROOT}/repo/src/x.ts`], offerId: 'offer-abc', sessionId: 'WRONG' },
      seams(row()),
    );
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') expect(v.refusalCode).toBe('foreign_guard_session_mismatch');
  });

  it('missing sessionId on the row → denied (unbound row is not live)', async () => {
    const v = await evaluateForeignGuard(
      { paths: [`${ROOT}/repo/x.ts`], offerId: 'offer-abc', sessionId: 'sess-token-1' },
      seams(row({ sessionId: null })),
    );
    expect(v.decision).toBe('deny');
  });

  it('wound-down workspace state → denied', async () => {
    const v = await evaluateForeignGuard(
      { paths: [`${ROOT}/repo/x.ts`], offerId: 'offer-abc', sessionId: 'sess-token-1' },
      seams(row({ state: 'winding-down' })),
    );
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') expect(v.refusalCode).toBe('foreign_guard_workspace_not_live');
  });

  it('edit outside its own root → denied, naming the offender', async () => {
    const v = await evaluateForeignGuard(
      {
        paths: [`${ROOT}/repo/ok.ts`, '/home/host/papercupai-workspace/papercusp/CANONICAL.ts'],
        offerId: 'offer-abc',
        sessionId: 'sess-token-1',
      },
      seams(row()),
    );
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') {
      expect(v.refusalCode).toBe('foreign_guard_outside_registered_root');
      expect(v.reason).toContain('CANONICAL.ts');
    }
  });

  it('sibling foreign workspace → denied too (only its OWN root)', async () => {
    const v = await evaluateForeignGuard(
      { paths: ['/home/host/.papercusp/foreign-work/gh-888/offer-zzz/repo/x.ts'], offerId: 'offer-abc', sessionId: 'sess-token-1' },
      seams(row()),
    );
    expect(v.decision).toBe('deny');
  });

  it('edits inside its registered root while live → allowed', async () => {
    const v = await evaluateForeignGuard(
      { paths: [`${ROOT}/repo/src/feature.ts`, `${ROOT}/notes.md`], offerId: 'offer-abc', sessionId: 'sess-token-1' },
      seams(row()),
    );
    expect(v.decision).toBe('allow');
  });

  it('provisioning state is live enough (spawn writes files pre-bind)', async () => {
    const v = await evaluateForeignGuard(
      { paths: [`${ROOT}/repo/x.ts`], offerId: 'offer-abc', sessionId: 'sess-token-1' },
      seams(row({ state: 'provisioning' })),
    );
    expect(v.decision).toBe('allow');
  });
});
