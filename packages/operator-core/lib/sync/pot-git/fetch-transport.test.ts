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
import { Duplex, PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { serveUploadPack, fetchOverDuplex } from './fetch-transport';
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

/**
 * WI-6184: the fetch timeout message must be SELF-DIAGNOSING.
 *
 * A bare "fetch timed out after 120000ms" cannot distinguish the two failures
 * that produce it, and they have OPPOSITE causes:
 *   peer→us 0B   ⇒ the serving side answered NOTHING (a swallowed throw, a
 *                  refusal that never sent its frame, a req never received) —
 *                  investigate the PEER.
 *   peer→us > 0  ⇒ the peer answered and the stream then stalled — investigate
 *                  the TRANSPORT.
 * On the 2-machine rig every cold-join burned the full 120s ceiling reporting
 * only the bare form, which is why the cause stayed invisible across five
 * diagnosis wakes. This asserts the forensic tail is present and correct.
 *
 * A LIVE-but-silent duplex is the deliberate fixture: it must NOT be destroyed
 * (that path fail-fasts by design and would never reach the ceiling), so the
 * write callback is invoked while nothing is ever pushed back. `timedOut` is
 * asserted UNCONDITIONALLY — an `if (res.timedOut)` guard here would let the
 * test pass vacuously if the fetch ever stopped timing out.
 */
describe('fetchOverDuplex — timeout forensics', () => {
  it('names what it was waiting on when a live-but-silent peer never answers', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'hg-fetch-timeout-'));
    try {
      execFileSync('git', ['init', '--quiet', '--bare', repo]);
      // Alive, writable, never readable: the peer that accepts our request and
      // says nothing back.
      const silent = new Duplex({
        read() {},
        write(_chunk, _enc, cb) {
          cb();
        },
      });
      const res = await fetchOverDuplex(repo, silent, ['+refs/heads/work:refs/heads/never'], {
        timeoutMs: 4_000,
      });
      expect(res.timedOut, `expected the ceiling to fire; got: ${res.stderr}`).toBe(true);
      expect(res.code).toBe(-1);
      // The forensic tail — each field, so a partial regression is caught.
      expect(res.stderr).toMatch(/fetch timed out after 4000ms/);
      expect(res.stderr).toMatch(/us→peer \d+B/);
      expect(res.stderr).toMatch(/bridge=(yes|no)/);
      expect(res.stderr).toMatch(/gitChild=(spawned|none)/);
      // The load-bearing assertion: this peer sent nothing, and the message
      // must say so rather than leaving the reader to guess.
      expect(res.stderr).toMatch(/peer→us 0B/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

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

describe('fetchOverDuplex — pre-destroyed duplex (WI-3496)', () => {
  it('fails fast (code -1) on an already-destroyed duplex instead of hanging to the ceiling', async () => {
    // The openHiveGitDuplexToDevice "no live dial path" contract hands callers
    // a duplex whose 'error' already fired into its own no-op listener ticks
    // before fetchOverDuplex could attach one — the sync .destroyed check must
    // catch it, or the fetch burns the full outer timeout (live-observed 120s
    // per G-8 bootstrap tick on the rig).
    const { fetchOverDuplex } = await import('./fetch-transport');
    const dead = new PassThrough();
    dead.on('error', () => {});
    dead.destroy(new Error('no live connection to device xyz'));
    const started = Date.now();
    const res = await fetchOverDuplex('/nonexistent/repo.git', dead, ['+refs/*:refs/*'], {
      timeoutMs: 10_000,
    });
    expect(res.code).toBe(-1);
    expect(res.timedOut).toBe(false);
    expect(res.stderr).toContain('duplex already destroyed before fetch began');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
