# Mobile (Android + iPhone) ↔ BYOC cloud workspace compatibility — 2026-10-06

Plan `android-public-release-2026-10-01` P-015 (D-008, D-009). Author: su-deb0a62a (android-release member 2).
Initial research was done before P-015 had a work item. Implementation and acceptance are tracked in
`WI-10006956`; native integration is `WI-10006994` under D-018, and runtime publication is `WI-10007013`.

## Current compatibility and release evidence — 2026-10-07 successor verification

This section supersedes the historical gap analysis below. Governing decisions are Android plan
D-013 and its amendments D-017 (exact URL), D-018 (native ownership), D-019 (sealed ingress), and
D-020 (bounded upload frames), plus D-021 (sealed phones on both hosting classes). P-015 is **open**:
server proofs do not establish a supported public
Android/cloud release combination.

### Release identities and support boundary

| Component / combination | Exact identity read | Verified extent | Public cloud support |
|---|---|---|---|
| Existing workspace runtime r63 | `0.0.21-p318r63`, source `9a3383955506d4f6d6e856527a041e443961236a`; bundle SHA-256 `b9ac9540801fc544a8a117e1d1c5da6813e6877ae3010071e2c504cc3cb9210b` | Local `wh-release-r63/build-result.json` records a built artifact. At that source, the host, HTTP channel and portal handler lack `device-http`, `bodyChunked` and `attachSealedDeviceSocket` respectively. This read does not prove which artifact a VM currently runs. | Not a P-015 compatible runtime. |
| Runtime cut r65 | `0.0.21-p318r65`, source `256a4151bca0d9ee0e04ffc60bf0058980cba442` | Local `release-cut.json` exists; `build-result.json` is absent. Runtime owner records failed sidecar build. This pin also precedes the sealed-error `relay.close` fix in `hosted-session-host.ts`. | No built or accepted candidate established. |
| Next runtime r66 | No local `release-cut.json` or `build-result.json` at this observation | Runtime owner must select a new committed source containing both the responder close fix and maintained builder/cache fix, then build and publish it. | Pending; a proposed version is not a release. |
| Portal / operator source candidate | D-021 working-tree source; key file fingerprints below. No matching committed pin verified. | Current source implements D-017/D-019/D-020/D-021. Exact loaded portal and VM artifacts must still be matched to the final candidate before live acceptance. | Source-level coverage only. |
| Android/native source candidate | Mobile HEAD `1930c11b6d913c12b5a7bc632a0d4ede90e2fe4e`; Cargo workspace version `0.1.0` | Android `versionName` comes from `PAPERCUP_RELEASE_VERSION` or default `0.1.0`; it does not identify the APK under test. Native owner reports Noise KAT/interop passing, but consumer integration, chunked uploads and credential-store survival remain open. | No accepted APK/cloud pair established. |
| GCP Papercusp-hosted acceptance target | Customer workspace `ws-3daf37098c8096b5d9e0ac72` → host `host-3daf37098c8096b5d9e0ac72` | Runtime owner's canonical provider-delegation read classifies it as `papercusp-hosted`, not BYOC. Evidence: `coord-send-1a18b99e1b09f709e8f8f67cd704c6fe876c59b2eeb8b966e21713bc43994744`. | Hosted acceptance pending; cannot satisfy BYOC acceptance. |
| GCP BYOC acceptance target | No active genuine BYOC target established in the supplied inventory | Previously verified BYOC customer rows are deleted. Existing project delegation is preparatory authority, not a provisioned workspace or a phone journey. | Pending maintained provisioning and acceptance. |
| AWS / Azure cloud images | No artifact + Android journey established by this P-015 evidence | Provider renderers existing in source do not prove this mobile contract on those providers. | Not covered by this acceptance record. |

Artifact source files read: `/home/marsh-office/.papercusp/wh-release-r63/{release-cut,build-result}.json`
and `/home/marsh-office/.papercusp/wh-release-r65/release-cut.json`. The absence observations for
r65/r66 are bounded to those local cut directories, not a census of remote publication.

The supported-release policy for this record is **exact candidate pairs**: record the APK version,
versionCode, source and hash; the portal loaded source; and the workspace runtime version, source and
bundle digest. Claim support only for a pair that completes the hosted and genuine BYOC no-LAN
journeys. No minimum semantic version or range such as “0.0.21 and later” is established by this
evidence. A version label, source-only test, or Papercusp-hosted VM cannot substitute for those checks.

### Current transport and authentication contract

- **Endpoint:** the opaque HTTPS base is `https://app.papercusp.com/api/workspaces/<customerWorkspaceId>`.
  The phone appends `/api/device/<route>`, producing `/api/workspaces/<id>/api/device/<route>`.
  `parseDeviceRelayPath` in `packages/operator-core/lib/workspace-host/hosted-app-relay.ts` and the
  handler route implement D-017. The shorter historical `/api/workspaces/<id>/device/*` is obsolete.
- **Pairing:** `packages/operator-core/lib/endpoint-route/routes/device/pair.ts` obtains
  `hostedDeviceRelayBaseUrl`, advertises `noiseKey`, and requires a canonical phone `noisePublicKey`
  when a machine key is advertised. The VM consumes the pair token and issues the device JWT.
- **Sealed cloud phone channel:** `apps/operator/bin/hosted-handler.ts` upgrades exactly
  `/api/workspaces/<id>/api/device/sealed` for a live BYOC or Papercusp-hosted connector (D-021).
  Both hosting classes advertise a machine key in the QR. The portal transports
  `sealed.packet` values using `papercusp-byoc-noise-xx.v1`; it refuses plaintext BYOC HTTP content.
  `byoc-sealed-channel.ts` terminates Noise on the VM. The host binds the proven phone key to the
  registered device and checks the JWT subject against that device before forwarding a request.
- **Allowlist:** `DEVICE_HTTP_ROUTE_ALLOWLIST` derives from `device-ingress-paths.ts` rather than a
  separate copy. The VM remains the JWT verification/revocation authority. A route refusal is not
  evidence of revoked pairing.
- **Large uploads:** the existing HTTP channel accepts device-only `http.request {bodyChunked:true}`,
  ordered `http.body` frames and `http.end`. Chunks are at most 48 KiB raw; total assembly is at most
  32 MiB (`64 * HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES`). Inline bodies retain the 512 KiB cap.
  BYOC seals each frame. The Rust consumer must implement this before a large native upload passes.
- **Errors:** the current Rust `into_api_error` checks relay-policy codes and `workspace_offline`
  before its 401/403 Unauthorized fallback, and preserves retry-after for offline/rate-limit errors.
  This source mapping does not prove Android credential persistence or reconnect behavior.

### Acceptance still required

The pre-D-021 checkpoint references `test_runs` 20888062 (relay integration), 20888070/72/73/74/75
(five server mutants), and 20888077 (JWT-fixture clock regression); exact bindings are 28351–55 and
28362–66. `/tmp/android-device-stable-fixture-tests.log` records 13 integration + 48 host tests and
`TEST_FILE_RESULT ... status=passed head=746af82e1d uncommittedPaths=1/2`. These are local source
proofs; the fixture test and host close fix still require the final artifact provenance.

That source cohort passed P-015 adequacy for ALLOWLIST, FRAME-CAP, OFFLINE, SEALED and AUTHZ.
D-021 changed the portal and integration-test cohort, so those bindings now need renewal before a
current adequacy claim. The four D-021 focused suites passed 24 handler, 14 assembled relay and
66 relay/broker assertions (`/tmp/android-hosted-sealed-fixed.log`, final process exit 0). The runner
observed HEAD movement `3173d0518f` → `ae714b19c6` and reported `provenance=unknown`; the result
does not establish exact artifact readiness. Before the fix, the new Papercusp-hosted cases failed
with HTTP 403 and refused channel attachment (`/tmp/android-hosted-sealed-baseline.log`, exit 1).
The detector failure was coverage of only BYOC in the real ingress and assembled transport tests;
both now run with each hosting class. Root cause and fix are tracked in `EI-25301141794178113`.

The successor's correct four-file run also passed 104 assertions, exit 0:
`/tmp/android-hosted-sealed-current2.log`. The broker test is
`packages/operator-core/lib/endpoint-route/hosted-workspace-session.test.ts`.
Integration ledger `20888338` is PASS. Final runner provenance is still **unknown** because HEAD
moved `1d5f919a1f` → `c04d8b4de6`; named tests were unchanged, but the runner did not measure
their imported source graph. An earlier attempt with an incorrect broker path refused before
executing tests; its committed snapshot also lacked the D-021 working-tree cohort.

All five fresh private-overlay probes had passing original and copy baselines, caught the mutant,
and exited 0. Logs are `/tmp/android-d021-<name>-mutation.log`:

| Clause | Probe name | Mutant ledger | Renewed mutation binding | Renewed test binding |
|---|---|---|---|---|
| RELAY-ALLOWLIST | `allowlist` | `20888359` | `28413` | `28418` |
| FRAME-CAP | `framecap` | `20888354` | `28414` | `28419` |
| OFFLINE | `offline` | `20888361` | `28415` | `28420` |
| SEALED | `sealed` | `20888360` | `28416` | `28421` |
| RELAY-AUTHZ revision 2 | `authz` | `20888355` | `28417` | `28422` |

The measured evaluator returned five passing server clauses and three failing native/live clauses
for this renewed binding cohort. This is working-tree adequacy evidence; exact committed-source
proof and release readiness remain unresolved. All test/probe processes have completed.

The following SHA-256 values matched the predecessor checkpoint when read after the new runs:

| Repository path | SHA-256 |
|---|---|
| `apps/operator/bin/hosted-handler.ts` | `c47463fd5d340df51d98d83b3293bc3729379acb427cc642ea288a483eeef751` |
| `apps/operator/bin/hosted-handler.test.ts` | `a6a3b4f5546053bb1772ec6ad192126b13c53295a63b2b5ff86f02c9599309e7` |
| `packages/operator-core/lib/workspace-host/hosted-app-relay.ts` | `e2fa9117fbd4ddb2bb163ef623383e006703d1f9c8e685a1e6caec9a8c50a4ed` |
| `packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts` | `938631ed23a826e7fcf0a074205b9a3da53380392d13bf5cf176956dd68d0477` |
| `packages/operator-core/lib/workspace-host/hosted-device-relay.integration.test.ts` | `7f029bd2716cafa6b362dfbf1deaaf86ecf95d0035f47659c8a76169f2985ec4` |

A source-file fingerprint comparison does not resolve the runner's imported-source uncertainty.
Automatic sync is advancing other files while these D-021 paths remain dirty. A sanctioned
background-host sync attempt returned `held_exclusive`; no lease was acquired or bypassed.
The focused file-lock read found no active locks on these four dirty paths, and the routine's
content-error list was empty. The routine reports an active local-sync fire with recent progress;
there is no evidence here that a restart or lock override would be safe or useful.

P-015 also remains open for
REFUSAL-KEEPS-PAIRING (real native credential store), OPERATE and OUTCOME (real no-LAN journeys).
The live matrix must exercise QR and manual pairing; token storage, rotation and revocation;
endpoint discovery and reconnect; workspace/harness scope; sync; streaming chat; approvals;
monitoring; voice including large upload; and push. Repeat the relevant native/security tests when
their source cohort changes, then bind the exact final APK and runtime evidence. No shipment is
claimed here.

## Historical discovery — 2026-10-06

The following sections preserve the initial analysis and agreement context. Their gap states,
route spellings, image/bootstrap description, and client error mappings are historical; use the
current source and dated section above for implementation or support decisions. The current bootc
image carries an immutable versioned runtime (see `workspace-host.Containerfile` release target),
so the initial first-boot shallow-clone description below is also superseded.

Every claim is tagged **[code]** (read in source at the path given) or **[inferred]** (reasoned, not yet probed).

## 1. What a BYOC cloud workspace runs, and how anything reaches it

- **Machine image.** A CentOS Stream 10 bootc image, `infra/images/bootc/workspace-host.Containerfile`,
  rendered per provider: GCE image family, AWS AMI, Azure Compute Gallery
  (`packages/operator-core/lib/workspace-host/gcp-image-family.ts`, `aws-ami-release.ts`,
  `azure-compute-gallery-release.ts`). The operator comes from the first-party release bundle that the
  content bootstrap shallow-clones at first boot. So a cloud workspace runs the **same operator code
  as the desktop**, pinned to a release sha. **[code]** It does not run a separate cloud fork. **[inferred]**
- **No inbound ingress.** The VM has an nftables firewall (`papercusp-firewall.nft`) and reaches the cloud
  only through an **outbound workspace connector** to the hosted control plane. The portal "never dials a
  machine address" (`hosted-app-relay.ts` header). **[code]**
- **Public origin.** `app.papercusp.com` is served through a Cloudflare tunnel whose ingress lives outside
  the repo (`~/.cloudflared/papercup-demos.yml`). Route families are classified in
  `endpoint-route/hosted-public-ingress.ts`. TLS ends at Cloudflare. **[code]**
- **Relay planes the connector carries.** Channel kinds are `pty | psu | desktop | operator-http | app-http |
  app-key-mint` (`hosted-session-host.ts:107-116`). **[code]**
  - `operator-http` (`hosted-operator-http.ts`): carries the **portal web UI's** traffic. The principal is bound
    from a single-use workspace-operator ticket tied to a **portal browser session**. The relay drops
    `Authorization` and cookies and forwards to the VM's loopback operator under a default-deny allowlist.
    That allowlist has **no `/api/device/*` route** except `mint-pair-token` and `qr.svg`, which are listed as
    "remote access device pairing". **[code]**
  - `app-http` (`hosted-app-relay.ts`): `POST /api/workspaces/<id>/agent-tools/...` and `/api/workspaces/<id>/mcp`.
    It accepts **only `Bearer pcapp_…` app keys**, with no queueing: an offline connector gives `workspace_offline`.
    Its allowlist covers only `/api/agent-tools/*`, `/api/mcp` and `/api/hooks/*`. **[code]**
- **Own tunnel (local installs only).** `own-tunnel/*` provisions cloudflared in the **user's** Cloudflare
  account for a desktop install. Its external-ingress listener **does** serve the phone's device routes
  (`apps/operator/bin/external-ingress-paths.ts`: `/api/device/pair` plus the routes that need a device JWT).
  No hosted-bring-up or workspace-host file configures cloudflared or own-tunnel on a cloud VM. **[code: grep of
  workspace-host/*.ts]** So a BYOC VM has no own tunnel. **[inferred]**

## 2. What the mobile client needs

The shared Rust client (`papercup-rust-mobile/crates/papercup-core`) talks only to `<serverUrl>/api/device/*`.
It needs: pair, heartbeat, rest-query, the operator converse/conversation stream, voice, voice-lease, plans,
attention, monitoring, running, harnesses, workspaces/switch, push/register and notifications. Auth is a
device JWT minted by `/api/device/pair` from a one-use pair token. **[code]**

Pairing (`endpoint-route/routes/device/pair.ts:55-79`). `mint-pair-token` is loopback-only. The QR's
`serverUrl` is taken from the first of these that is set:
1. `MOBILE_DESKTOP_PUBLIC_URL`
2. `MOBILE_DESKTOP_HOST`
3. the detected LAN IP plus the request port
4. the request Host

**[code]** On a cloud VM, (3) gives the VM's **private VPC address**, which a phone cannot reach. **[inferred
from the code path; not probed on a live VM]**

## 3. Compatibility matrix

| Cloud release | Mobile client | Supported | Why |
|---|---|---|---|
| byoc-cloud-workspaces (shipped 2026-10-02; GCP + AWS + Azure images), reached via app.papercusp.com | Android `papercup-rust-mobile` master (current candidate) and iPhone (shared crates) | **NO** | The phone has no path to `/api/device/*` on the VM, and pairing advertises an unreachable private URL. |
| Desktop/local install with own tunnel (external-ingress) | same | yes (route-level) | `external-ingress-paths.ts` allowlists every device route. This is the current non-LAN path. |
| Desktop/local install, same LAN | same | yes | The current verified path (WI-10004697 / WI-10004773 evidence). |

## 4. Gap list (byoc cloud)

| # | Area | Gap | Where the fix lives |
|---|---|---|---|
| G1 | No-LAN reachability | No relay plane carries `/api/device/*` to the VM. `operator-http` requires a portal browser session and strips `Authorization`. `app-http` accepts only `pcapp_` keys. **[code]** | Portal/control plane plus workspace-host: a new `device-http` relay plane (proposal in §5). |
| G2 | Pairing from a cloud workspace | The portal UI can reach `mint-pair-token` and `qr.svg` through operator-http, but the QR `serverUrl` is the VM's private address, and `/api/device/pair` is not relayed. **[code + inferred]** | VM operator: on a hosted VM, the advertised base URL must be the portal relay URL `https://app.papercusp.com/api/workspaces/<id>`. Portal: route `/api/workspaces/<id>/device/pair` as public own-auth (the one-use token is the credential). |
| G3 | Auth/token lifecycle | Device JWT is minted and verified on the VM, so the portal cannot verify it (same split as app keys). The JWT's audience is the VM's own origin; relay origin and JWT issuer must agree. **[inferred]** | Portal forwards only device-JWT-shaped bearers and stamps the deny-only ingress marker. The VM bearer chain stays authoritative. Rust client: refresh and re-pair unchanged. |
| G4 | Scope | A device is paired to one workspace on a desktop. On cloud, the relay path pins the customer workspace id, and `workspace/switch` across cloud workspaces cannot cross VMs. **[inferred]** | Rust client: one pairing per cloud workspace. `workspace/switch` is limited to the operator's own workspaces. |
| G5 | Sync / SSE | `rest-query` is fine over a request/response relay. A long-lived stream needs the relay to pass a chunked response without the 30 s header cap, which operator-http already handles. **[code: operator-http wire streams `http.body`]** Confirm the device relay inherits this. | workspace-host channel. |
| G6 | Chat streaming (`operator/converse`) | Long turns need a response-header budget like app-http's 120 s and no body cut. Reconnect on `workspace_offline` instead of hanging. **[inferred]** | Relay timeout config, plus a Rust client mapping for the `workspace_offline` error. |
| G7 | Approvals / attention / standing-candidates decide | Plain request/response once G1 lands. No extra gap is known. | — |
| G8 | Monitoring / running / harnesses | Same as G7. | — |
| G9 | Voice | `voice-session-init` and `voice/turn` may return provider URLs (LiveKit/ElevenLabs) that the phone dials directly. Those must be public, not VM-local. Request bodies are capped at 512 KiB per relay frame, so audio upload over `voice/turn` may exceed it. **[inferred; check payload sizes]** | VM voice routes plus relay body cap. Possibly a chunked upload. |
| G10 | Push | `push/register` stores the token on the VM, and the VM sends FCM/APNs directly over outbound HTTPS, which the firewall must allow. **[inferred]** | Image firewall egress check. Push delivery is otherwise unaffected by the relay. |
| G11 | Offline semantics | The relay refuses at once when the connector heartbeat is stale (D-008 of the EAA plan). The client must show "workspace offline" and not report an auth failure. **[code for portal behaviour]** | Rust client error mapping. |
| G12 | Billing / rate limits | The app relay applies per-workspace request-rate and monthly-bandwidth limits (D-006). Phone traffic, especially polling and SSE, would count against them. **[code for app relay]** | Decide whether device traffic shares the app-relay budget. |

## 5. Proposed endpoint/auth/pairing model (for agreement with member 1 and su-b9f6deac)

1. **Base URL is opaque to the client.** The Rust client keeps calling `<serverUrl>/api/device/<route>`.
   - Desktop: `serverUrl = http://<lan>:<port>` or the own-tunnel URL.
   - Cloud: `serverUrl = https://app.papercusp.com/api/workspaces/<workspaceId>`.

   The client has no cloud branch. Base-URL handling must allow a path prefix, which is a contract test
   for the shared crate. A wss/https-only rule applies when the host is not on the LAN.
2. **Portal `device-http` relay plane.** It is a sibling of `app-http` in `hosted-app-relay.ts`:
   - Route: `/api/workspaces/<id>/device/*` → connector → VM `/api/device/*`.
   - Default-deny allowlist: reuse the `external-ingress-paths.ts` device list as the single source (derive it, do not copy it).
   - `Authorization` is forwarded only when it is device-JWT shaped. `/device/pair` needs no bearer, because the one-use token is the credential.
   - The deny-only ingress marker is stamped on every forward.
   - Streaming and timeouts follow app-http.
3. **Pairing on cloud.** The user opens Remote access → Pair phone in the portal UI. That call goes over operator-http to the VM's `mint-pair-token`. On a hosted VM, the advertised `serverUrl` is the portal relay URL (G2). The VM knows its customer workspace id and the public origin from its connector binding.
4. **Auth stays on the VM.** The device JWT is issued and verified only by the VM, and the portal does shape checks only. This is the same split the shipped app-key relay uses.

### Agreement status (19:20Z)

**Member 1 (su-a64f40ce, P-002/P-004) agreed** and added four constraints:

- (a) Normalise a trailing slash in the shared crate's `base_url()`. Android `EndpointSecurity.kt` must accept an https URL that has a path. Member 1 adds that Android test in P-004.
- (b) `workspace_offline` gets its own error, not `Unauthorized`. On Android, `Unauthorized` forces a re-pair, which would wipe valid credentials.
- (c) `/api/device/voice` is a WebSocket (`device-voice-ws.ts`), so the device relay must carry the Upgrade, not only HTTP. This adds to G9.
- (d) Revocation and rotation stay on the VM, so the relay must pass a 401 through unchanged.

Member 1 also asked to keep the QR payload shape unchanged apart from the URL value.

**su-b9f6deac (iPhone) agreed** to points (1)–(4), which match `iphone-public-release-2026-08-11#D-014`. They added one **required amendment**:

- **End-to-end sealing.** On a `byoc` workspace, every device-http content frame is sealed end-to-end with the existing Noise XX channel (`BYOC_SEALED_PROTOCOL 'papercusp-byoc-noise-xx.v1'`, `byoc-sealed-channel.ts`). The phone is the initiator.
- **Machine key in the QR.** The machine's static Noise public key travels inside the pair QR, so trust never routes through the vendor. The phone's static key is registered when the pair is redeemed.
- **The relay refuses plaintext** byoc device content (hosted-byoc-confidentiality-correction D-003). Classify the plane in `HOSTED_RELAY_FRAME_REGISTRY`.
- **No cloud branch.** The client seals whenever the pair payload carries a machine Noise key.
- **Implementation.** Use a maintained Noise library in the shared Rust core, with cross-implementation test vectors against `byoc-sealed-channel.ts`.

Under D-015 the shared BYOC Rust layer is **this lane** (P-015): URL-prefix handling, `workspace_offline` mapping and the sealed-channel initiator. The client must also accept the pair baseUrls kind `relay`. The Swift side (DesktopVoiceSession) is su-d34a76e0's, the iOS half of WI-10006857.

The 512 KiB frame cap (G9) must be an **acceptance check** on the relay item: voice/turn bodies either fit under the cap or are chunked.

### Status-code mapping the shared client must get right (read in code, 19:25Z)

The relay's refusal codes (`packages/operator-core/lib/workspace-host/hosted-app-relay.ts`, `refuse(...)` and `RELAY_ERROR_STATUS`) do not line up with the Rust client's mapping. In `papercup-rust-mobile/crates/papercup-core/src/client.rs`, `into_api_error` turns **every** 401 and 403 into `ApiError::Unauthorized`, and everything else into `Server{status}`. **[code]**

| Relay response | Today's client result | Required result |
|---|---|---|
| `503 workspace_offline` (+ `retry-after: 30`) | `Server{503}` | A distinct `WorkspaceOffline { retry_after }`. Retryable, never re-pair. |
| `403 byoc_plaintext_relay_refused` | **`Unauthorized` → re-pair, wiping valid credentials** | A distinct relay-policy error. A sealing bug must never wipe the pairing. |
| `403 route_not_relayed` | **`Unauthorized` → re-pair** | Same relay-policy error: the client called an off-allowlist path. |
| `401` from the VM (device JWT revoked or rotated) | `Unauthorized` | Unchanged. This is the only true re-pair signal (constraint d). |
| `413 request_body_too_large` (cap `HOSTED_OPERATOR_HTTP_MAX_REQUEST_BODY_BYTES` = 512 KiB) | `Server{413}` | A distinct too-large error, so voice/turn can chunk. G9 acceptance. |
| `429 rate_limited` (+ `retry-after`) | `Server{429}` | A distinct rate-limited error that honours `retry-after`. |

So the device-http plane must tell its own refusals apart from the VM's. Either the relay never answers 403 for the device plane, or the client branches on the `error` code in the body before it falls back to "403 means Unauthorized". Branching on the body code is the safer contract, because it does not depend on the relay's choice of status code. These are the first contract tests to write once the work item is held (wiremock, in `crates/papercup-core`).

Base-URL joining is already safe for a relay path prefix: `new`/`set_base_url` trim trailing slashes, and requests are built as `format!("{base}{path}")`. Constraint (a) only needs a test that pins this, plus the Android `EndpointSecurity.kt` change (member 1, P-004). **[code]**

No code changes before P-015's work item is held.
