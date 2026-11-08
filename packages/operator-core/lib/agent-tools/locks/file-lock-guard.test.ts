/**
 * Unit tests for the server-side file-lock guard (P-013, B-05). Mocks the PG
 * lock store so the CONTROL FLOW is deterministic without a database: acquire →
 * run → release on success; busy → no body run; infra fault → fail-open (run);
 * uncoordinated path → no lock at all. The actual acquire/release SQL is the
 * same `tryAcquire`/`tryRelease` `locks:acquire` already uses in production.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkNonRepoTmpDir } from './non-repo-tmpdir';

const h = vi.hoisted(() => ({
  tryAcquire: vi.fn(),
  tryRelease: vi.fn(),
  tryFinish: vi.fn(),
  preserve: vi.fn(),
  attribute: vi.fn(),
  readIdentity: vi.fn(() => ({ ownerId: 'owner-1', ownerLabel: 'Owner', coordinationDomain: '/dom' })),
}));

vi.mock('./su-lock-store', () => ({
  normalizePaths: (p: string[]) => p,
  tryAcquire: h.tryAcquire,
  tryRelease: h.tryRelease,
  tryFinishHookOperation: h.tryFinish,
}));
vi.mock('../../edit-attribution', () => ({ preserveEditGeneration: h.preserve, recordEditAttributionStrict: h.attribute }));
// WI-38252: the guard resolves its domain via readFileLockIdentity (the tree
// agents EDIT) so it cannot disagree with locks:acquire. Same stub for both.
vi.mock('./identity', () => ({ readIdentity: h.readIdentity, readFileLockIdentity: h.readIdentity }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: (_cd: string, _owner: string, fn: (tx: unknown) => unknown) => fn({}),
}));
// NB: we deliberately do NOT mock './enrich-busy' — acquire-enrich.test.ts
// imports the REAL module, and a leaked mock across files (vitest non-isolated
// pool) would break it (4605e). The real enrichBusy is safe here: it wraps
// getPresence in `.catch(() => null)`, so a busy row just passes through
// un-enriched, which is all these assertions check.

import { guardFileLock, toRepoRelative, withFileLock, fileLockedResult } from './file-lock-guard';

// REPO creates its OWN `.git`, so findRepoRoot stops at it regardless of where
// tmpdir() lives. NO_REPO must have NO `.git` ancestor, so it uses
// mkNonRepoTmpDir (a bare os.tmpdir() temp dir inherits the monorepo `.git` when
// the runner's TMPDIR is in-repo — EI-5826/EI-5541 — which would make the
// "uncoordinated path" test wrongly hit the lock store).
const REPO = mkdtempSync(join(tmpdir(), 'flg-repo-'));
mkdirSync(join(REPO, '.git'));
writeFileSync(join(REPO, '.git', 'HEAD'), 'ref: refs/heads/main\n'); // a VALID git dir needs HEAD (valid-git-entry.ts)
const NO_REPO = mkNonRepoTmpDir('flg-norepo-');
const ctx = { projectDir: REPO, log: () => {} } as never;

beforeEach(() => {
  h.tryAcquire.mockReset();
  h.tryRelease.mockReset().mockResolvedValue({ released: ['foo.ts'] });
  h.preserve.mockReset().mockResolvedValue({ pending: true, capture: 'A1' });
  h.attribute.mockReset().mockResolvedValue(undefined);
  h.tryFinish.mockReset().mockImplementation(async (_tx, p) => {
    const grant = await h.tryAcquire.mock.results.at(-1)?.value;
    await p.beforeRelease?.({ requestedPaths: p.paths, goalRef: null, state: 'granted' });
    if ((grant?.newly_held ?? p.paths).length) await h.tryRelease();
    return { ok: true, released: grant?.newly_held ?? p.paths, state: p.outcome };
  });
});

describe('toRepoRelative', () => {
  it('maps an in-repo path to its repo-relative form', () => {
    expect(toRepoRelative(join(REPO, 'a/b.ts'), REPO)).toBe('a/b.ts');
  });
  it('returns null for a path outside any repo', () => {
    expect(toRepoRelative('/definitely/not/a/repo/x.ts', REPO)).toBeNull();
  });
  it('returns null for the repo root itself', () => {
    expect(toRepoRelative(REPO, REPO)).toBeNull();
  });
});

describe('guardFileLock', () => {
  it('never runs the next writer when predecessor preservation refuses, even without failClosed', async () => {
    h.tryAcquire.mockRejectedValue(Object.assign(new Error('predecessor custody unavailable'), {
      reason: 'file_lock_preservation_failed',
    }));
    const run = vi.fn();
    expect(await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, run))
      .toMatchObject({ acquired: false, lockUnavailable: true, error: 'predecessor custody unavailable' });
    expect(run).not.toHaveBeenCalled();
    expect(h.tryFinish).not.toHaveBeenCalled();
  });

  it('acquires, runs the body, and releases on success', async () => {
    h.tryAcquire.mockResolvedValue({ ok: true, lock_id: 'L1', expires_ts: new Date(), held: ['foo.ts'] });
    const run = vi.fn().mockResolvedValue('RESULT');
    const out = await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, run);
    // `coordinated: true` is the load-bearing half: it reports that locking
    // ACTUALLY happened, so a caller can never assume coordination it did not get.
    expect(out).toEqual({ acquired: true, result: 'RESULT', coordinated: true });
    expect(run).toHaveBeenCalledOnce();
    expect(h.tryAcquire).toHaveBeenCalledOnce();
    expect(h.tryRelease).toHaveBeenCalledOnce();
  });

  it('does not release a deliberate same-owner hold when no paths were newly acquired', async () => {
    h.tryAcquire.mockResolvedValue({
      ok: true,
      lock_id: 'manual-lock',
      expires_ts: new Date(),
      held: ['foo.ts'],
      newly_held: [],
    });
    const run = vi.fn().mockResolvedValue('RESULT');
    const out = await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, run);
    // Still coordinated: a lock WAS held (deliberately, by the same owner) — the
    // guard simply released nothing, because it newly acquired nothing.
    expect(out).toEqual({ acquired: true, result: 'RESULT', coordinated: true });
    expect(run).toHaveBeenCalledOnce();
    expect(h.tryRelease).not.toHaveBeenCalled();
  });

  it('preserves the successful result before handing off paths', async () => {
    h.tryAcquire.mockResolvedValue({ ok: true, lock_id: 'L1', held: ['foo.ts'], newly_held: ['foo.ts'] });
    const order: string[] = [];
    h.preserve.mockImplementation(async () => { order.push('capture'); return { pending: true }; });
    h.attribute.mockImplementation(async () => { order.push('attribute'); });
    h.tryRelease.mockImplementation(async () => { order.push('release'); });
    await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, async () => { order.push('edit'); return 'ok'; });
    expect(order).toEqual(['edit', 'capture', 'attribute', 'release']);
  });

  it('keeps the fence and rejects success when immutable preservation fails', async () => {
    h.tryAcquire.mockResolvedValue({ ok: true, lock_id: 'L1', held: ['foo.ts'] });
    h.preserve.mockRejectedValue(new Error('custody unreadable'));
    await expect(guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, async () => 'written'))
      .rejects.toThrow('custody unreadable');
    expect(h.tryFinish).toHaveBeenCalledOnce();
    expect(h.tryRelease).not.toHaveBeenCalled();
    expect(h.attribute).not.toHaveBeenCalled();
  });

  it('cancels a refused edit without inventing a successful capture', async () => {
    h.tryAcquire.mockResolvedValue({ ok: true, lock_id: 'L1', held: ['foo.ts'] });
    const refusal = { content: [{ type: 'text', text: JSON.stringify({ ok: false }) }] };
    await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, async () => refusal);
    expect(h.tryFinish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'cancelled' }));
    expect(h.preserve).not.toHaveBeenCalled();
    expect(h.tryRelease).toHaveBeenCalledOnce();
  });

  it('does NOT run the body on contention', async () => {
    h.tryAcquire.mockResolvedValue({
      ok: false,
      busy: [{ path: 'foo.ts', owner: 'other', owner_label: 'Other', intent: 'i', expires_ts: new Date() }],
    });
    const run = vi.fn();
    const out = await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, run);
    expect(out.acquired).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(h.tryRelease).not.toHaveBeenCalled();
  });

  it('fails open (runs the body) when acquire throws', async () => {
    h.tryAcquire.mockRejectedValue(new Error('pg down'));
    const run = vi.fn().mockResolvedValue('R');
    const out = await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, run);
    // FAIL-OPEN: the body ran, but nothing was locked — `coordinated: false` is
    // what stops a caller reading this as a guarded write.
    expect(out).toEqual({ acquired: true, result: 'R', coordinated: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it('skips locking entirely for an uncoordinated path', async () => {
    const run = vi.fn().mockResolvedValue('R');
    const out = await guardFileLock({ projectDir: NO_REPO, log: () => {} } as never, ['foo.ts'], { intent: 't' }, run);
    expect(out).toEqual({ acquired: true, result: 'R', coordinated: false });
    expect(h.tryAcquire).not.toHaveBeenCalled();
  });
});

/**
 * EI-20881501070735530 — a RELATIVE path must key off the same base dir the capability
 * tool writes through, or the lock guards a file nobody is touching.
 *
 * The guard used `ctx.projectDir ?? process.cwd()`. A superuser ctx has no projectDir,
 * so relative paths resolved against the :3070 operator's own cwd — the release
 * checkout's `apps/operator/` subdir — while `capability:write`/`edit` resolved the file
 * itself through `resolveCapabilityBaseDir`. Measured on the live tree:
 * `packages/…/git.ts` was locked as `apps/operator/packages/…/git.ts`, a key neither a
 * peer nor the PreToolUse hook ever takes. The write still landed on the right file, so
 * nothing looked wrong — arbitration just stopped happening.
 *
 * ⚠ THIS TEST IS ONLY MEANINGFUL BECAUSE THE BASE DIR IS A REPO SUBDIR. Under vitest,
 * `process.cwd()` is already the monorepo root, so a base dir AT a repo root produces
 * the identical key either way and the assertion passes with the bug present — the exact
 * blind spot base-dir.ts's own header warns about. The nested base dir is what makes the
 * two resolutions disagree, mirroring the real `apps/operator/` prefix.
 */
describe('EI-20881501070735530 — relative paths key off the capability base dir, not the operator cwd', () => {
  const origEnv = process.env.PAPERCUSP_INTEGRATION_ROOT;
  const NESTED = join(realpathSync(REPO), 'apps', 'operator');

  beforeEach(() => {
    mkdirSync(NESTED, { recursive: true });
    process.env.PAPERCUSP_INTEGRATION_ROOT = NESTED;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = origEnv;
  });

  /** The paths handed to the lock store on the last acquire. */
  const acquiredPaths = (): string[] => h.tryAcquire.mock.calls[0]?.[1]?.paths as string[];

  it('resolves a relative path against the capability base dir (superuser ctx: no projectDir)', async () => {
    h.tryAcquire.mockResolvedValue({ ok: true, lock_id: 'L', expires_ts: new Date(), held: [] });
    const suCtx = { log: () => {} } as never; // projectDir deliberately absent
    await guardFileLock(suCtx, ['pkg/a.ts'], { intent: 'capability:write' }, async () => 'R');
    expect(acquiredPaths()).toEqual(['apps/operator/pkg/a.ts']);
  });

  it('CONTROL: the same call keyed off the monorepo cwd would produce a different key', () => {
    // The pre-fix resolution, computed directly. If this ever equals the assertion above,
    // the test has gone vacuous (base dir no longer differs from cwd) and must be re-based.
    expect(toRepoRelative('pkg/a.ts', process.cwd())).not.toEqual('apps/operator/pkg/a.ts');
  });

  it('an ABSOLUTE path is unaffected by either base dir (why this went unseen)', async () => {
    h.tryAcquire.mockResolvedValue({ ok: true, lock_id: 'L', expires_ts: new Date(), held: [] });
    const suCtx = { log: () => {} } as never;
    await guardFileLock(suCtx, [join(realpathSync(REPO), 'pkg/a.ts')], { intent: 'capability:write' }, async () => 'R');
    expect(acquiredPaths()).toEqual(['pkg/a.ts']);
  });
});

describe('withFileLock + fileLockedResult', () => {
  it('returns the structured file_locked result on contention without running the handler', async () => {
    h.tryAcquire.mockResolvedValue({
      ok: false,
      busy: [{ path: 'foo.ts', owner: 'other', owner_label: 'Other', intent: 'i', expires_ts: new Date() }],
    });
    const handler = vi.fn();
    const wrapped = withFileLock<{ file_path: string }, typeof ctx>(
      { intent: 'capability:write' },
      (a) => [a.file_path],
      handler,
    );
    const r = (await wrapped({ file_path: 'foo.ts' }, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
    expect(handler).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.reason).toBe('file_locked');
    expect(body.busy[0].path).toBe('foo.ts');
  });

  it('fileLockedResult shape', async () => {
    const r = await fileLockedResult([{ path: 'x.ts', owner: 'o', owner_label: null, intent: 'i', expires_ts: new Date() }]);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).reason).toBe('file_locked');
  });
});

describe('guardFileLock — EI-1720 / worker-fire-path contention retry', () => {
  it('retries a transient pg-57014 contention before failing open (ACQUIRES, not fail-open)', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      h.tryAcquire.mockImplementation(async () => {
        if (n++ < 1) {
          throw Object.assign(new Error('workspace contended'), { name: 'WorkspaceContendedError', pgCode: '57014' });
        }
        return { ok: true, lock_id: 'L1', expires_ts: new Date(), held: ['foo.ts'] };
      });
      const run = vi.fn(async () => 'R');
      const p = guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, run);
      await vi.runAllTimersAsync(); // advance the backoff sleep
      const out = await p;
      // `coordinated: true` states the same thing the tryRelease assertion below
      // proves structurally: this path really ACQUIRED, it did not fail open.
      expect(out).toEqual({ acquired: true, result: 'R', coordinated: true });
      expect(h.tryAcquire).toHaveBeenCalledTimes(2); // retried once, then acquired
      expect(h.tryRelease).toHaveBeenCalledOnce();    // released after a real acquire → proves NOT fail-open
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
