# Model B Substrate — Stage 0 Spike Findings (verified low-level APIs)

> **Status:** Stage 0 of `papercusp-substrate-model-b-impl-2026-06-01.md`. This is the
> API contract the literal code in Stages 1–6 cites. Each finding is marked
> **[run-verified]** (proven by running a throwaway probe) or **[read-verified]**
> (confirmed by reading the installed library / repo source, not executed here).
>
> The probe (`apps/operator/scripts/_spike/model-b-probe.mjs`) was deleted at the end
> of the stage per plan; only this doc is committed.

## Installed versions (what these findings are pinned to)

| Package | Version |
|---|---|
| `corestore` | 7.9.2 |
| `hypercore` | 11.30.2 |
| `hyperswarm` | 4.17.0 |
| `hypercore-crypto` | 3.7.0 |
| `autobase` | 7.28.1 (being retired) |
| `@hyperswarm/secret-stream` | 6.9.1 |
| `protomux` | 3.11.0 |
| `compact-encoding` | 3.1.0 |
| Node `crypto` Ed25519 | built-in |

Probe ran from `apps/operator/` via `node scripts/_spike/model-b-probe.mjs`; all four
runnable steps passed. Steps 1, 2, 3(primitive), 5 are run-verified; the production
device-key load path (Step 3) and the binding-verify call (Step 4) are read-verified
from repo source (they need a live keychain / GitHub, not exercisable in a subprocess).

---

## ⚠️ Plan-assumption corrections (read these before writing Stages 1–6)

The impl/rewrite plans named some APIs speculatively. Three were **wrong** — the
literal code in later stages must use the corrected names/shapes below:

1. **Device signing is Node `crypto` Ed25519, NOT `hypercore-crypto` / `sodium`.**
   Stage-0 Step 3 (and impl-plan Step 3) guessed "likely `sodium`/`hypercore-crypto`".
   The Phase-1b identity layer (`lib/identity/attest.ts`, `keychain.ts`,
   `two-channel-verifier.ts`) signs/verifies with **`node:crypto`** `sign(null, …)` /
   `verify(null, …)` over PKCS8/SPKI-DER Ed25519 keys, and represents the public key
   as the **raw 32-byte key, base64-encoded** (not hex, not a hypercore-crypto keypair).
   Stage 3's `buildAnnounce`/`verifyAnnounce` MUST use the same primitive + the same
   raw-32-byte-base64 pubkey representation so the announce pubkey is the **same string**
   as the binding's `device_pubkey`. See Step 3 below.

2. **The two-channel binding verifier lives in `lib/identity/two-channel-verifier.ts`
   (`verifyBoth`), NOT in `lib/harness/binding-service.ts`.** Impl-plan Step 4 points at
   `binding-service.ts` — that module is the **repo↔harness** binding (it *does* do
   GitHub collaborator/permission checks: `getRepoPermission`, `CLAIM_REQUIRED_PERMISSION`).
   That is the WRONG call for read-admission, which D-004 says is "any real GitHub
   identity, **no collaborator gate**". The correct call is `verifyBoth(...)` (device_pubkey
   ↔ github identity, two independent channels, no repo-permission check). See Step 4.

3. **The LWW helper is `lwwPick(a, b)`, NOT `pickLwwWinner`.** Both plans cite
   `pickLwwWinner` in `projection.ts`; no such export exists. The real export is
   `lwwPick(a: OpEnvelope, b: OpEnvelope): OpEnvelope` in
   `lib/sync/hyperbee/projection.ts:91`. Stages 2 & 6 must call `lwwPick`.

Everything else in the plans matched. `valueEncoding:'json'` **is** supported (good —
no manual encode/decode needed); reading a remote core **does** need an explicit
`await core.update()` (noted in Step 2; the impl plan's read-merge must account for it
when driving merges off a live remote log).

---

## Step 1 — Single-writer Hypercore log (own writable core) — **[run-verified]**

Open a `Corestore`, get your **own named** core, append, read `[0, length)`.

```js
import Corestore from 'corestore';

const store = new Corestore(dir);            // mirror corestore.ts: new Corestore(path)
await store.ready();

// (a) your own NAMED, WRITABLE core. `name` ⇒ derived from the store's keypair ⇒ writable.
const log = store.get({ name: 'peer-log', valueEncoding: 'json' });
await log.ready();
log.writable;                                // true  (run-verified)

// (b) append — objects go straight in (valueEncoding:'json' handles serialization)
await log.append({ table: 'features_consolidated', hbKey: 'F-1', ts: 100 });
await log.append({ table: 'features_consolidated', hbKey: 'F-2', ts: 200 });
log.length;                                  // 2     (run-verified)

// (c) read [0, length) — get(i) RETURNS A DECODED OBJECT (not a Buffer) under json encoding
const op0 = await log.get(0);                // { table:'features_consolidated', hbKey:'F-1', ts:100 }  — a JS object
typeof op0;                                  // 'object'  (run-verified)

// (e) own public key — Buffer(32) → hex(64)
Buffer.isBuffer(log.key);                    // true
log.key.length;                              // 32
const keyHex = log.key.toString('hex');      // 64-char lowercase hex (run-verified)
log.discoveryKey;                            // Buffer(32) — also available
```

Findings:
- **(d) `valueEncoding:'json'` WORKS — no manual encode/decode.** `append(obj)` and
  `get(i)` round-trip a plain object. The impl plan's `openOwnLog` should pass
  `valueEncoding:'json'` and treat `get(i)` as already-decoded `PeerLogOp`.
- A core opened by **`name`** is the store's own writable core (one keypair per name,
  derived from the store master key) — this is `openOwnLog(store)`.
- `log.key` is a **32-byte Buffer**; `keyHex = log.key.toString('hex')` is the 64-hex
  string used as `PeerLogOp.author_pubkey` / `AdmittedLog.keyHex` / the announce
  `log_core_key`. NOTE: this **Hypercore key is distinct from the device Ed25519
  pubkey** — the announce carries BOTH (`device_pubkey` = identity, `log_core_key` =
  the hypercore to replicate). Don't conflate them.

`openOwnLog(store)` → `{ append(op), get(i), length, keyHex }` over
`store.get({ name:'peer-log', valueEncoding:'json' })`.

---

## Step 2 — Reading ANOTHER peer's log by key (read-only replica) — **[run-verified]**

From a **second** Corestore, open core1 by its key as a read-only replica and replicate
the two stores together.

```js
const store1 = new Corestore(dir1); await store1.ready();
const store2 = new Corestore(dir2); await store2.ready();

const core1 = store1.get({ name:'peer-log', valueEncoding:'json' });
await core1.ready();
await core1.append({ hbKey:'R-1', ts:10 });
await core1.append({ hbKey:'R-2', ts:20 });

// store2 opens core1 BY KEY (Buffer) → read-only replica
const remote = store2.get({ key: core1.key, valueEncoding:'json' });   // key is a Buffer
await remote.ready();
remote.writable;                       // false (run-verified)
remote.length;                         // 0 — NOTHING until replication + update()

// Replicate: corestore.replicate(isInitiator:boolean) → a protocol Duplex stream; pipe both ways.
const s1 = store1.replicate(true);
const s2 = store2.replicate(false);
s1.pipe(s2).pipe(s1);                  // bidirectional (mirrors swarm.ts's local.pipe(peer); peer.pipe(local))

// REQUIRED: an explicit update() to learn the remote length …
await remote.update({ wait: true });
remote.length;                         // 2 (run-verified)

// … and get(i, {wait:true}) to block until the block downloads.
const r0 = await remote.get(0, { wait:true });   // { hbKey:'R-1', ts:10 }
const r1 = await remote.get(1, { wait:true });    // { hbKey:'R-2', ts:20 }

// Live appends on the writer propagate after ANOTHER update():
await core1.append({ hbKey:'R-3', ts:30 });
await remote.update({ wait:true });
remote.length;                         // 3
await remote.get(2, { wait:true });    // { hbKey:'R-3', ts:30 }
```

Findings:
- `store.get({ key: <Buffer> })` is the read-only-replica handle — pass `core1.key`
  (a Buffer) directly, or `Buffer.from(keyHex,'hex')`. `openRemoteLog(store, keyHex)`
  → `store.get({ key: Buffer.from(keyHex,'hex'), valueEncoding:'json' })`.
- **A remote core needs an explicit `await core.update({wait:true})`** before
  `length` reflects the writer's appends — replication does not auto-advance `length`
  on its own from a cold open. The read-merge (Stage 2) and the `mergeNow()` driver
  (Stage 4) MUST `await remote.update()` per pass (or subscribe to the remote core's
  `'append'` event and `update()` on it) before reading `[0,length)`, or it will read
  a stale/short length. The plan's "polled fallback + 'append' events" is the right
  shape; the literal code must call `update()` in the poll.
- `core.get(i, { wait:true })` (the default is `wait:true`) blocks until the block is
  downloaded; use it for remote reads. For the OWN log, `get(i)` is immediate.
- `corestore.replicate(true|false)` returns a Duplex you pipe. **For the real swarm
  path, prefer passing the Hyperswarm connection directly as an external stream:
  `store.replicate(socket)` — see Step 5; that single call both replicates AND sets up
  the shared muxer the announce channel rides on.**

---

## Step 3 — Device-key signing (Ed25519 via Node `crypto`) — primitive **[run-verified]**, production load path **[read-verified]**

**The production device keypair is Phase-1b, in `lib/identity/`. It is Node-`crypto`
Ed25519, NOT `hypercore-crypto`/`sodium`** (see correction #1).

### Production load + pubkey shape — [read-verified] (`lib/identity/attest.ts`, `keychain.ts`)

```ts
import { loadOrGenerateDeviceKeypair } from '@/lib/identity/attest';
// keychainId convention: `<github_user_id>:<machine-fingerprint>`
const { keychainId, pubkeyBase64 } = await loadOrGenerateDeviceKeypair(keychainId);
//   pubkeyBase64 = RAW 32-byte Ed25519 public key, base64-encoded (NOT 44-byte SPKI).
//   The PRIVATE key never leaves keychain.ts; it is stored as PKCS8 DER via
//   keychainStore/keychainLoad (secret-tool → security CLI → AES-256-GCM file fallback).
```

The private key is loaded inside the identity module only:
`keychainLoad(keychainId)` → PKCS8 DER Buffer → `createPrivateKey({key, format:'der', type:'pkcs8'})`.
**Signing must therefore happen behind a small identity-layer helper** (the announce
signer should call into `lib/identity`, not re-read the keychain itself), because
`loadOrGenerateDeviceKeypair` deliberately returns only the pubkey — the private key
is not handed out. Stage 3 should add a tiny `signWithDeviceKey(keychainId, bytes)` in
`lib/identity` (mirroring `attest.ts`'s private `signPayload`) rather than reaching
into keychain from `announce.ts`.

### Sign / verify primitive — [run-verified]

```js
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey } from 'node:crypto';

// Test-friendly keypair (Stages 3 & 7 tests use this instead of the live keychain):
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPub = publicKey.export({ type:'spki', format:'der' }).subarray(-32); // 32 bytes
const pubBase64 = rawPub.toString('base64');                                   // == device_pubkey shape

// SIGN — algorithm MUST be null for Ed25519. Returns a 64-byte Buffer.
const sig = nodeSign(null, payloadBuf, privateKey);   // sig.length === 64 (run-verified)

// VERIFY — rebuild a public key from the raw 32-byte base64 (the 12-byte Ed25519 SPKI prefix):
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const spkiDer    = Buffer.concat([spkiPrefix, Buffer.from(pubBase64, 'base64')]);
const pub        = createPublicKey({ key: spkiDer, format:'der', type:'spki' });
nodeVerify(null, payloadBuf, pub, sig);               // true for good (run-verified)
//   tampered payload → false; tampered signature → false (both run-verified)
```

Findings / contract for `buildAnnounce`/`verifyAnnounce` (Stage 3):
- **Sign:** `nodeSign(null, canonicalBytes, privateKey)` → 64-byte Buffer → `.toString('base64')` as `sig`.
- **Verify:** reconstruct SPKI from the raw-32-byte base64 `device_pubkey` with the
  fixed prefix `302a300506032b6570032100`, then `nodeVerify(null, canonicalBytes, pub, Buffer.from(sig,'base64'))`.
- **Canonicalization:** the identity layer signs a **field-ordered JSON** of the body
  (no nested objects ⇒ ordered `JSON.stringify` == JCS for primitive schemas — see
  `attest.ts:canonicalPayloadForSigning` and `two-channel-verifier.ts:jcsSerialize`).
  The announce body `{device_pubkey, github_user_id, github_login, log_core_key}` is
  all primitives, so pick a FIXED field order and `JSON.stringify` it — exclude `sig`
  from the signed bytes (sign the rest, then attach `sig`). Mirror the existing
  helpers exactly so behavior matches.
- Helper signature: `verify(bytes: Buffer, sig: Buffer, pubkeyBase64: string): boolean`
  with the raw-32-byte-base64 pubkey convention above (matches `attest.ts`'s
  `verifyEd25519Signature` + `buildSpkiDerFromRawPubkey`).

---

## Step 4 — Binding-verify API (read-admission) — **[read-verified]**

Read-admission (D-004) = "is `device_pubkey` ↔ `github_login` a valid two-channel
binding, for ANY real GitHub identity, **no collaborator gate**". The correct call is
in `lib/identity/two-channel-verifier.ts` — NOT `binding-service.ts` (see correction #2).

### `verifyBoth(opts)` — the two-channel verifier

```ts
import { verifyBoth, type VerifyBothOptions } from '@/lib/identity/two-channel-verifier';
import type { BindingVerificationResult } from '@/lib/identity/binding-verifier-types';

const result: BindingVerificationResult = await verifyBoth({
  channel1: {                       // OAuth: GET /user id == claimedGithubUserId
    token,                          // GitHub OAuth token, ≥ read:user
    claimedGithubUserId,            // number
    // fetchFn?  (test seam)
  },
  channel2: {                       // signed contributor file on user/<id> branch
    repoOwner, repoName,
    githubLogin,                    // string — login the file path is built from
    githubUserId,                   // number — branch ref user/<id>
    devicePubkeyBase64,             // RAW 32-byte base64 — MUST equal announce.device_pubkey
    token,                          // optional
    // fetchFn?  (test seam)
  },
  // channel2PendingSince?, graceWindowMs?, nowMs?  (grace-window controls)
});
```

Return shape (`BindingVerificationResult`, from `binding-verifier-types.ts`):

```ts
{
  status: BindingStatus,          // 'verified' | 'pending' | 'failed' (derived via deriveBindingStatus)
  channel1: ChannelResult,        // { kind:'ok' } | { kind:'fail', reason } | { kind:'pending', reason }
  channel2: ChannelResult,
  checkedAt: number,              // epoch ms
  pendingUntil?: number,          // set when status === 'pending' (grace window end)
}
```

`ChannelResult = { kind:'ok' } | { kind:'fail', reason } | { kind:'pending', reason }`.
The composite verdict is `result.status`.

### What `makeAdmissionDecider({ verifyBinding })` (Stage 3) should wire

The impl plan's admission decider takes a `verifyBinding(device_pubkey, github_login)
=> Promise<boolean>`. Wire it to a thin adapter over `verifyBoth`:

```ts
const verifyBinding = async (devicePubkeyBase64: string, githubLogin: string): Promise<boolean> => {
  const r = await verifyBoth({
    channel1: { token, claimedGithubUserId },        // resolve id+token from the announce/session
    channel2: { repoOwner, repoName, githubLogin, githubUserId, devicePubkeyBase64, token },
  });
  return r.status === 'verified';   // 'pending' is NOT admitted at the substrate gate
};
```

Notes for Stage 3/4:
- The announce frame carries `github_user_id` AND `github_login`; `verifyChannel2`
  needs BOTH (id → branch ref, login → file path). The announce already has them — good.
- `verifyBoth` needs `repoOwner`/`repoName` + an OAuth `token`. These are the LOCAL
  peer's harness context (the shared repo this harness is bound to) + the local user's
  token — NOT carried in the announce. Resolve them from the harness binding /
  `gh-token` at admission time. **Flagged for Stage 3:** the admission decider needs
  the local harness's `{repoOwner, repoName, token}` injected; the announce alone is
  insufficient to run channel 2. (Channel 2 reads the *remote* peer's signed
  contributor file from the SHARED repo, so owner/name come from the local harness's
  binding, which is correct.)
- There is also `verifyAttestation(gistId, claimedPubkeyBase64, claimedGithubUserId)`
  in `attest.ts` (gist-based attestation, returns `{valid, reason, resolvedGithubUserId}`).
  That is the *attestation* path (one channel, gist self-signature); the **two-channel**
  `verifyBoth` is the stronger D-004 check and the one to use. Don't confuse the two.
- The repo-binding service (`binding-service.ts`: `resolveRepoBinding`, `claimBinding`,
  `getRepoPermission`, `CLAIM_REQUIRED_PERMISSION/SUPERSEDE_REQUIRED_PERMISSION`) is for
  repo↔harness ownership and **does** gate on collaborator permission — explicitly NOT
  the read-admission gate. Do not call it for admission.

---

## Step 5 — Swarm announce channel — **[run-verified]** (mechanism) + **[read-verified]** (corestore integration)

**Chosen mechanism: a dedicated `protomux` channel on the SAME connection corestore
replicates over.** Do NOT hand-roll length-prefixed frames on the raw encrypted socket.

### Why (read-verified from corestore 7.9.2 + hypercore 11.30.2 source)

`corestore.replicate(socket)` calls `Hypercore.createProtocolStream(socket)`, which does
`Protomux.from(noiseStream)` and stores it at `noiseStream.userData` if absent
(`hypercore/index.js` `createProtocolStream`; `corestore/index.js:436 replicate`). A
Hyperswarm `connection` socket IS a `@hyperswarm/secret-stream` (a NoiseSecretStream).
So **the same muxer** that carries Hypercore's replication channels is reachable via
`Protomux.from(socket)` — open one extra channel on it for the announce. One connection,
one muxer, two protocols (`hypercore/alpha` + `papercusp/announce`).

### Run-verified frame exchange (probe used a connected secret-stream pair)

```js
import Protomux from 'protomux';
import c from 'compact-encoding';

// `socket` is the Hyperswarm `connection` (a secret-stream). Protomux.from REUSES
// socket.userData if corestore.replicate already attached it — so order doesn't matter.
const mux = Protomux.from(socket);

const channel = mux.createChannel({ protocol: 'papercusp/announce' });
const announceMsg = channel.addMessage({
  encoding: c.json,                                   // JSON frame; compact-encoding handles it
  onmessage: (frame) => onAnnounce(frame),            // { device_pubkey, github_user_id, github_login, log_core_key, sig }
});
channel.open();

// Send our announce (build+sign per Step 3):
announceMsg.send({ device_pubkey, github_user_id, github_login, log_core_key, sig });
```

Probe result: a JSON announce sent on peer A's `papercusp/announce` channel was
received intact on peer B's same-named channel over one secret-stream connection
(run-verified). `mux.createChannel(...)` returned a channel on both ends; `.addMessage({encoding:c.json, onmessage})` + `.open()` + `msg.send(obj)` is the working surface.

### Recommended wiring for Stage 4 Step 5 (in `swarm.ts`'s `connection` handler)

1. Keep the DoS guard / ban / rate-limit checks first (unchanged).
2. `const stream = store.replicate(socket)` — **pass the connection directly** as an
   external stream (replaces today's `store.replicate(true)` + manual `local.pipe(peer); peer.pipe(local)`).
   This both starts Hypercore replication and ensures `socket.userData` holds the muxer.
3. `const mux = Protomux.from(socket)` → open the `papercusp/announce` channel; on
   `onmessage`, run the admission decision (Step 4) → if admitted, `openRemoteLog(store, announce.log_core_key)` + `mergeNow()`.
4. Send our own announce on the channel right after opening it.

Caveats (read-verified, call out in Stage 4):
- Choose a FIXED channel-open ordering or rely on protomux's pairing (`mux.pair(...)`)
  so both ends agree on the `papercusp/announce` protocol even if one opens first; the
  probe opened both ends eagerly and it worked, but in the swarm both peers must open
  the channel on connect.
- Today's `swarm.ts` uses `store.replicate(true)` + `.pipe()`. Switching to
  `store.replicate(socket)` (external stream) is the change that makes the shared-muxer
  announce possible — it's a small, correct refactor of the existing handler, not a new
  socket. The `extractRemoteIp`/`extractPublicKeyHex` helpers still work (they read
  `socket.rawStream.remoteHost` / `peerInfo.publicKey`).

---

## Reused-interface reference (corrected names, for Stages 1–6)

| Symbol | Real location | Signature / shape |
|---|---|---|
| `applyHyperbeeOpToPg` | `lib/sync/hyperbee/projection.ts:58` | `(op: OpEnvelope) => Promise<boolean>` |
| `registerProjection` / `getProjection` | `projection.ts:40 / :44` | as plan |
| **`lwwPick`** (NOT `pickLwwWinner`) | `projection.ts:91` | `(a: OpEnvelope, b: OpEnvelope) => OpEnvelope` — later `ts` wins; `del` beats `put` on tie |
| `observeMergedOp` | `lib/sync/hyperbee/clobber-events.ts:131` | `(incoming: LocalWrite) => boolean` |
| `deriveSwarmTopic` | `lib/sync/hyperbee/derive-swarm-topic.ts:46` | `(binding: SwarmBinding) => Buffer` (32-byte) |
| `getHarnessStore` | `lib/sync/hyperbee/corestore.ts:39` | `({workspaceRoot, harnessSlug}) => Promise<Corestore>` |
| `OpEnvelope` | `lib/sync/hyperbee/autobase-setup.ts:25` | `{type:'put'|'del'|'addWriter', table?, hbKey?, value?, schema_version?, ts?, writerPubkey?}` |
| `verifyBoth` (two-channel verifier) | `lib/identity/two-channel-verifier.ts:237` | `(VerifyBothOptions) => Promise<BindingVerificationResult>` |
| `loadOrGenerateDeviceKeypair` | `lib/identity/attest.ts:46` | `(keychainId) => Promise<{keychainId, pubkeyBase64}>` (pubkey = raw-32-byte base64) |

## Net effect on later stages
- Stage 1 (`peer-log.ts`): use `{name:'peer-log', valueEncoding:'json'}`; `get(i)` is a
  decoded object; `keyHex = key.toString('hex')`. Remote handle = `{key: Buffer}` +
  must `await update()` before reading length.
- Stage 2/6 (`read-merge.ts`): call **`lwwPick`** (not `pickLwwWinner`); `await
  remote.update()` each pass before reading `[0,length)`.
- Stage 3 (`announce.ts`, `read-admission.ts`): sign/verify with Node `crypto` Ed25519
  + raw-32-byte-base64 pubkey (matches `device_pubkey`); admission wires `verifyBoth`
  (NOT binding-service) and needs local `{repoOwner, repoName, token}` injected.
- Stage 4 (`swarm.ts`): switch to `store.replicate(socket)` + `Protomux.from(socket)`
  `papercusp/announce` channel with `compact-encoding` `c.json`.
