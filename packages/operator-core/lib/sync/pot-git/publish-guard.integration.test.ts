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
import {
  checkPublishGuard,
  describePublishRefusal,
  partitionBlobsForScan,
  resolveIncrementalPublishSha,
} from './publish-guard';

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
    // EI-18751879785723304: the refusal must name WHERE the finding is, not just
    // count it. The documented remedy (pot_git:secrets_exemptions { path }) needs
    // the path, so a count-only message forced an operator to hand-reproduce the
    // whole scan to recover it during a 3h fleet-wide egress freeze.
    const msg = describePublishRefusal(res);
    expect(msg).toContain('secret(s)');
    expect(msg).toContain('config.env:1');
    expect(msg).toContain('[aws-access-key-id]');
    // ...and naming the location must NEVER leak the material itself — the
    // excerpt is masked at detection ('AKIA…OP (20 chars)'), which is precisely
    // what makes surfacing the path safe.
    expect(msg).not.toContain(fakeKey);
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

  // WI-6254: the G-10 scan reads blobs in BOUNDED chunks, so peak resident
  // content is `scanChunkBytes` rather than the whole range. Previously every
  // text blob was materialised at once and the only things bounding that were
  // the VOLUME caps — which `volumeGates:'warn'` (exactly what the ref-announce
  // second-line guard passes) switches off. A range judged against a wrong
  // baseline (WI-6251: 7057 commits) then drove the sidecar 2.35GB -> 3.67GB
  // into a FATAL heap OOM, crash frame `Builtins_StringSlowFlatten`, instead of
  // returning a refusal — an OOM inside a fail-CLOSED guard is a fail-OPEN in
  // effect, because DBOS just restarts the fire at the same step forever.
  //
  // The bound is only safe if it never costs COVERAGE, which is what these pin.
  describe('bounded-memory secrets scan (WI-6254)', () => {
    it('partitions by byte budget, preserves order, and never drops an over-budget blob', () => {
      const b = (oid: string, bytes: number) => ({ oid, path: `${oid}.ts`, bytes });

      expect(partitionBlobsForScan([b('a', 40), b('b', 40), b('c', 40)], 100).map((g) => g.map((x) => x.oid))).toEqual([
        ['a', 'b'],
        ['c'],
      ]);

      // A blob larger than the whole budget forms its OWN group rather than
      // being skipped — coverage is never traded for the bound. (Its size is
      // separately bounded by the HARD, non-waivable blob-over-cap gate.)
      const withFat = partitionBlobsForScan([b('a', 10), b('fat', 5_000), b('z', 10)], 100);
      expect(withFat.map((g) => g.map((x) => x.oid))).toEqual([['a'], ['fat'], ['z']]);

      // Every blob survives partitioning, in input order — the property the
      // coverage tests below depend on.
      const many = Array.from({ length: 50 }, (_, i) => b(`o${i}`, 30));
      const groups = partitionBlobsForScan(many, 100);
      expect(groups.flat().map((x) => x.oid)).toEqual(many.map((x) => x.oid));
      // ...and every multi-blob group respects the budget.
      for (const g of groups) {
        if (g.length > 1) expect(g.reduce((n, x) => n + x.bytes, 0)).toBeLessThanOrEqual(100);
      }

      expect(partitionBlobsForScan([], 100)).toEqual([]);
    });

    it('yields identical findings with a 1-byte budget as with an unbounded one', async () => {
      const base = await commit(repo, { 'chunk-base.txt': 'base' });
      const files: Record<string, string> = {};
      for (let i = 0; i < 12; i++) files[`src/chunk-${i}.ts`] = `export const v${i} = ${i};\n`.repeat(20);
      // THREE secrets in three separate blobs, deliberately. With a single
      // planted secret a "scan only the first chunk" regression could survive
      // on the luck of `rev-list --objects` ordering; with three, any mutant
      // that stops early yields strictly fewer findings than the unbounded
      // read no matter what order git enumerates the range in.
      const keys = ['CHUNKCHUNKCHUNKZ', 'SECONDSECONDSECZ', 'THIRDTHIRDTHIRDZ'].map((s) => ['AKIA', s].join(''));
      // Each secret sits on LINE 3, never line 1. That makes the assertion
      // order-independent proof that content is read by its DECLARED SIZE: a
      // parser that truncated a blob at its first newline would miss all three
      // whatever order `rev-list --objects` happens to enumerate the range in.
      const env = (k: string) => `# settings\n# managed file\nAWS_ACCESS_KEY_ID=${k}\n`;
      files['deep/buried.env'] = env(keys[0]);
      files['other/second.env'] = env(keys[1]);
      files['third/third.env'] = env(keys[2]);
      const tip = await commit(repo, files, base);

      // scanChunkBytes:1 forces one blob per chunk — the maximum-fragmentation
      // case. It must agree exactly with a single whole-range read.
      const tiny = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: tip, caps: { scanChunkBytes: 1 } });
      const huge = await checkPublishGuard({
        repoPath: repo,
        fromOid: base,
        toOid: tip,
        caps: { scanChunkBytes: 64 * 1024 * 1024 },
      });

      const fingerprint = (r: typeof tiny) => r.secretFindings.map((f) => `${f.path}:${f.line}:${f.rule}`).sort();
      expect(tiny.refusalCode).toBe('secrets');
      expect(fingerprint(tiny)).toEqual(fingerprint(huge));
      // All three must be present in the maximally-fragmented read — this is
      // the assertion that has teeth against an early-stopping scan loop.
      expect(fingerprint(tiny)).toEqual([
        'deep/buried.env:3:aws-access-key-id',
        'other/second.env:3:aws-access-key-id',
        'third/third.env:3:aws-access-key-id',
      ]);
    });

    it('parses the batch stream byte-exactly: multi-line and BINARY blobs never desync the frame parser', async () => {
      const base = await commit(repo, { 'bin-base.txt': 'base' });
      const fakeKey = ['AKIA', 'BINARYBINARYBINZ'].join('');
      const tip = await commit(
        repo,
        {
          // Content full of LFs: a naive delimiter scan would lose frame sync
          // here and misattribute every object after it.
          'src/multiline.ts': 'const line = 1;\n'.repeat(500),
          // Content with NUL bytes: must be SKIPPED as binary, and the frame
          // AFTER it must still be read at the correct byte offset.
          'assets/blob.bin': 'PK\x00\x00binary\x00payload\x00'.repeat(50),
          // Secret on LINE 3, never line 1 — see the equivalence test above. A
          // parser that truncated each blob at its first newline would miss it
          // regardless of the order git enumerates the range in, so this
          // assertion genuinely pins size-driven framing rather than luck.
          'later/leak.env': `# settings\n# managed file\nAWS_ACCESS_KEY_ID=${fakeKey}\n`,
        },
        base,
      );

      const res = await checkPublishGuard({
        repoPath: repo,
        fromOid: base,
        toOid: tip,
        caps: { scanChunkBytes: 1024 },
      });

      // Found at its TRUE path and line ⇒ the parser stayed in sync across both
      // the newline-dense blob and the NUL-carrying one.
      expect(res.refusalCode).toBe('secrets');
      expect(res.secretFindings.some((f) => f.path === 'later/leak.env' && f.line === 3)).toBe(true);
      expect(res.secretFindings.some((f) => f.path === 'assets/blob.bin')).toBe(false);
    });

    it('applies the memory bound in BOTH volume modes — it is a resource bound, not a waivable volume gate', async () => {
      const base = await commit(repo, { 'warn-base.txt': 'base' });
      const fakeKey = ['AKIA', 'WARNBOUNDWARNBOZ'].join('');
      const files: Record<string, string> = { 'w/leak.env': `AWS_ACCESS_KEY_ID=${fakeKey}\n` };
      for (let i = 0; i < 8; i++) files[`w/f${i}.ts`] = `export const w${i} = ${i};\n`.repeat(30);
      const tip = await commit(repo, files, base);

      // 'warn' switches the VOLUME caps off. It must NOT switch the scan bound
      // off, and the scan must still reach every blob — this is the exact
      // configuration the ref-announce second-line guard runs in, i.e. the one
      // that OOMed the rig.
      const res = await checkPublishGuard({
        repoPath: repo,
        fromOid: base,
        toOid: tip,
        caps: { scanChunkBytes: 1, maxTotalNewBytes: 1, maxNewObjects: 1 },
        volumeGates: 'warn',
      });

      expect(res.volumeWarnings).toContain('total-over-cap');
      expect(res.refusalCode).toBe('secrets');
      expect(res.secretFindings.some((f) => f.path === 'w/leak.env')).toBe(true);
    });
  });

  // WI-10003528 — the already-exposed exclusion applies on EVERY publish, not only
  // genesis. Measured on the P-203 Mac VM: a device draining from an old baseline
  // hit a hard secrets refusal on a synthetic fixture commit that five OTHER device
  // namespaces in the same store already reached, and on GitHub origin/main.
  describe('already-exposed history (WI-10003528)', () => {
    const SELF = 'a'.repeat(64);
    const PEER = 'b'.repeat(64);
    const updateRef = async (ref: string, sha: string): Promise<void> => {
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['update-ref', ref, sha], { cwd: repo });
    };

    it('skips a secret another device already published, which the strict judgement still refuses', async () => {
      const prior = await commit(repo, { 'x1/base.txt': 'x1 base' });
      const key = ['AKIA', 'EXPOSEDONEXPOSED'].join('');
      const fixture = await commit(repo, { 'x1/fixture.env': `AWS_ACCESS_KEY_ID=${key}\n` }, prior);
      const local = await commit(repo, { 'x1/local.txt': 'only this device has this' }, fixture);
      await updateRef(`refs/namespaces/${PEER}/refs/heads/staging`, fixture);

      // Control: without the device's namespace the range is judged strictly,
      // and the fixture really IS inside (prior, local].
      const strict = await checkPublishGuard({ repoPath: repo, fromOid: prior, toOid: local });
      expect(strict.refusalCode).toBe('secrets');

      const res = await checkPublishGuard({ repoPath: repo, fromOid: prior, toOid: local, selfNamespaceHex: SELF });
      expect(res.refusalCode).toBeNull();
      expect(res.ok).toBe(true);
      expect(res.secretFindings).toEqual([]);
      // This device's own new content was still judged: commit + trees + its blob.
      expect(res.newObjectCount).toBeGreaterThan(0);
    });

    it('still refuses a secret reachable only from this device\'s OWN namespace, a local branch, or ingress quarantine', async () => {
      const prior = await commit(repo, { 'x2/base.txt': 'x2 base' });
      const key = ['AKIA', 'SELFONLYSELFONLY'].join('');
      const leak = await commit(repo, { 'x2/leak.env': `AWS_ACCESS_KEY_ID=${key}\n` }, prior);
      // None of these is an EXPOSED_REF_GLOBS class. The self namespace is the
      // content in question, so treating it as exposure would judge nothing.
      await updateRef(`refs/namespaces/${SELF}/refs/heads/work`, leak);
      await updateRef('refs/heads/x2-local-only', leak);
      await updateRef(`refs/ingress-quarantine/${PEER}`, leak);

      const res = await checkPublishGuard({ repoPath: repo, fromOid: prior, toOid: leak, selfNamespaceHex: SELF });
      expect(res.refusalCode).toBe('secrets');
      expect(res.secretFindings.some((f) => f.path === 'x2/leak.env')).toBe(true);
    });

    it('drains a whole backlog past a fixture a remote-tracking ref already exposed', async () => {
      const prior = await commit(repo, { 'x3/base.txt': 'x3 base' });
      const key = ['AKIA', 'REMOTEREMOTEREMO'].join('');
      const fixture = await commit(repo, { 'x3/fixture.env': `AWS_ACCESS_KEY_ID=${key}\n` }, prior);
      const mid = await commit(repo, { 'x3/a.txt': 'local a' }, fixture);
      const tip = await commit(repo, { 'x3/b.txt': 'local b' }, mid);
      await updateRef('refs/remotes/origin/x3-main', fixture);

      // Control: the strict split stops AT the fixture, publishing nothing.
      const strict = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: prior, toOid: tip });
      expect(strict.blocked?.commit).toBe(fixture);
      expect(strict.safeSha).toBe(prior);
      expect(strict.complete).toBe(false);

      const res = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: prior, toOid: tip, selfNamespaceHex: SELF });
      expect(res.blocked).toBeNull();
      expect(res.safeSha).toBe(tip);
      expect(res.complete).toBe(true);
    });

    it('a secret a LOCAL commit adds after an exposed fixture is still caught, and the split stops at that commit', async () => {
      const prior = await commit(repo, { 'x4/base.txt': 'x4 base' });
      const exposedKey = ['AKIA', 'PUBLICPUBLICPUBL'].join('');
      const fixture = await commit(repo, { 'x4/fixture.env': `AWS_ACCESS_KEY_ID=${exposedKey}\n` }, prior);
      const clean = await commit(repo, { 'x4/clean.txt': 'clean local' }, fixture);
      const newKey = ['AKIA', 'NEWLOCALNEWLOCAL'].join('');
      const leak = await commit(repo, { 'x4/leak.env': `AWS_ACCESS_KEY_ID=${newKey}\n` }, clean);
      await updateRef(`refs/namespaces/${PEER}/refs/heads/x4`, fixture);

      const res = await resolveIncrementalPublishSha({ repoPath: repo, fromOid: prior, toOid: leak, selfNamespaceHex: SELF });
      expect(res.safeSha).toBe(clean);
      expect(res.blocked?.commit).toBe(leak);
      expect(res.blocked?.result.refusalCode).toBe('secrets');
      expect(res.complete).toBe(false);
    });

    it('fails closed on a malformed namespace key rather than splicing it into a ref glob', async () => {
      const base = await commit(repo, { 'x5/base.txt': 'x5 base' });
      const tip = await commit(repo, { 'x5/next.txt': 'x5 next' }, base);
      const res = await checkPublishGuard({ repoPath: repo, fromOid: base, toOid: tip, selfNamespaceHex: 'refs/*' });
      expect(res.ok).toBe(false);
      expect(res.refusalCode).toBe('error');
    });
  });
});
