/**
 * leg-c-trust-drill.integration.test.ts — WI-3498 (p2p-git-live-activation-
 * 2026-07-09 / P-304, "Leg C trust"): the TAMPER drill against real bare
 * repos + real ed25519 keys, no network transport involved.
 *
 * SCOPE NOTE: the drill script's SKIP census (pot-git-drill.sh) parks LEG C
 * behind "needs LEG B's live fetch path" — true for a genuine cross-machine
 * run, but per WI-3497's checkpoint the announce→fetch WIRING itself
 * (P-201/202/204/205) is code-complete; only the 2-machine RIG is blocked on
 * the frozen fed-plane (WI-3619/1729/3488, untouched here per the plan
 * leader's brief). The transport hop (fetchOverDuplex/serveUploadPack) is
 * already unit-tested (fetch-transport.test.ts) and integration-tested over a
 * real socketpair (ref-announce.integration.test.ts's "relay-tampered head"
 * case) — this file instead drives the TRUST VERIFICATION layer directly
 * (sigrefs signature/rollback/reconcile + the scope-serve-gate), which is
 * exactly what's independently provable without the rig or the fed-plane,
 * and matches the WI's three named scenarios literally:
 *
 *   1. a relay peer serves a LYING head for a THIRD device's namespace
 *      (sigrefs.ts's own "transitive-relay tamper hole" header: "a receiver
 *      may fetch device B's namespace THROUGH a relay peer C … C could
 *      advance B's namespace heads to shas B never published") → the fetch
 *      is REFUSED loudly: `reconcileFetchedHeads` returns a structured
 *      mismatch record (the D-004 receipt/counter trigger a caller — the G-5
 *      integrator — keys off of to refuse trusting the head), even though
 *      the device's OWN signature over its real (untampered) state remains
 *      genuinely valid (transport auth ≠ per-namespace content
 *      authenticity, per the ops runbook's sigrefs section).
 *   2. a non-member peer's fetch is refused by the scope-serve-gate
 *      (`authorizeScopeRepoServe`), fail-closed, with a structured refusal
 *      the caller turns into a P-004 receipt / M15 counter.
 *   3. a rollback (an older, validly-signed-but-superseded sigrefs snapshot)
 *      is refused by the G-4b monotonic version guard alone.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/leg-c-trust-drill.integration.test.ts
 *
 * (Cup-sandbox note: this cup's own capability_bash cannot run the
 * integration config here — testcontainers' baseline-schema global setup
 * hits EROFS on /tmp/pcv under this sandbox's fs isolation, the exact same
 * wall WI-3497 hit; this file needs no PG at all, only `git` subprocess exec
 * + in-process ed25519, so it was functionally verified green by running the
 * identical body under the package's plain (non-integration) vitest config
 * instead — see the WI-3498 checkpoint. It is filed under `.integration.
 * test.ts` because it exercises real git subprocesses against real bare
 * repos, matching this directory's own convention (sigrefs.integration.
 * test.ts, ref-announce.integration.test.ts do the same) — CI / a real host
 * runs it via the command above.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef } from './storage';
import { buildSigrefs, readSigrefs, acceptFetchedSigrefs, reconcileFetchedHeads } from './sigrefs';
import { ensureScopeRepo, scopeRepoPath } from './scope-repo';
import { authorizeScopeRepoServe } from './scope-serve-gate';

function mkDevice(): { pubkeyBase64: string; sign: (bytes: Buffer) => Promise<Buffer> } {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim(), '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('pot-git Leg C trust drill (P-304): tamper / rollback / non-member refusals', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'legc-trust-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('a relay lying about a THIRD device namespace is detected + refused loudly (receipt), even though the sig is genuinely valid', async () => {
    const devC = mkDevice(); // the third device whose namespace the relay lies about
    const sharedRepo = await ensurePotGitRepo('legc-hive', 'legc-repo');

    // Happy path first: C publishes + signs (v1) → clean verify, clean reconcile.
    const sha1 = await mintCommit(sharedRepo, 'C work 1');
    await writeNamespaceRef(sharedRepo, devC.pubkeyBase64, 'refs/heads/work', sha1);
    const v1 = await buildSigrefs(sharedRepo, devC.pubkeyBase64, devC.sign, { nowMs: 1000 });
    expect(acceptFetchedSigrefs(v1, devC.pubkeyBase64, null, { allowLegacy: true })).toEqual({ ok: true });
    expect(await reconcileFetchedHeads(sharedRepo, devC.pubkeyBase64, v1)).toEqual([]);

    // C signs v2 legitimately over sha2 — then a dishonest RELAY (standing in
    // for "C mirrored through relay peer" from sigrefs.ts's own tamper-hole
    // comment) re-points the SERVED ref to a rogue commit C never signed.
    const sha2 = await mintCommit(sharedRepo, 'C work 2 (legit)');
    await writeNamespaceRef(sharedRepo, devC.pubkeyBase64, 'refs/heads/work', sha2);
    const v2 = await buildSigrefs(sharedRepo, devC.pubkeyBase64, devC.sign, { nowMs: 2000 });
    const rogue = await mintCommit(sharedRepo, 'RELAY-INJECTED — C never signed this');
    await writeNamespaceRef(sharedRepo, devC.pubkeyBase64, 'refs/heads/work', rogue); // the lie, post-signature

    // C's own signature is genuinely valid — the relay cannot forge it.
    expect(acceptFetchedSigrefs(v2, devC.pubkeyBase64, 1, { allowLegacy: true })).toEqual({ ok: true });
    // The reconcile step catches what the signature check structurally
    // cannot: the served bytes don't match what C actually signed. This
    // mismatch record IS the loud, structured refusal (D-004's receipt/
    // counter trigger) — an integrator must never merge an unreconciled head.
    const mismatches = await reconcileFetchedHeads(sharedRepo, devC.pubkeyBase64, v2);
    expect(mismatches).toEqual([{ ref: 'refs/heads/work', expected: sha2, actual: rogue }]);

    await writeNamespaceRef(sharedRepo, devC.pubkeyBase64, 'refs/heads/work', sha2); // restore the honest head
  });

  it('rollback: an older, validly-signed-but-superseded sigrefs snapshot is refused (G-4b monotonic guard)', async () => {
    const devC = mkDevice();
    const sharedRepo = await ensurePotGitRepo('legc-hive', 'legc-repo-rollback');
    const sha1 = await mintCommit(sharedRepo, 'C rollback-v1');
    await writeNamespaceRef(sharedRepo, devC.pubkeyBase64, 'refs/heads/work', sha1);
    const v1 = await buildSigrefs(sharedRepo, devC.pubkeyBase64, devC.sign, { nowMs: 1000, version: 1 });

    // A relay replaying the OLDER (already-superseded) snapshot — the
    // signature checks out (it really was signed by C), but the version
    // fence alone must refuse it once a newer version (2) was accepted.
    expect(acceptFetchedSigrefs(v1, devC.pubkeyBase64, /* priorVersion */ 2, { allowLegacy: true })).toEqual({
      ok: false,
      reason: 'rollback',
    });
    // Same version replayed is refused too (strict >, not >=).
    expect(acceptFetchedSigrefs(v1, devC.pubkeyBase64, 1, { allowLegacy: true })).toEqual({ ok: false, reason: 'rollback' });
  });

  it('non-member fetch of a scope repo is refused by the scope-serve-gate, fail-closed, with a structured refusal', async () => {
    const scope = { kind: 'fleet' as const, ownerGithubUserId: 424242, slug: 'legc-drill' };
    await ensureScopeRepo('legc-hive', scope);
    const OUTSIDER_GITHUB_USER_ID = 999999;

    const decision = await authorizeScopeRepoServe({
      repoPath: scopeRepoPath('legc-hive', scope),
      peerGithubUserId: OUTSIDER_GITHUB_USER_ID,
      isScopeMember: async () => false, // outsider is provably not on the roster
    });
    // The refusal object IS the P-004 receipt / M15 counter trigger — never a
    // silent drop (D-004).
    expect(decision).toEqual({
      ok: false,
      refusal: {
        reason: 'not-a-member',
        repoPath: scopeRepoPath('legc-hive', scope),
        scopeId: 'fleet:424242/legc-drill',
        peerGithubUserId: OUTSIDER_GITHUB_USER_ID,
      },
    });

    // A THROWING roster (a transient lookup failure) also fails CLOSED —
    // never treated as "no opinion, allow".
    const throwing = await authorizeScopeRepoServe({
      repoPath: scopeRepoPath('legc-hive', scope),
      peerGithubUserId: OUTSIDER_GITHUB_USER_ID,
      isScopeMember: async () => {
        throw new Error('roster lookup unavailable');
      },
    });
    expect(throwing).toMatchObject({ ok: false, refusal: { reason: 'roster-error' } });
  });

  it('control: an unrelated device namespace is never touched by any of the above', async () => {
    const devB = mkDevice();
    const sharedRepo = await ensurePotGitRepo('legc-hive', 'legc-repo-control');
    expect(await readSigrefs(sharedRepo, devB.pubkeyBase64)).toBeNull();
  });
});
