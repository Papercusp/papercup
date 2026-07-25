/**
 * publish-guard.integration.test.ts — the own-namespace publish admission
 * gate (G-10, p2p-git-live-activation-2026-07-09 / P-205) against a REAL
 * temp bare repo (git on PATH, no network). Mirrors gc.integration.test.ts's
 * fixture conventions.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/publish-guard.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePotGitRepo } from './storage';
import { checkPublishGuard, describePublishRefusal, resolveIncrementalPublishSha } from './publish-guard';

let commitCounter = 0;

async function commit(repo: string, files: Record<string, string>, parent?: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'pg-commit-'));
  try {
    commitCounter += 1;
    const ts = String(1_700_000_000 + commitCounter);
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: ts,
      GIT_COMMITTER_DATE: ts,
      GIT_INDEX_FILE: join(dir, 'index'),
    };
    for (const [name, content] of Object.entries(files)) {
      const f = join(dir, 'blob');
      await writeFile(f, content, 'utf8');
      const sha = execFileSync('git', ['hash-object', '-w', f], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`], { cwd: repo, env });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
    const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'publish-guard'];
    if (parent) args.push('-p', parent);
    return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('pot-git publish-guard (real bare repo)', () => {
  let root: string;
  let repo: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hivegit-pubguard-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-pubguard', 'repo-1');
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('admits a clean range with new safe content', async () => {
    const base = await commit(repo, { 'f.txt': 'hello' });
    const next = await commit(repo, { 'f.txt': 'hello world', 'g.txt': 'more' }, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: next });
    expect(res.ok).toBe(true);
    expect(res.refusalCode).toBeNull();
    expect(res.secretFindings).toEqual([]);
    expect(res.oversizeBlobs).toEqual([]);
    expect(describePublishRefusal(res)).toBe('publish admitted');
  });

  it('admits a first-ever publish (fromOid: null) judging full reachable history', async () => {
    const base = await commit(repo, { 'first.txt': 'ok' });
    const res = await checkPublishGuard({ repoPath: repo, fromOid: null, toOid: base });
    expect(res.ok).toBe(true);
    expect(res.newObjectCount).toBeGreaterThan(0);
  });

  it('is a no-op admit when the range introduces no new objects', async () => {
    const same = await commit(repo, { 'noop.txt': 'x' });
    const res = await checkPublishGuard({ repoPath: repo, fromOid: same, toOid: same });
    expect(res.ok).toBe(true);
    expect(res.newObjectCount).toBe(0);
  });

  it('refuses a range carrying a secret in new text content', async () => {
    const base = await commit(repo, { 'clean.txt': 'nothing to see' });
    // Built via concatenation (never a literal contiguous token in this source file) — a
    // REAL-shaped AWS access-key-id fed only into an in-memory temp git commit for this
    // test fixture, never a literal secret sitting in the tree.
    const fakeKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const withSecret = await commit(repo, { 'config.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n` }, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: withSecret });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('secrets');
    expect(res.secretFindings.length).toBeGreaterThan(0);
    expect(res.secretFindings[0].rule).toBe('aws-access-key-id');
    expect(describePublishRefusal(res)).toContain('secret(s) found');
  });

  it('refuses a range carrying a blob over the size cap', async () => {
    const base = await commit(repo, { 'ok.txt': 'fine' });
    const withBigBlob = await commit(repo, { 'big.bin': 'placeholder' }, base);
    // Exercise the cap boundary via a deliberately low maxBlobBytes against the (small)
    // tracked blob, rather than committing a real 100MB fixture blob into the test tree.
    const res = await checkPublishGuard({
      repoPath: repo,
      fromOid: base,
      toOid: withBigBlob,
      caps: { maxBlobBytes: 4 }, // 'placeholder' (11 bytes) > 4
    });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('blob-over-cap');
    expect(res.oversizeBlobs.length).toBeGreaterThan(0);
    expect(describePublishRefusal(res)).toContain('oversized blob');
  });

  it('refuses when the new-object count exceeds the flood cap', async () => {
    const base = await commit(repo, { 'seed.txt': 'seed' });
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`f${i}.txt`] = `content-${i}`;
    const next = await commit(repo, files, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: next, caps: { maxNewObjects: 3 } });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('object-flood');
    expect(describePublishRefusal(res)).toContain('exceeds the object-count cap');
  });

  it('refuses when total new bytes exceed the total cap', async () => {
    const base = await commit(repo, { 'seed2.txt': 'seed' });
    const next = await commit(repo, { 'payload.txt': 'x'.repeat(1000) }, base);

    const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: next, caps: { maxTotalNewBytes: 100 } });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('total-over-cap');
    expect(describePublishRefusal(res)).toContain('total-new-bytes cap');
  });

  it('fails closed on a git error (unresolvable oid)', async () => {
    const res = await checkPublishGuard({ repoPath: repo, fromOid: null, toOid: 'not-a-real-oid' });
    expect(res.ok).toBe(false);
    expect(res.refusalCode).toBe('error');
    expect(res.errors.length).toBeGreaterThan(0);
  });

  // WI-5591: a runtime path exemption (harness_shared.secrets_guard_path_exemptions,
  // migration 644) is the no-restart escape hatch for a false-positive secrets-guard
  // wedge — the data-driven sibling of secrets-guard.ts's hardcoded FIXTURE_FILES.
  describe('WI-5591 runtime path exemptions', () => {
    it('admits a range whose only secret finding is on an exempted path', async () => {
      const base = await commit(repo, { 'clean2.txt': 'nothing to see' });
      const fakeKey = ['AKIA', 'QRSTUVWXYZABCDEF'].join('');
      const withSecret = await commit(repo, { 'exempt.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n` }, base);

      const res = await checkPublishGuard({
        repoPath: repo,
        fromOid: base,
        toOid: withSecret,
        workspaceId: 'ws-test',
        loadPathExemptions: async (ws) => {
          expect(ws).toBe('ws-test');
          return new Set(['exempt.env']);
        },
      });
      expect(res.ok).toBe(true);
      expect(res.refusalCode).toBeNull();
      expect(res.secretFindings).toEqual([]);
      expect(res.exemptedFindings.length).toBe(1);
      expect(res.exemptedFindings[0].path).toBe('exempt.env');
    });

    it('still refuses when only SOME of several secret findings are exempted', async () => {
      const base = await commit(repo, { 'clean3.txt': 'nothing to see' });
      const key1 = ['AKIA', 'ABCABCABCABCABCA'].join('');
      const key2 = ['AKIA', 'DEFDEFDEFDEFDEFD'].join('');
      const withSecrets = await commit(
        repo,
        {
          'exempt2.env': `AWS_ACCESS_KEY_ID=${key1}\n`,
          'not-exempt.env': `AWS_ACCESS_KEY_ID=${key2}\n`,
        },
        base,
      );

      const res = await checkPublishGuard({
        repoPath: repo,
        fromOid: base,
        toOid: withSecrets,
        workspaceId: 'ws-test',
        loadPathExemptions: async () => new Set(['exempt2.env']),
      });
      expect(res.ok).toBe(false);
      expect(res.refusalCode).toBe('secrets');
      expect(res.secretFindings.length).toBe(1);
      expect(res.secretFindings[0].path).toBe('not-exempt.env');
      expect(res.exemptedFindings.length).toBe(1);
      expect(res.exemptedFindings[0].path).toBe('exempt2.env');
    });

    it('does NOT consult runtime exemptions when workspaceId is omitted (unchanged prior behavior)', async () => {
      const base = await commit(repo, { 'clean4.txt': 'nothing to see' });
      const fakeKey = ['AKIA', 'GHIGHIGHIGHIGHIG'].join('');
      const withSecret = await commit(repo, { 'would-be-exempt.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n` }, base);

      let called = false;
      const res = await checkPublishGuard({
        repoPath: repo,
        fromOid: base,
        toOid: withSecret,
        loadPathExemptions: async () => {
          called = true;
          return new Set(['would-be-exempt.env']);
        },
      });
      expect(called).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.refusalCode).toBe('secrets');
      expect(res.exemptedFindings).toEqual([]);
    });
  });
  // ── WI-5738: the refusal must not be a one-way latch ──────────────────
  describe('WI-5738 — a refusal must never be terminal', () => {
    // The 2026-07-20 incident in miniature: a range whose CUMULATIVE size busts
    // the total cap, where the offending commit sits in the middle. The old
    // behaviour refused the whole range, and because callers baseline on their
    // own last SUCCESS the refusal could never clear itself.
    const FAT = 'x'.repeat(600 * 1024); // > the 512KB cap used below
    const caps = { maxTotalNewBytes: 512 * 1024 };

    it('volume refusal DRAINS to the longest admissible prefix instead of refusing everything', async () => {
      const base = await commit(repo, { 'a.txt': 'a' });
      const c1 = await commit(repo, { 'a.txt': 'a', 'b.txt': 'small b' }, base);
      const c2 = await commit(repo, { 'a.txt': 'a', 'b.txt': 'small b', 'c.txt': 'small c' }, c1);
      const fat = await commit(repo, { 'a.txt': 'a', 'b.txt': 'small b', 'c.txt': 'small c', 'fat.bin': FAT }, c2);

      // Baseline behaviour: the whole range is refused outright.
      const whole = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: fat, caps });
      expect(whole.ok).toBe(false);
      expect(whole.refusalCode).toBe('total-over-cap');

      // WI-5738: the same range now yields forward progress.
      const res = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: base, toOid: fat, caps });
      expect(res.safeSha).toBe(c2);
      expect(res.safeSha).not.toBe(base); // the baseline MOVED — no ratchet
      expect(res.drained).toBe(true);
      expect(res.complete).toBe(false);
      expect(res.blocked).toBeNull(); // a volume cap is not a hard block
    });

    it('draining is monotone: re-running from the new baseline gets past the fat commit', async () => {
      const base = await commit(repo, { 'm.txt': 'm' });
      const c1 = await commit(repo, { 'm.txt': 'm', 'n.txt': 'n' }, base);
      const fat = await commit(repo, { 'm.txt': 'm', 'n.txt': 'n', 'fat2.bin': FAT }, c1);
      const after = await commit(repo, { 'm.txt': 'm', 'n.txt': 'n', 'fat2.bin': FAT, 'o.txt': 'o' }, fat);

      const first = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: base, toOid: after, caps });
      expect(first.safeSha).toBe(c1);

      // Next tick resumes from what was published. The fat commit is now the
      // FIRST in the range and indivisible — it goes through rather than
      // wedging the plane forever, and is named for the health layer.
      const second = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: first.safeSha, toOid: after, caps });
      expect(second.oversizedCommit).toBe(fat);
      expect(second.safeSha).toBe(fat);

      // And the tick after that reaches the head — the wedge is fully drained.
      const third = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: second.safeSha, toOid: after, caps });
      expect(third.safeSha).toBe(after);
      expect(third.complete).toBe(true);
    });

    it('a HARD refusal (secret) still blocks — but at the exact commit, with the prefix published', async () => {
      const base = await commit(repo, { 'p.txt': 'p' });
      const clean = await commit(repo, { 'p.txt': 'p', 'q.txt': 'q' }, base);
      const fakeKey = ['AKIA', 'HARDHARDHARDHARD'].join('');
      const leaky = await commit(repo, { 'p.txt': 'p', 'q.txt': 'q', 'leak.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n` }, clean);
      const later = await commit(repo, { 'p.txt': 'p', 'q.txt': 'q', 'leak.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n`, 'r.txt': 'r' }, leaky);

      const res = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: base, toOid: later });
      expect(res.safeSha).toBe(clean); // everything before the leak still ships
      expect(res.blocked?.commit).toBe(leaky); // exact attribution
      expect(res.blocked?.result.refusalCode).toBe('secrets');
      expect(res.complete).toBe(false);
    });

    it('the clean fast path costs exactly ONE guard call', async () => {
      const base = await commit(repo, { 's.txt': 's' });
      const next = await commit(repo, { 's.txt': 's', 't.txt': 't' }, base);
      const res = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: base, toOid: next });
      expect(res.complete).toBe(true);
      expect(res.safeSha).toBe(next);
      expect(res.guardCalls).toBe(1);
    });

    it("volumeGates:'warn' admits a volume breach (second-line guard) but still refuses secrets", async () => {
      const base = await commit(repo, { 'w.txt': 'w' });
      const fat = await commit(repo, { 'w.txt': 'w', 'fat3.bin': FAT }, base);

      const enforced = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: fat, caps });
      expect(enforced.ok).toBe(false);
      expect(enforced.refusalCode).toBe('total-over-cap');

      const warned = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: fat, caps, volumeGates: 'warn' });
      expect(warned.ok).toBe(true);
      expect(warned.volumeWarnings).toContain('total-over-cap');

      // Safety gates are NOT relaxed by 'warn'.
      const fakeKey = ['AKIA', 'WARNWARNWARNWARN'].join('');
      const leaky = await commit(repo, { 'w.txt': 'w', 'leak2.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n` }, base);
      const stillRefused = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: leaky, volumeGates: 'warn' });
      expect(stillRefused.ok).toBe(false);
      expect(stillRefused.refusalCode).toBe('secrets');
    });
  });
});
