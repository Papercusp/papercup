/**
 * fetch-transport unit tests — the §5.3 scope-repo serve chokepoint (P-108 /
 * D-018 option b): a path in the scopes/ family is UNSERVABLE without a
 * gate-issued grant bound to that exact path. Refusals resolve pre-spawn
 * (code -1) with the reason in stderr; a genuine grant opens the gate.
 * (Full serve/fetch byte-stream coverage lives in
 * fetch-transport.integration.test.ts — this file only exercises the guard.)
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { serveUploadPack } from './fetch-transport';
import { scopeRepoPath, type ScopeId } from './scope-repo';
import { authorizeScopeRepoServe } from './scope-serve-gate';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 9603, slug: 'p006-rig-fleet' };
const PEER = 279242982;
const REFUSAL_MARK = 'roster-verified serve grant';

const OLD_ROOT = process.env.PAPERCUSP_HIVE_GIT_ROOT;
let tmpRoot: string | null = null;
afterEach(() => {
  if (OLD_ROOT === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
  else process.env.PAPERCUSP_HIVE_GIT_ROOT = OLD_ROOT;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

function freshRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hg-serve-gate-'));
  process.env.PAPERCUSP_HIVE_GIT_ROOT = tmpRoot;
  return tmpRoot;
}

describe('serveUploadPack — scope-repo serve gate', () => {
  it('refuses a scope-family path with NO grant (pre-spawn, code -1)', async () => {
    freshRoot();
    const res = await serveUploadPack(scopeRepoPath('my-hive', SCOPE), new PassThrough());
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('refuses a MALFORMED path inside the scopes/ family (gate is broader than the parse)', async () => {
    const root = freshRoot();
    const res = await serveUploadPack(
      join(root, 'my-hive', 'scopes', 'oops', 'x.git'),
      new PassThrough(),
    );
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('refuses a forged grant object (right fields, wrong mint)', async () => {
    freshRoot();
    const repoPath = scopeRepoPath('my-hive', SCOPE);
    const res = await serveUploadPack(repoPath, new PassThrough(), {
      scopeServeGrant: { repoPath, scopeId: 'fleet:9603/p006-rig-fleet', peerGithubUserId: PEER },
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('refuses a genuine grant bound to a DIFFERENT scope repo', async () => {
    freshRoot();
    const other = await authorizeScopeRepoServe({
      repoPath: scopeRepoPath('my-hive', { kind: 'fleet', ownerGithubUserId: 9603, slug: 'other' }),
      peerGithubUserId: PEER,
      isScopeMember: () => true,
    });
    if (!other.ok) throw new Error('setup grant failed');
    const res = await serveUploadPack(scopeRepoPath('my-hive', SCOPE), new PassThrough(), {
      scopeServeGrant: other.grant,
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('a genuine matching grant passes the gate (any failure is from git, not the guard)', async () => {
    freshRoot();
    const repoPath = scopeRepoPath('my-hive', SCOPE);
    const d = await authorizeScopeRepoServe({
      repoPath,
      peerGithubUserId: PEER,
      isScopeMember: () => true,
    });
    if (!d.ok) throw new Error('grant refused in setup');
    const duplex = new PassThrough();
    duplex.end(); // repo does not exist — upload-pack exits on its own
    const res = await serveUploadPack(repoPath, duplex, { scopeServeGrant: d.grant });
    expect(res.stderr).not.toContain(REFUSAL_MARK);
  });

  it('a NON-scope repo under the root serves without any grant (gate does not over-trigger)', async () => {
    const root = freshRoot();
    const duplex = new PassThrough();
    duplex.end();
    const res = await serveUploadPack(join(root, 'my-hive', 'repo.git'), duplex);
    expect(res.stderr).not.toContain(REFUSAL_MARK);
  });
});
