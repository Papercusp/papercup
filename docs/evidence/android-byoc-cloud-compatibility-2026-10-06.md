# Mobile (Android + iPhone) ↔ BYOC cloud workspace compatibility — 2026-10-06

Plan `android-public-release-2026-10-01` P-015 (D-008, D-009). Author: su-deb0a62a (android-release member 2).
Read-only research, done before P-015 had a work item. Cloud release = plan
`byoc-cloud-workspaces-gcp-aws-azure-2026-08-22` (shipped 2026-10-02).

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
