# Defguard mesh integration — remaining work

## Phase A — DONE (2026-05-08, commit `bce5d2e`)

- ✅ Server: `lib/defguard-client.ts` calls correct Defguard endpoints
  (`POST /api/v1/user` + `POST /api/v1/user/{u}/start_enrollment`)
- ✅ Server: `/api/mobile/pair` returns `{defguardControlUrl,
  defguardEnrollmentUrl, defguardEnrollmentToken, defguardUsername}`
- ✅ Defguard server `mesh.papercuspai.com` is reachable, has the
  `papercusp-mesh` location at `10.10.0.0/24`, gateway connected
- ✅ `DEFGUARD_API_TOKEN` in operator's `.env.local`

## Phase B — Desktop self-enrollment (~1–2 days)

The desktop needs to be a peer in the same `papercusp-mesh` for the
phone to route to it. Today the desktop has no WG interface.

Tasks:
- [ ] Generate desktop's WG keypair (one-time, persistent in
      `~/.papercusp/mesh-key.priv`)
- [ ] Auto-create a "papercusp-desktop" user in Defguard (one-time)
- [ ] Programmatically register the desktop as a Defguard device
      (POST /api/v1/device/network with the public key) and reserve a
      stable mesh IP (e.g. `10.10.0.10`)
- [ ] Generate `wg-quick` config (`/etc/wireguard/papercusp.conf`)
- [ ] systemd service: `wg-quick@papercusp` enabled, brought up before
      the operator binds. Needs root.
- [ ] Operator startup probe: confirm `papercusp` interface is up and
      can ping the gateway; warn if not.
- [ ] Mint endpoint: when desktop is mesh-enrolled, encode the desktop's
      MESH IP (e.g. `10.10.0.10:3070`) into `qrPayload.server` instead of
      LAN IP. Fall back to LAN IP if mesh is down.

## Phase C — Phone WireGuard Tauri integration (~2–3 days)

The phone needs to actually join the mesh so it can route to the desktop's
mesh IP. The Rust `mesh_enroll` / `mesh_join` Tauri commands are stubs.

Tasks:
- [ ] Rust: pull in `wireguard-android` Go runtime via `boringtun`/
      `wireguard-go` jar (already partially scaffolded in APK — see
      `libwg-go.so` etc.)
- [ ] Rust: implement `mesh_enroll(controlUrl, token)` Tauri command:
        - Generate keypair locally
        - POST `/api/enrollment/start` (Defguard's enrollment endpoint)
          with the token + pubkey
        - Receive WG config: peer pubkey, allowed IPs, endpoint,
          assigned address
        - Persist config in app data dir
- [ ] Rust: implement `mesh_join()` and `mesh_leave()` — bind to
      `BIND_VPN_SERVICE`, prompt user for VPN permission once, start
      WireGuard tunnel
- [ ] Android: foreground notification while mesh is up (system
      requirement for VpnService)
- [ ] React: on pair response, auto-call `mesh_enroll` if
      `defguardEnrollmentToken` is present, then `mesh_join`
- [ ] React: pairing UX shows "joining mesh…" state, surfaces failure
- [ ] React: `apiBase()` uses mesh address (`10.10.0.10:3070` or DNS)
      after successful enrollment; falls back to stored LAN IP if mesh
      is down

## Phase D — Operations & polish (~1 day)

- [ ] Phone Diagnostics screen: surface mesh status (interface up/down,
      latency to desktop, last handshake)
- [ ] Phone Settings: button to leave/rejoin mesh
- [ ] On device revoke (desktop UI), call `revokeDefguardUser(deviceId)`
      to clean up the per-device Defguard user
- [ ] Health monitor: alert if mesh disconnects mid-session (currently
      silent — voice WS would just hang)

## Open architecture questions

- **Mesh-only or LAN-fallback?** Phase B's mint flips QR to mesh IP. Do
  we keep LAN IP as a parallel record for when phone is on the SAME
  WiFi as desktop (much lower latency)? My recommendation: prefer mesh,
  fall back to LAN if mesh handshake stale.
- **Per-device users vs. shared user?** Phase A creates a Defguard user
  per pair. After a few hundred pairs the user list bloats. Consider:
  one shared "papercusp-mobile" user, multiple devices under it
  (Defguard supports this via `/api/v1/user/{u}/device`).
- **DNS or raw IP?** `10.10.0.10` is fine for v1 but a CNAME like
  `desktop-{workspaceId}.mesh.papercuspai.com` is friendlier in logs +
  TLS-future-friendly.

## Testing matrix (when Phase C lands)

- Phone on **same WiFi** as desktop → mesh route, latency ~5ms
- Phone on **different WiFi** → mesh route via Defguard relay
- Phone on **cellular** → mesh route via Defguard relay
- Desktop offline → phone shows "desktop unreachable", manual recovery
- Defguard server offline → phone uses cached WG config until it falls
  out of sync; surface error
