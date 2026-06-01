# Model B Substrate Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Repo discipline (this project):** work on `main` directly — no branches/worktrees/PRs. Commit each task with `git add <paths> && git commit --no-verify` (Co-Authored-By trailer per CLAUDE.md). Run the affected vitest after each impl step. Server-side code on `:3070` has **no hot-reload** — `systemctl --user restart papercup-dev-api.service` to exercise live.

**Goal:** Replace the per-harness multi-writer Autobase substrate with per-peer single-writer signed Hypercore logs + a local LWW-register read-merge, so two engineers' shared-harness state actually replicates (and is forge-resistant + revocable) — per the approved spec `papercusp-substrate-model-b-rewrite-2026-05-31.md`.

**Architecture:** Three layers — **transport** (Hyperswarm + DoS guard, KEEP), **data** (Autobase → per-peer signed logs + read-merge, REPLACE), **projection→PG** (`projections/*` + `applyHyperbeeOpToPg` + LWW helper, KEEP). Each peer appends only to its own signed log; peers exchange a signed `announce` on connect; a peer aggregates any log with a valid two-channel binding (NO collaborator gate — GitHub's PR-merge is the real authority); the read-merge resolves `(table,key[,field])` last-writer-wins and feeds the existing projection writers. Substrate is always-on (flag removed). Claims become LWW advisory hints + the existing clobber-toast.

**Tech Stack:** TypeScript (tsx host), Hypercore/Corestore/Hyperswarm (Holepunch), Postgres (per-harness, via `getOrgPg()`), Vitest 4, Ed25519 device keys (Phase-1b keychain), the Phase-1b two-channel binding service.

**Reused interfaces (verified — do NOT reinvent):**
- `applyHyperbeeOpToPg(op: OpEnvelope): Promise<boolean>` + `getProjection`/`registerProjection` + `pickLwwWinner` in `lib/sync/hyperbee/projection.ts`. `OpEnvelope = {type:'put'|'del'|'addWriter', table?, hbKey?, value?, schema_version?, ts?, writerPubkey?}` (`autobase-setup.ts`).
- `registerAllHarnessProjections({workspaceId, harnessSlug})` (`projections/register-all.ts`) — the per-table writers stay.
- `getHarnessStore({workspaceRoot, harnessSlug})` → `Corestore` (`corestore.ts`) — KEEP.
- `joinHarnessSwarm`/`getSharedSwarm` + `swarm-guard.ts` — KEEP; we add a per-author ingest cap.
- `deriveSwarmTopic({kind:'gh', github_repository_id})` — KEEP (topic unchanged).
- `observeMergedOp` (clobber-events) — KEEP; the read-merge fires it on cross-author override.

---

## Stage 0 — De-risking spike (verify the 4 unknown APIs before writing dependent code)

The low-level Holepunch + crypto APIs aren't yet verified against the installed versions. This stage produces a short findings note that the literal code in Stages 1/3 depends on. **No production code ships from Stage 0** — it's throwaway probes + a written findings file. (This is a real task, not a placeholder: research-adjacent work spikes the unknowns first.)

**Files:**
- Create (throwaway): `apps/operator/scripts/_spike/model-b-probe.mjs` (deleted at end of stage)
- Create: `apps/operator/docs/plans/model-b-spike-findings-2026-06-01.md`

- [ ] **Step 1: Probe the single-writer Hypercore log API.** In the probe, open a `Corestore` temp dir; `const log = store.get({ name: 'peer-log', valueEncoding: 'json' })`; `await log.ready()`; `await log.append({hello:1})`; read back via `log.length` + `await log.get(0)`. Confirm: the API to (a) get *your own* named writable core, (b) append, (c) read `[0,length)`. Record the exact method names + whether `valueEncoding:'json'` is supported or we encode ourselves.
- [ ] **Step 2: Probe reading ANOTHER peer's log by key.** From the same store, `store.get({ key: <other core's public key Buffer> })` (read-only replica); confirm how to obtain a core's public key (`log.key` / `log.discoveryKey`) and that a second store replicating the first (via `store.replicate`) can read its entries. Record the key type (Buffer) + how replication surfaces the remote core's length/entries.
- [ ] **Step 3: Probe device-key signing.** Locate the Phase-1b device keypair accessor (grep `lib/identity/` for keychain/ed25519). Confirm how to load the device Ed25519 keypair and `sign(bytes)` / `verify(bytes, sig, pubkey)`. Record the exact import + signature (likely `sodium`/`hypercore-crypto`).
- [ ] **Step 4: Probe the binding-verify API.** In `lib/harness/binding-service.ts` confirm the call that, given a `device_pubkey` + `github_login`, validates the two-channel binding (the Phase-1b verifier). Record its signature + return shape.
- [ ] **Step 5: Probe the swarm announce channel.** In `swarm.ts`, the `connection` handler hands a `socket` (a Noise-encrypted stream). Confirm whether we can write a length-prefixed JSON `announce` frame on it *before* piping to `store.replicate`, or whether we need a dedicated protomux channel. Record the chosen mechanism.
- [ ] **Step 6: Write findings.** Fill `model-b-spike-findings-2026-06-01.md` with the verified signatures for Steps 1-5 (exact code snippets). This is the API contract Stages 1/3 cite.
- [ ] **Step 7: Delete the probe + commit findings.**

```bash
rm apps/operator/scripts/_spike/model-b-probe.mjs
git add apps/operator/docs/plans/model-b-spike-findings-2026-06-01.md
git commit --no-verify -m "docs(model-b): spike findings — verified Hypercore/crypto/announce APIs"
```

---

## Stage 1 — Per-peer log module (`peer-log.ts`)

One module owning a peer's *own* writable log + read-only handles to others'. Pure over an injected `Corestore` so it's unit-testable without the network.

**Files:**
- Create: `apps/operator/lib/sync/hyperbee/peer-log.ts`
- Test: `apps/operator/lib/sync/hyperbee/peer-log.test.ts`

- [ ] **Step 1: Write the failing test for the own-log append/read.**

```ts
import { describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOwnLog, type PeerLogOp } from './peer-log';

describe('peer-log own log', () => {
  it('appends ops and reads them back in order', async () => {
    const store = new Corestore(mkdtempSync(join(tmpdir(), 'mb-')));
    await store.ready();
    const log = await openOwnLog(store);
    const op: PeerLogOp = { table: 'features_consolidated', hbKey: 'F-1', type: 'put', value: { id: 'F-1' }, ts: 100, schema_version: 1 };
    await log.append(op);
    expect(log.length).toBe(1);
    expect(await log.get(0)).toMatchObject({ hbKey: 'F-1', ts: 100 });
    expect(log.keyHex).toMatch(/^[0-9a-f]{64}$/);
    await store.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `cd apps/operator && npx vitest run lib/sync/hyperbee/peer-log.test.ts` → FAIL (`openOwnLog` not defined).
- [ ] **Step 3: Implement `openOwnLog` + `openRemoteLog`** using the Stage-0-verified Hypercore API. `PeerLogOp` = `OpEnvelope` minus `addWriter` (single-writer logs never carry admission ops), plus a required `author_pubkey` stamped at append. `openOwnLog(store)` → `{ append(op), get(i), length, keyHex }` over `store.get({name:'peer-log'})`. `openRemoteLog(store, keyHex)` → read-only `{ get(i), length, keyHex }` over `store.get({key: Buffer.from(keyHex,'hex')})`. (Use the exact `append`/`get`/`length` shape from the spike findings.)
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit.** `git add lib/sync/hyperbee/peer-log.ts lib/sync/hyperbee/peer-log.test.ts && git commit --no-verify -m "feat(model-b): per-peer single-writer log module"`

---

## Stage 2 — LWW read-merge (`read-merge.ts`, replaces the Autobase replay in the read-loop)

Aggregate N admitted logs → per-`(table,hbKey)` LWW → feed the **existing** `applyHyperbeeOpToPg`. Reuses `pickLwwWinner` from `projection.ts`.

**Files:**
- Create: `apps/operator/lib/sync/hyperbee/read-merge.ts`
- Test: `apps/operator/lib/sync/hyperbee/read-merge.test.ts`

- [ ] **Step 1: Write the failing test — two authors, later ts wins, applied via projection.**

```ts
import { describe, it, expect, vi } from 'vitest';
import { mergeAdmittedLogs, type AdmittedLog } from './read-merge';

function fakeLog(keyHex: string, ops: unknown[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i: number) => ops[i] };
}

describe('mergeAdmittedLogs', () => {
  it('resolves same-key conflicts last-writer-wins across authors, then applies', async () => {
    const apply = vi.fn(async () => true);
    const logs = [
      fakeLog('a'.repeat(64), [{ table: 'features_consolidated', hbKey: 'F-1', type: 'put', value: { status: 'todo' }, ts: 100, author_pubkey: 'a'.repeat(64) }]),
      fakeLog('b'.repeat(64), [{ table: 'features_consolidated', hbKey: 'F-1', type: 'put', value: { status: 'done' }, ts: 200, author_pubkey: 'b'.repeat(64) }]),
    ];
    const applied = await mergeAdmittedLogs(logs, { applyImpl: apply });
    expect(applied).toBe(1); // one winning op applied for F-1
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toMatchObject({ value: { status: 'done' }, ts: 200 });
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `mergeAdmittedLogs(logs, opts)`** — read `[0,length)` of each admitted log; group ops by `(table, hbKey)`; keep the winner per group via `pickLwwWinner` (later `ts`; `del` beats `put` on tie); stamp `writerPubkey = author_pubkey` on each winner; `await (opts.applyImpl ?? applyHyperbeeOpToPg)(winner)` for each group. Return the count applied. Idempotent (projection writers are upserts). `AdmittedLog = { keyHex, length, get }`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Add + run a `del`-beats-`put`-on-tie test and a multi-table test** (literal cases mirroring Step 1).
- [ ] **Step 6: Commit.** `-m "feat(model-b): LWW read-merge over admitted per-peer logs"`

---

## Stage 3 — Signed announce + read-admission (`read-admission.ts`)

The security core (D-004): a signed `announce` per peer; admit iff sig-valid AND a valid two-channel binding (any real GitHub identity; **no collaborator gate**). Maintains the admitted set + `revoked_pubkeys`.

**Files:**
- Create: `apps/operator/lib/sync/hyperbee/announce.ts` (wire-format: build/sign/verify a `{device_pubkey, github_user_id, github_login, log_core_key, sig}` frame — uses Stage-0 sign/verify)
- Create: `apps/operator/lib/sync/hyperbee/read-admission.ts` (the admitted-set manager + the admit decision)
- Test: `apps/operator/lib/sync/hyperbee/announce.test.ts`, `read-admission.test.ts`

- [ ] **Step 1: Failing test — announce sign/verify round-trips, tamper fails.** (Sign a fixed announce with a test keypair from the spike's crypto API; assert `verifyAnnounce` true; flip a byte of `log_core_key` → false.)
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement `buildAnnounce`/`verifyAnnounce`** per spike crypto. **Step 4: PASS. Step 5: Commit** `-m "feat(model-b): signed announce wire-format"`.
- [ ] **Step 6: Failing test — admission decision.** Inject a fake binding-verifier:

```ts
const admit = makeAdmissionDecider({ verifyBinding: async (pk, login) => pk === 'good' && login === 'alice' });
expect(await admit({ device_pubkey: 'good', github_login: 'alice', sigValid: true })).toEqual({ admit: true });
expect(await admit({ device_pubkey: 'good', github_login: 'alice', sigValid: false })).toMatchObject({ admit: false, reason: 'bad_sig' });
expect(await admit({ device_pubkey: 'bad', github_login: 'alice', sigValid: true })).toMatchObject({ admit: false, reason: 'binding_invalid' });
// NO collaborator check: a valid binding for ANY login is admitted.
```

- [ ] **Step 7: Run → FAIL. Step 8: Implement `makeAdmissionDecider({verifyBinding})`** — admit iff `sigValid && await verifyBinding(device_pubkey, github_login)`; honor a `revoked_pubkeys` Set (drop if present). Wire the real `verifyBinding` to the binding-service call from the spike findings. **Step 9: PASS. Step 10: Commit** `-m "feat(model-b): read-admission — binding-verified, no collaborator gate, revocable"`.

---

## Stage 4 — Boot rewrite (`boot.ts`) + flag removal

Swap the Autobase wiring for: own-log + admitted-set + read-merge driven by swarm announces. Keep corestore, swarm join, projection registration, boot-history, health.

**Files:**
- Modify: `apps/operator/lib/sync/hyperbee/boot.ts` (replace the `createAutobaseHarness` + read-loop block with peer-log + read-merge + admission)
- Modify: `apps/operator/lib/sync/hyperbee/swarm.ts` (on connect: exchange announce → admit → start replicating the remote log → re-run merge)
- Modify: `apps/operator/bin/host-bootstrap.ts`, `apps/operator/lib/endpoint-route/routes/harness/share-finalize.ts` (remove `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` reads — substrate always-on)
- Retire: `apps/operator/lib/sync/hyperbee/autobase-setup.ts` (+ its test), the read-loop's Autobase path
- Test: update `boot.test.ts`; `boot-all.test.ts` fake handle gains `ownLog`/admitted-set instead of `base`

- [ ] **Step 1: Failing test — boot opens an own-log + merge loop, no Autobase.** Update `boot.test.ts` to assert the returned handle exposes `ownLog.keyHex` + a `mergeNow()` and NOT `base`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Rewrite `bootHarnessSubstrateInner`** — `store = getHarnessStore(...)`; `ownLog = openOwnLog(store)`; `registerAllHarnessProjections(...)`; build the admitted set (seeded with self); `mergeNow = () => mergeAdmittedLogs([ownLog, ...admitted], {})`; on swarm `connection` (Stage 4 Step 5) admit + add remote log + `mergeNow()`; keep boot-history + bootstrap-progress (repoint to `ownLog.length`). Drop `createAutobaseHarness`, `bootstrap`, the schema-version `apply` gate (move the `acceptOpVersion` check into the merge — drop unknown-newer ops there).
- [ ] **Step 4: Run boot.test → PASS.**
- [ ] **Step 5: Wire the announce exchange in `swarm.ts`** — on `connection`, before `store.replicate`, write our `buildAnnounce(...)` frame + read the peer's; pass it to the boot-provided `onAnnounce(announce)` callback (which runs the admission decision + `openRemoteLog` + `mergeNow`). Gate the existing DoS guard first (unchanged). Add a test with a fake socket asserting a valid announce → `onAnnounce` called, forged → not.
- [ ] **Step 6: Remove the flag.** Delete the `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` check in `host-bootstrap.ts` (always boot shared harnesses) + in `share-finalize.ts` `realDeps.reboot` (always reboot) + the retired `instrumentation-node.ts:341` block. Grep `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` → zero hits remain. Update `.env.local` comment (the var is now a no-op).
- [ ] **Step 7: tsc gate** — `npx tsc --noEmit -p apps/operator/tsconfig.json 2>&1 | grep -E 'sync/hyperbee|host-bootstrap|share-finalize'` → no new errors. **Step 8: Commit** `-m "feat(model-b): boot on per-peer logs + read-merge + announce admission; remove substrate flag; retire Autobase"`.

---

## Stage 5 — Claims become LWW advisory (`feature-claim.ts`)

Remove the Autobase merge-order arbitration; a claim is an LWW op in the own-log; contention → existing clobber-toast.

**Files:**
- Modify/replace: `apps/operator/lib/orchestrator/feature-claim.ts` (+ test)
- Verify: the `feature_claims` projection writer already LWW-upserts (it does — `projections/*`); the clobber-toast already fires via `observeMergedOp` in `applyHyperbeeOpToPg`.

- [ ] **Step 1: Failing test — `claimFeature` appends an LWW claim op + returns advisory holder.** Assert it appends `{table:'feature_claims', hbKey: feature_id, type:'put', value:{claimer_github_user_id, ts}, ts, author_pubkey}` to the own-log and returns `{ claimed: true }` (no merge-order wait). A second claim with a later ts wins on read-merge; the older claimant's row is clobber-toasted.
- [ ] **Step 2: Run → FAIL. Step 3: Reimplement `claimFeature(ownLog, {feature_id, claimer_github_user_id})`** — append the LWW claim op; return immediately (advisory). Delete `ClaimAutobaseHandle`/`MergedClaim`/the seq-tiebreak logic (Autobase-only). **Step 4: PASS.**
- [ ] **Step 5: Update the orchestrator call site** (`distributed-claim*.ts`) to the new signature; on a later clobber the orchestrator backs off (reuse the existing P-037d backoff). **Step 6: tsc gate + commit** `-m "feat(model-b): LWW advisory claims, drop Autobase merge-order arbitration"`.

---

## Stage 6 — Per-author ingest cap (DoS Phase-4 reshape, D-006)

A noisy author bloats only its own log; cap how much of one author's log we ingest per merge pass.

**Files:**
- Modify: `apps/operator/lib/sync/hyperbee/read-merge.ts` (per-log op cap) + test

- [ ] **Step 1: Failing test — a log exceeding `maxOpsPerAuthor` is truncated at read + logged.** **Step 2: FAIL. Step 3: Implement** an `opts.maxOpsPerAuthor` (default e.g. 50_000) — read at most that many ops from any single log per pass; emit a `boot-history` `peer_capped` event (mirror the existing observability). **Step 4: PASS. Step 5: Commit** `-m "feat(model-b): per-author ingest cap (DoS Phase-4 reshape)"`.

---

## Stage 7 — Two-peer-on-one-box verification (the proof)

Integration harness: two corestores/instances on this box, same topic (`999000001`), distinct device keys + logs.

**Files:**
- Create: `apps/operator/lib/sync/hyperbee/__tests__/two-peer.integration.test.ts`

- [ ] **Step 1: Replication test** — boot peer A + peer B (two stores, two own-logs, a shared in-memory/loopback swarm), exchange valid announces, peer A appends a `features_consolidated` op → assert it lands via peer B's `mergeAdmittedLogs` → peer B's projection writer called with peer A's row.
- [ ] **Step 2: Admission-refusal test** — peer C announces with a forged binding (verifyBinding → false) → peer B never opens C's log; C's op never applies.
- [ ] **Step 3: Revocation test** — add C's pubkey to `revoked_pubkeys` → subsequent C ops dropped.
- [ ] **Step 4: LWW-claim test** — A and B both claim F-042; later ts wins on both peers; the loser's `observeMergedOp` clobber path fires.
- [ ] **Step 5: Run the integration suite → all pass. Step 6: Commit** `-m "test(model-b): two-peer replication + admission + revocation + LWW claim"`.
- [ ] **Step 7: Live two-machine smoke (manual, user-driven)** — note in the plan that the real cross-machine P-079 verification (two desktops) is the user's final acceptance step; document the steps in the substrate handoff doc.

---

## Self-review (run before handing off to execution)

- **Spec coverage:** D-001 (B) → Stages 1-4; D-002 (LWW claims) → Stage 5; D-003 (LWW-register merge) → Stage 2; D-004 (announce admission, no collaborator gate) → Stage 3; D-005 (always-on, flag removed) → Stage 4 Step 6; D-006 (per-author cap) → Stage 6; D-007 (auditor out) → not built (correct). Two-peer test → Stage 7. ✅ all covered.
- **Spike-gated honesty:** Stages 1 & 3 cite Stage-0 findings for the Hypercore/crypto/announce API specifics rather than fabricating method names — verify those signatures in Stage 0 before writing the impl steps.
- **Type consistency:** `PeerLogOp`/`AdmittedLog`/`OpEnvelope` names match across Stages 1-2; `verifyBinding` signature matches Stages 3 & 4; `ownLog.keyHex` used consistently.

## Open items surfaced for execution

- Stage 0 must confirm the announce channel (raw frame vs protomux) — Stage 4 Step 5's wiring depends on it.
- The schema-version gate moves from the Autobase `apply` to the read-merge (Stage 4 Step 3) — keep `acceptOpVersion` behavior identical (drop unknown-newer).

## Cross-references
- Spec: `papercusp-substrate-model-b-rewrite-2026-05-31.md` (decisions D-001..D-007).
- Spike findings (Stage 0 output): `model-b-spike-findings-2026-06-01.md`.
- Trust model: `papercusp-trust-model-2026-05-31.md` Addendum C/D. DoS: `hyperswarm-dos-hardening-2026-05-31.md`.
