/**
 * Unit tests for the server-side file-lock guard (P-013, B-05). Mocks the PG
 * lock store so the CONTROL FLOW is deterministic without a database: acquire →
 * run → release on success; busy → no body run; infra fault → fail-open (run);
 * uncoordinated path → no lock at all. The actual acquire/release SQL is the
 * same `tryAcquire`/`tryRelease` `locks:acquire` already uses in production.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tryAcquire: vi.fn(),
  tryRelease: vi.fn(),
  readIdentity: vi.fn(() => ({ ownerId: 'owner-1', ownerLabel: 'Owner', coordinationDomain: '/dom' })),
}));

vi.mock('./su-lock-store', () => ({
  normalizePaths: (p: string[]) => p,
  tryAcquire: h.tryAcquire,
  tryRelease: h.tryRelease,
}));
vi.mock('./identity', () => ({ readIdentity: h.readIdentity }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: (_cd: string, _owner: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('./enrich-busy', () => ({ enrichBusy: async (rows: unknown[]) => rows }));

import { guardFileLock, toRepoRelative, withFileLock, fileLockedResult } from './file-lock-guard';

const REPO = mkdtempSync(join(tmpdir(), 'flg-repo-'));
mkdirSync(join(REPO, '.git'));
const NO_REPO = mkdtempSync(join(tmpdir(), 'flg-norepo-'));
const ctx = { projectDir: REPO, log: () => {} } as never;

beforeEach(() => {
  h.tryAcquire.mockReset();
  h.tryRelease.mockReset().mockResolvedValue({ released: ['foo.ts'] });
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
  it('acquires, runs the body, and releases on success', async () => {
    h.tryAcquire.mockResolvedValue({ ok: true, lock_id: 'L1', expires_ts: new Date(), held: ['foo.ts'] });
    const run = vi.fn().mockResolvedValue('RESULT');
    const out = await guardFileLock(ctx, ['foo.ts'], { intent: 'capability:write' }, run);
    expect(out).toEqual({ acquired: true, result: 'RESULT' });
    expect(run).toHaveBeenCalledOnce();
    expect(h.tryAcquire).toHaveBeenCalledOnce();
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
    expect(out).toEqual({ acquired: true, result: 'R' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('skips locking entirely for an uncoordinated path', async () => {
    const run = vi.fn().mockResolvedValue('R');
    const out = await guardFileLock({ projectDir: NO_REPO, log: () => {} } as never, ['foo.ts'], { intent: 't' }, run);
    expect(out).toEqual({ acquired: true, result: 'R' });
    expect(h.tryAcquire).not.toHaveBeenCalled();
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
