---
title: Phase 1b — bidirectional federation (implementation plan)
slug: papercusp-phase1b-bidirectional-federation-impl-2026-06-01
status: draft
created: 2026-06-01
owner: avi@storewolf.com
implements_spec: papercusp-phase1b-bidirectional-federation-2026-06-01
---

# Phase 1b — Bidirectional Federation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the live join/share identity pipeline onto the Model B substrate so two *different* GitHub engineers federate **bidirectionally** through the desktop UI.

**Architecture:** A remote peer is admitted by verifying the *remote-verifiable* channel-2 only (a GitHub-published, device-signed contributor file whose commit GitHub marks verified); channel-1 (OAuth) stays a publish-time self-check. Both share and join call one symmetric `ensureMyBindingPublished()` (Octokit Contents API → verified commit) so both sides are verifiable. The joiner's GitHub identity is resolved server-side from local `gh` auth. The join orchestrator collapses to 6 Model-B steps and auto-boots the substrate. A small announce-freshness field closes a replay gap.

**Tech Stack:** TypeScript, Vitest 4, Octokit (`@/lib/identity/octokit-client`), Node `crypto` Ed25519, Holepunch (hypercore/hyperswarm/corestore), the existing Model B substrate (`apps/operator/lib/sync/hyperbee/*`).

**Spec:** `apps/operator/docs/plans/papercusp-phase1b-bidirectional-federation-2026-06-01.md` (decisions D-001..D-009). Read it first.

---

## Now

**State:** DRAFT plan, ready for subagent-driven execution. Built in dependency order (helpers → publish → admission → wire → UI → verify) so each task is correct on its own and the final state is whole.

**Repo discipline:** work on `main` directly; no branches/PRs/push. Commit each task with `git add <paths>` + `git commit --no-verify` + the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Server-side `:3070` has no hot-reload — `systemctl --user restart papercup-dev-api.service` (or reload the Tauri shell) to exercise live. Run affected tests with `cd apps/operator && npx vitest run <path>`.

---

## File structure (what changes, and why)

| File | Change | Responsibility |
|---|---|---|
| `apps/operator/lib/identity/resolve-local-github-identity.ts` | **create** | One resolver: local `gh` token → `GET /user` → `{token, githubUserId, githubLogin}` or `gh_auth_required`. |
| `apps/operator/lib/harness/ensure-binding-published.ts` | **create** | Symmetric publish: ensure my device-signed contributor file is on `user/<id>` via a **verified** commit (Contents API). Idempotent. Called by share + join. |
| `apps/operator/lib/sync/hyperbee/verify-binding-adapter.ts` | **rewrite** | Admission = `verifyChannel2` only; return 3-state `'verified'|'pending'|'fail'`. |
| `apps/operator/lib/sync/hyperbee/boot.ts` | **modify** | Admission decider consumes the 3-state; pending-retry set + bounded timer; thread announce `ts`. |
| `apps/operator/lib/sync/hyperbee/announce.ts` | **modify** | Add `ts` (+ `nonce`) to `AnnounceBody`/signing bytes; `verifyAnnounce` freshness window. |
| `apps/operator/lib/harness/join-shared-harness.ts` | **rewrite step list** | 6 Model-B steps; `publish_binding` = `ensureMyBindingPublished`; delete Hyperbee-row step 8; add `boot_federate` + `await_admission_merge`. |
| `apps/operator/lib/endpoint-route/routes/harness/join-link.ts` | **modify** | Resolve identity server-side; `gh_auth_required` (401); drop body cred requirement. |
| `apps/operator/lib/endpoint-route/routes/harness/share-finalize.ts` | **modify** | Call `ensureMyBindingPublished` (publisher binding — the mutual-binding fix). |
| `apps/operator/app/harness/EntryHarnessLinkForm.tsx` | **modify** | Drop empty creds; surface `gh_auth_required`; new step list in `JoinProgress`. |
| `apps/operator/lib/sync/hyperbee/__tests__/two-peer-swarm-bidi.test.ts` | **create** | Deterministic two-identity bidirectional federation test (injected `verifyChannel2`). |

---

### Task 1: `resolveLocalGithubIdentity()` shared helper  [D-004]

**Files:**
- Create: `apps/operator/lib/identity/resolve-local-github-identity.ts`
- Test: `apps/operator/lib/identity/__tests__/resolve-local-github-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveLocalGithubIdentity } from '../resolve-local-github-identity';

describe('resolveLocalGithubIdentity', () => {
  it('returns identity when gh is authed', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'ok', token: 'tok' }),
      getUser: async () => ({ id: 42, login: 'alice' }),
    });
    expect(r).toEqual({ kind: 'ok', token: 'tok', githubUserId: 42, githubLogin: 'alice' });
  });

  it('returns gh_auth_required when no token', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'missing' }),
      getUser: async () => { throw new Error('should not be called'); },
    });
    expect(r).toEqual({ kind: 'gh_auth_required' });
  });

  it('returns gh_auth_required when GET /user 401s', async () => {
    const r = await resolveLocalGithubIdentity({
      getToken: async () => ({ kind: 'ok', token: 'tok' }),
      getUser: async () => null, // octokit auth failure → null
    });
    expect(r).toEqual({ kind: 'gh_auth_required' });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`module not found`). `cd apps/operator && npx vitest run lib/identity/__tests__/resolve-local-github-identity.test.ts`

- [ ] **Step 3: Implement.** Defaults wrap the real helpers (`getGhAuthToken` from `./gh-token`, `getOctokit().users.getAuthenticated()` from `./octokit-client`); seams are injectable for tests.

```ts
import { getGhAuthToken } from './gh-token';
import { getOctokit } from './octokit-client';

export type LocalGithubIdentity =
  | { kind: 'ok'; token: string; githubUserId: number; githubLogin: string }
  | { kind: 'gh_auth_required' };

export interface ResolveLocalGithubIdentityOpts {
  getToken?: () => Promise<{ kind: 'ok'; token: string } | { kind: 'missing' } | { kind: string }>;
  getUser?: () => Promise<{ id: number; login: string } | null>;
}

export async function resolveLocalGithubIdentity(
  opts: ResolveLocalGithubIdentityOpts = {},
): Promise<LocalGithubIdentity> {
  const getToken = opts.getToken ?? getGhAuthToken;
  const getUser =
    opts.getUser ??
    (async () => {
      const oc = await getOctokit();
      if (!oc) return null;
      const { data } = await oc.users.getAuthenticated();
      if (typeof data.id !== 'number' || typeof data.login !== 'string' || !data.login) return null;
      return { id: data.id, login: data.login };
    });

  const tok = await getToken();
  if (tok.kind !== 'ok' || !('token' in tok) || !tok.token) return { kind: 'gh_auth_required' };
  const user = await getUser();
  if (!user) return { kind: 'gh_auth_required' };
  return { kind: 'ok', token: tok.token, githubUserId: user.id, githubLogin: user.login };
}
```

- [ ] **Step 4: Run — expect PASS.** Then refactor `local-announce-identity.ts`'s `defaultResolveGithubUser` to reuse this resolver's `getUser` path (DRY; keep its existing test green).
- [ ] **Step 5: Commit** — `feat(identity): resolveLocalGithubIdentity shared gh-auth resolver`.

---

### Task 2: `ensureMyBindingPublished()` via verified-commit Contents API  [D-003, R-1]

**Files:**
- Create: `apps/operator/lib/harness/ensure-binding-published.ts`
- Test: `apps/operator/lib/harness/__tests__/ensure-binding-published.test.ts`

**Why Contents API (R-1):** channel-2(c) requires `commit.verification.verified === true`. A local `git commit` + push (the current `step7`) is **not** verified. `octokit.repos.createOrUpdateFileContents` creates a commit via GitHub web-flow that GitHub signs → `verified: true`, authored by the token's user (so `author.login` matches). This replaces the worktree/git-push publish for the contributor file.

- [ ] **Step 1: Write the failing test** (idempotent + creates branch + signs + PUTs):

```ts
import { describe, it, expect, vi } from 'vitest';
import { ensureMyBindingPublished } from '../ensure-binding-published';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

function fakeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
  return { pub, sign: async (_id: string, bytes: Buffer) => nodeSign(null, bytes, privateKey) };
}

describe('ensureMyBindingPublished', () => {
  it('creates the user branch (if missing) and PUTs a signed contributor file via a verified commit', async () => {
    const kp = fakeKeypair();
    const calls: string[] = [];
    const octo = {
      git: {
        getRef: vi.fn(async () => { throw { status: 404 }; }),        // branch missing
        createRef: vi.fn(async () => { calls.push('createRef'); return { data: {} }; }),
      },
      repos: {
        getContent: vi.fn(async () => { throw { status: 404 }; }),    // file missing
        createOrUpdateFileContents: vi.fn(async () => { calls.push('put'); return { data: { commit: { sha: 'abc' } } }; }),
      },
    };
    const r = await ensureMyBindingPublished({
      repoOwner: 'org', repoName: 'proj',
      identity: { token: 't', githubUserId: 7, githubLogin: 'bob' },
      keychainId: 'kc', devicePubkeyBase64: kp.pub, sign: kp.sign,
      defaultBranch: 'main',
      octokit: octo as any,
    });
    expect(calls).toEqual(['createRef', 'put']);     // branch created, then file written
    expect(r.devicePubkeyBase64).toBe(kp.pub);
    // The PUT'd body must carry device_pubkey + a valid signature_by_device (verify offline).
    const body = JSON.parse(Buffer.from(octo.repos.createOrUpdateFileContents.mock.calls[0][0].content, 'base64').toString());
    expect(body.device_pubkey).toBe(`ed25519:${kp.pub}`);
    expect(typeof body.signature_by_device).toBe('string');
  });

  it('is a no-op when the published file already carries my current device pubkey', async () => {
    const kp = fakeKeypair();
    // getContent returns an existing, correctly-signed file for kp.pub (build via the same signer).
    // ... (test builds the signed body, base64s it, returns from getContent) ...
    // assert createOrUpdateFileContents is NOT called.
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/operator && npx vitest run lib/harness/__tests__/ensure-binding-published.test.ts`

- [ ] **Step 3: Implement.** Reuse the existing contributor-file body shape + JCS signing from `join-shared-harness.ts:step7` (extract the body+sign block into a small `buildSignedContributorFile(...)` helper in `contributor-file-types.ts` or this module — DRY) and `verifyContributorFileSignature` for the idempotency check.

```ts
import {
  ContributorFileBody, CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
  contributorFilePath, contributorBranchRef,
} from '@/lib/identity/contributor-file-types';

export interface EnsureBindingOpts {
  repoOwner: string; repoName: string;
  identity: { token: string; githubUserId: number; githubLogin: string };
  keychainId: string; devicePubkeyBase64: string;
  sign: (keychainId: string, bytes: Buffer) => Promise<Buffer>;
  defaultBranch: string;
  attestationGistId?: string;
  octokit?: unknown; // defaults to getOctokit(); injectable for tests
}

export async function ensureMyBindingPublished(opts: EnsureBindingOpts): Promise<{ devicePubkeyBase64: string; commitSha?: string }> {
  const octo = opts.octokit ?? (await getOctokitOrThrow(opts.identity.token));
  const branch = contributorBranchRef(opts.identity.githubUserId);          // user/<id>
  const path = contributorFilePath(opts.identity.githubLogin);              // .harness/contributors/<login>.json

  // 1. Ensure the user/<id> branch exists (create from defaultBranch HEAD if 404).
  await ensureBranch(octo, opts.repoOwner, opts.repoName, branch, opts.defaultBranch);

  // 2. Build + sign the body (extracted shared helper — same fields/JCS as step7).
  const body = await buildSignedContributorFile({
    githubUserId: opts.identity.githubUserId, githubLogin: opts.identity.githubLogin,
    devicePubkeyBase64: opts.devicePubkeyBase64, attestationGistId: opts.attestationGistId ?? '',
    keychainId: opts.keychainId, sign: opts.sign,
  });

  // 3. Idempotency: GET the existing file on the branch; if it parses, carries the SAME
  //    device_pubkey, and its signature verifies → no-op. Else PUT (verified commit).
  const existing = await getContentOrNull(octo, opts.repoOwner, opts.repoName, path, branch);
  if (existing && bindingMatches(existing.body, opts.devicePubkeyBase64)) {
    return { devicePubkeyBase64: opts.devicePubkeyBase64 };
  }
  const res = await octo.repos.createOrUpdateFileContents({
    owner: opts.repoOwner, repo: opts.repoName, path, branch,
    message: `chore: publish contributor binding for ${opts.identity.githubLogin}`,
    content: Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf8').toString('base64'),
    sha: existing?.sha, // update vs create
  });
  return { devicePubkeyBase64: opts.devicePubkeyBase64, commitSha: res.data.commit?.sha };
}
```

(Implement `ensureBranch` via `git.getRef('heads/<default>')` → `git.createRef('refs/heads/user/<id>', baseSha)` on 404; `getContentOrNull` via `repos.getContent` swallowing 404; `bindingMatches` parses the body and runs the existing `verifyContributorFileSignature`.)

- [ ] **Step 4: Run — expect PASS** (both cases).
- [ ] **Step 5: Commit** — `feat(harness): ensureMyBindingPublished — verified-commit contributor publish (R-1)`.

---

### Task 3: Admission verifier = channel-2 only (3-state)  [D-002, D-006]

**Files:**
- Modify: `apps/operator/lib/sync/hyperbee/verify-binding-adapter.ts`
- Test: `apps/operator/lib/sync/hyperbee/verify-binding-adapter.test.ts` (extend)

- [ ] **Step 1: Write failing tests** — the adapter returns `'verified'` on channel-2 ok, `'pending'` on channel-2 pending (404 propagating), `'fail'` on channel-2 fail; and it **never calls channel-1**:

```ts
it('admits on channel-2 ok (does NOT run channel-1)', async () => {
  const ch1 = vi.fn();
  const verify = buildVerifyBindingAdapter({
    workspaceId: 'w', harnessSlug: 's', workspaceRoot: '/x',
    resolveContext: async () => ({ repoOwner: 'o', repoName: 'r', token: 't' }),
    verifyChannel2Impl: async () => ({ kind: 'ok' }),
    verifyChannel1Impl: ch1,
  });
  expect(await verify('PUB', 'alice', 42)).toBe('verified');
  expect(ch1).not.toHaveBeenCalled();
});
it('pending → pending (retryable)', async () => { /* verifyChannel2Impl → {kind:'pending'} ⇒ 'pending' */ });
it('fail → fail (not retryable)', async () => { /* verifyChannel2Impl → {kind:'fail'} ⇒ 'fail' */ });
it('no harness context → fail (fail-closed)', async () => { /* resolveContext → null ⇒ 'fail' */ });
```

- [ ] **Step 2: Run — expect FAIL** (adapter still returns boolean + runs `verifyBoth`).
- [ ] **Step 3: Implement.** Change `VerifyBinding` return type to `Promise<'verified' | 'pending' | 'fail'>`. Run `verifyChannel2` (import from `two-channel-verifier`) only; map `kind: ok→'verified'`, `pending→'pending'`, `fail→'fail'`; no-context → `'fail'`. Keep `verifyBoth` import out of this module. Add the `verifyChannel2Impl`/`verifyChannel1Impl` test seams.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `refactor(substrate): admission verifies channel-2 only, 3-state (D-002)`.

---

### Task 4: Pending-retry in the admission path  [D-006]

**Files:**
- Modify: `apps/operator/lib/sync/hyperbee/read-admission.ts` (the pure `makeAdmissionDecider` + `AdmissionResult` — consume the 3-state `verifyBinding`, add a retryable `'pending'` outcome)
- Modify: `apps/operator/lib/sync/hyperbee/boot.ts` (the `makeAdmissionDecider` call + `onAnnounce` + a new pending set/timer)
- Test: `apps/operator/lib/sync/hyperbee/read-admission.test.ts` (extend — `verifyBinding`→`'pending'` yields `{admit:false, reason:'pending'}`, retry precedence stays revoked→bad_sig→pending/binding_invalid) + `apps/operator/lib/sync/hyperbee/__tests__/boot.test.ts` (extend) or a focused `admission-pending-retry.test.ts`

**Decider change (read-admission.ts):** `verifyBinding` now returns `'verified'|'pending'|'fail'`. Map in the decider: `'verified'`→`{admit:true}`; `'pending'`→`{admit:false, reason:'pending'}` (a NEW, retryable `AdmissionReason`); `'fail'`→`{admit:false, reason:'binding_invalid'}` (terminal). Precedence is unchanged: a `revoked` pubkey or a `bad_sig` still loses to nothing — both are checked BEFORE `verifyBinding` runs, so a revoked/forged peer is never put in the pending-retry set. Keep `AdmissionResult` shape additive (`reason` gains `'pending'`).

- [ ] **Step 1: Write failing test** — an announce whose binding is `'pending'` is not admitted immediately, is re-verified on a subsequent tick, and IS admitted once the verifier flips to `'verified'`; a `'fail'` binding is never retried.

```ts
it('pending peer is retried and admitted when channel-2 becomes visible', async () => {
  let state: 'pending' | 'verified' = 'pending';
  const handle = await bootHarnessSubstrate({
    /* ...test seams... */
    verifyBindingOverride: async () => state,            // now 3-state-aware
    pendingRetryMs: 10,
  });
  await handle.onAnnounce(frame);                        // first: pending → not admitted
  expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  state = 'verified';
  await waitFor(() => handle.admitted.has(frame.log_core_key), 200);  // retried → admitted
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** `onAnnounce`: on decision `'pending'`, store `{frame, since}` in a `pendingPeers: Map<logKey, {frame, since}>` and `recordBootEvent('announce_pending', ...)` (add this kind to `boot-history.ts` + `BootHistoryTable.tsx` KIND maps — keep the dual union exhaustive). A `setInterval(pendingRetryMs)` (unref'd, cleared on close) re-runs admission for each pending peer; on `'verified'` → admit + open remote log + merge + remove from pending; on `'fail'` → remove (no retry); past the grace window → remove + `announce_rejected`. `verifyBindingOverride` becomes 3-state. Thread `pendingRetryMs` (default ~5s) through opts.
- [ ] **Step 4: Run — expect PASS;** then full hyperbee suite green (`npx vitest run lib/sync/hyperbee/__tests__/`).
- [ ] **Step 5: Commit** — `feat(substrate): pending-retry admission for the channel-2 propagation window (D-006)`.

---

### Task 5: Announce freshness (`ts` + window)  [D-007]

**Files:**
- Modify: `apps/operator/lib/sync/hyperbee/announce.ts` (`AnnounceBody`, `announceSigningBytes`, `buildAnnounce`, `verifyAnnounce`)
- Test: `apps/operator/lib/sync/hyperbee/announce.test.ts` (extend)

- [ ] **Step 1: Write failing tests** — a fresh announce verifies; an announce with `ts` older than the window is rejected; `ts` is covered by the signature (tampering `ts` breaks the sig):

```ts
it('rejects a stale announce (ts outside freshness window)', () => {
  const frame = buildAnnounceSyncForTest({ ts: 1_000 });        // far in the past
  expect(verifyAnnounce(frame, { nowMs: 10_000_000, windowMs: 300_000 })).toBe(false);
});
it('accepts a fresh announce', () => {
  const frame = buildAnnounceSyncForTest({ ts: 9_900_000 });
  expect(verifyAnnounce(frame, { nowMs: 10_000_000, windowMs: 300_000 })).toBe(true);
});
it('ts is signed — tampering ts fails the sig', () => { /* mutate frame.ts post-sign ⇒ verifyAnnounce false */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Add `ts: number` (and optional `nonce: string`) to `AnnounceBody`; include them in `announceSigningBytes` field order (append after `log_core_key` so the signed bytes cover them); `buildAnnounce` stamps `ts` from an injected clock (default `Date.now()`; tests pass it — note Date.now() is fine in app code, only workflow scripts forbid it); `verifyAnnounce(frame, { nowMs?, windowMs? = 300_000 })` returns false if `Math.abs(nowMs - frame.ts) > windowMs` OR the sig check fails. boot.ts passes the live clock. **Wire-format change** — both peers use the new body (alpha, no back-compat); update `two-peer-swarm.test.ts`'s identity override to stamp `ts`.
- [ ] **Step 4: Run — expect PASS;** full hyperbee suite green.
- [ ] **Step 5: Commit** — `feat(substrate): announce freshness ts + window, replay hardening (D-007)`.

---

### Task 6: Join orchestrator → 6 Model-B steps + auto-boot  [D-005]

**Files:**
- Modify: `apps/operator/lib/harness/join-shared-harness.ts` (step ids, orchestrator, delete step8 Hyperbee-row)
- Test: `apps/operator/lib/harness/__tests__/join-shared-harness.test.ts` (rewrite step-list assertions)

- [ ] **Step 1: Write failing tests** — `JOIN_STEP_IDS` is `['oauth_attest','clone_repo','publish_binding','boot_federate','await_admission_merge','route_insights']`; `publish_binding` invokes `ensureMyBindingPublished` (spy); `boot_federate` boots the substrate (spy); a successful run reports `await_admission_merge` done when the injected "first-merge" signal fires; no `join_hyperswarm`/`seed_pg`/Hyperbee-row publish remain.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Replace the step list + `joinSharedHarness` body: `oauth_attest` (resolve identity via Task 1 + ensure device key), `clone_repo` (unchanged), `publish_binding` (call `ensureMyBindingPublished` — Task 2), `boot_federate` (call the harness boot path so the substrate joins the swarm + announces; inject the booter for tests), `await_admission_merge` (bounded poll for the first read-merge that includes a remote op, or a `phase_0`-style soft signal if no peer is online yet — inject the merge-progress reader), `route_insights` (unchanged). **Delete** `step3_joinHyperswarm`, `step5_seedPg`, and `step8_publishBinding` (+ their step ids + the `ALL_STEP_IDS` Hyperbee-row entries). Keep `JoinStepError`/`JoinStepStatus` shape so the UI/endpoint contract holds (statuses adapt).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `refactor(harness): join orchestrator → 6 Model-B steps + auto-boot (D-005)`.

---

### Task 7: `join-link` resolves identity server-side  [D-004]

**Files:**
- Modify: `apps/operator/lib/endpoint-route/routes/harness/join-link.ts`
- Test: `apps/operator/lib/endpoint-route/routes/harness/__tests__/join-link.test.ts` (create if absent; route handlers are unit-tested by invoking the exported handler with a fake `Request`)

- [ ] **Step 1: Write failing tests** — POST with only `{slug, harnessLinkUrl}` (no creds) + gh authed → calls `joinSharedHarness` with the resolved `{token, githubUserId, githubLogin}`; gh NOT authed → **401 `{code:'gh_auth_required'}`**; slug conflict → 409 (unchanged).
- [ ] **Step 2: Run — expect FAIL** (still requires body creds → 400 on empty).
- [ ] **Step 3: Implement.** Replace the body reads for `token/githubUserId/githubLogin` with `const id = await resolveLocalGithubIdentity()` (Task 1); on `gh_auth_required` → `Response.json({error:'GitHub authentication required', code:'gh_auth_required'}, {status:401})`; else derive `keychainId = resolveDeviceKeychainId(id.githubUserId)` and call the orchestrator with the resolved identity. Keep slug/`harnessLinkUrl` validation + 409.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(harness): join-link resolves gh identity server-side, gh_auth_required (D-004)`.

---

### Task 8: `share-finalize` publishes the publisher's binding  [D-003]

**Files:**
- Modify: `apps/operator/lib/endpoint-route/routes/harness/share-finalize.ts` (+ its `FinalizeShareDeps`)
- Test: `apps/operator/lib/endpoint-route/routes/harness/__tests__/share-finalize.test.ts` (extend)

- [ ] **Step 1: Write failing test** — `finalizeShare` calls `ensureMyBindingPublished` (injected dep) before/with the reboot, so the publisher's contributor file is published. Assert the dep is invoked with the resolved identity + the shared repo owner/name.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Add `ensureBinding?: (...) => Promise<...>` to `FinalizeShareDeps` (defaulting to `ensureMyBindingPublished` over `resolveLocalGithubIdentity` + the device key); call it after `shared.json` is written and the repo owner/name are known, before/alongside the reboot. Surface a non-fatal warning in `FinalizeShareResult` if it fails (don't block the share — the publisher can retry; but record it). Reuse the same identity+sign resolution as the announce path.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(harness): share-finalize publishes publisher binding (mutual binding, D-003)`.

---

### Task 9: Join UI wiring (`EntryHarnessLinkForm` + `JoinProgress`)  [D-004, D-005]

**Files:**
- Modify: `apps/operator/app/harness/EntryHarnessLinkForm.tsx`
- Modify: `apps/operator/app/harness/JoinProgress.tsx` (step labels)
- Test: `apps/operator/app/harness/__tests__/EntryHarnessLinkForm.test.tsx` (create/extend; RTL)

- [ ] **Step 1: Write failing test** — submitting the form POSTs `/api/harness/join-link` with body `{slug, harnessLinkUrl}` and **no** `token/githubUserId/githubLogin`; a 401 `gh_auth_required` response renders "Run `gh auth login`"; the progress list shows the 6 new step labels.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Remove the `token:''/githubUserId:0/githubLogin:''` body fields + the stale comment; on a `gh_auth_required` response set a clear error ("GitHub authentication required — run `gh auth login` in your terminal, then retry."); update `ALL_STEP_IDS`/labels to the 6 Model-B steps (`oauth_attest, clone_repo, publish_binding, boot_federate, await_admission_merge, route_insights`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(ui): join form uses server-side gh identity + new step list (D-004)`.

---

### Task 10: Deterministic two-identity bidirectional federation test  [Spec §6]

**Files:**
- Create: `apps/operator/lib/sync/hyperbee/__tests__/two-peer-swarm-bidi.test.ts`

- [ ] **Step 1: Write the test.** Like `two-peer-swarm.test.ts` (real testnet DHT + two real `hyperswarm` over `swarmOverride`), but with **two distinct identities** (Alice id=42, Bob id=7) each given an **injected `verifyChannel2`** (via a new `verifyBindingOverride` that's now 3-state, returning `'verified'` for the *other* peer's known pubkey, `'fail'` otherwise). Both peers `append` an op; poll both `mergeNow()`s until **each peer's apply sink captures the OTHER's op** (bidirectional). Assert: `handleA.admitted` has B's log AND `handleB.admitted` has A's log; A's apply sink has B's op AND vice-versa. Generous bound (~20s), full teardown (handles, swarms, testnet, tmp dirs), `mergePollMs:0`.
- [ ] **Step 2: Run — expect PASS** (2-3× for flakiness). `cd apps/operator && npx vitest run lib/sync/hyperbee/__tests__/two-peer-swarm-bidi.test.ts`
- [ ] **Step 3: Run full hyperbee suite — green.**
- [ ] **Step 4: Commit** — `test(substrate): deterministic two-identity BIDIRECTIONAL federation test (§6)`.

---

### Task 11: Record known limitations + the verified-commit note  [D-008, R-1]

**Files:**
- Modify: `apps/operator-docs/src/content/docs/agent-insights/` (new MDX) OR the substrate testing doc — record: (a) one verifiable device per GitHub login (multi-device collision) + the fix shape (array of pubkeys / per-device path); (b) login-rename fragility; (c) the verified-commit requirement (publish via Contents API, never local git push).
- [ ] **Step 1:** Write the insight MDX (format per agent-policies §18). 
- [ ] **Step 2:** `cd apps/operator-docs && npm run build` to confirm it renders.
- [ ] **Step 3: Commit** — `docs(substrate): Phase-1b known limitations (multi-device, login-rename, verified-commit)`.

---

## Verification (whole-plan)

1. All task tests green; full hyperbee suite green; affected-test sweep clean.
2. Restart `:3070`; through the Tauri shell, Entry 4 join with only local `gh` auth resolves identity server-side (no 400), publishes a verified contributor file, boots, and `await_admission_merge` completes against a peer.
3. `two-peer-swarm-bidi.test.ts` proves bidirectional convergence deterministically.
4. Manual final acceptance: real two-GitHub-account, two-machine P-079 (now runnable) — 5+/7 steps within 30s.

## Open risk carried from the spec

- **R-1** is resolved by Task 2 (Contents API verified commit). If, during Task 2, `repos.createOrUpdateFileContents` commits turn out NOT to be `verification.verified` in this GitHub-App/token context, STOP and escalate — the fallback (register the device key as an account SSH/GPG signing key, or a GitHub App with commit signing) is a larger decision.
