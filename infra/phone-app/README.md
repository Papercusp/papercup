# Phone app — self-hosted media plane

Plan: `phone-app-2026-08-30` · items **P-002** (this directory) and **P-003** (trunk).
Decision **D-002**: we self-host the media plane from day one — no LiveKit Cloud phase.

This is the call-carrying infrastructure for the Phone app: a LiveKit server plus a
LiveKit SIP gateway, both running on this host as `systemd --user` units, entirely
under our control.

## What runs

| Unit | What | Listens |
|---|---|---|
| `papercusp-phone-livekit.service` | LiveKit server (WebRTC SFU + embedded TURN) | `7890` http/ws · `7891` rtc-tcp · `7892/udp` rtc-mux · `7893/udp` turn · hosted `7894` TURN/TLS backend |
| `papercusp-phone-sip.service` | LiveKit SIP gateway (PSTN ⇄ room bridge) | `5070` sip (udp+tcp) · `40000-40200/udp` rtp |

Redis `127.0.0.1:6379` **db 3** is the coordination bus between the two.

## ⚠ This host already runs a DIFFERENT project's LiveKit

`livekit-server.service` and the `restart-livekit-sip-1` container belong to the
`~/Restart` project and own ports **7880/7881/5060**. They are **not ours** — do not
reconfigure, restart, or borrow their API keys. Every port above was chosen to sit
clear of them, and we run our own instances of the same binaries. If you are
debugging and see LiveKit logs you do not recognise, check the pid before assuming
it is this deployment.

## Layout — and why the configs are not in this directory

The `.tmpl` files here are the **committed** source of truth for configuration.
`deploy.sh` renders them into `~/.config/papercusp-phone/` (mode 0600, outside the
repo) after substituting the API secret, which it mints itself on first run and
never prints. That split is deliberate: the shape of the config is reviewable in
git; the secret never enters the tree, the transcript, or a log.

```
infra/phone-app/
  livekit-server.yaml.tmpl     server config, ${...} placeholders
  livekit-sip.yaml.tmpl        sip gateway config
  systemd/*.service            unit files (installed to ~/.config/systemd/user/)
  deploy.sh                    idempotent: mint → render → install → start → health
  verify-media-plane.sh        P-002 acceptance: real media through our own server
```

## Host prerequisites

`livekit-server` and `lk` are installed at `~/.local/bin`. `livekit-sip` is published
only as a container image, so the binary is extracted to the host once — that way the
unit runs natively and does not depend on Docker at call time:

```bash
cid=$(docker create livekit/sip:latest)
docker cp "$cid":/usr/bin/livekit-sip ~/.local/bin/livekit-sip
docker rm "$cid" && chmod +x ~/.local/bin/livekit-sip
sudo apt-get install -y libopusfile0   # it is dynamically linked; this is the one that is missing
```

`deploy.sh` checks both and prints these instructions rather than failing obscurely.

## Use

```bash
infra/phone-app/deploy.sh            # idempotent — safe to re-run
infra/phone-app/verify-media-plane.sh # local one-direction audio smoke test
systemctl --user status papercusp-phone-livekit papercusp-phone-sip
journalctl --user -u papercusp-phone-livekit -f
```

`deploy.sh --rotate-secret` mints a fresh API secret (restarts both units).

For a **local-only** process and HTTP readiness verdict, run
`PHONE_LIVEKIT_URL=ws://127.0.0.1:7890 PHONE_SIDECAR_URL=ws://127.0.0.1:8793 node infra/phone-app/media-config.mjs local-readiness`.
It fails closed if a Phone media, SIP, worker or sidecar unit is inactive, or
either loopback HTTP probe fails. It does **not** prove public PSTN calling,
media in either direction, cost-policy enforcement, backup/recovery, or
certificate renewal; those remain separate operational acceptance checks.
`infra/phone-app/deploy.sh --status` reads the existing external configuration
and returns that same JSON verdict with a nonzero exit status when not ready;
it installs nothing, restarts nothing, and never prints credential values.
When hosted coordinates are present, the same status also fails closed on
missing, mismatched or less-than-seven-days-remaining TURN certificate/key
material, returning a `turn-certificate` check without exposing file paths or
secrets. Run this read-only status on a recurring operator check and alert its
owner on a nonzero exit before the certificate expires. A LAN-only status does
not imply any hosted certificate was checked (`turnCertificateVerified: false`);
frontend WSS renewal still requires its own public preflight and deployment
proof. This check does not renew certificates or prove public media.
The sidecar unit supervises the HTTP process directly and restarts it on failure.
After changing the out-of-repo sidecar source, converge through `deploy.sh`;
the unit does not use Node's watcher, which can stay active after its child dies.

Before a live converge or secret rotation, run `deploy.sh --pin-artifacts` from
a reviewed, clean Phone source revision. This writes `artifacts.sha256` outside
the repository in `PHONE_CONFIG_DIR` (mode 0600). It binds the Phone source
commit and hashes the media binaries, Node executable, deployment script,
config templates and unit files. `deploy.sh --verify-artifacts` checks the pin
without changing services; normal deploys require the same check before any
credential or unit write. A changed binary or Phone source requires a new pin.
`PHONE_LIVEKIT_BIN` and `PHONE_SIP_BIN` select isolated candidate binaries;
the default remains `~/.local/bin`. The pin excludes secret values and does not
itself prove a recovery drill or public calling.

For the app-owned Phone Postgres database, create a logical backup outside the
source tree and then restore it into a disposable embedded Postgres instance:

```bash
node infra/phone-app/phone-db-backup.mjs backup --out /absolute/private/phone.dump
node infra/phone-app/phone-db-backup.mjs restore-drill --archive /absolute/private/phone.dump
```

The backup command reads `PHONE_APP_DATABASE_URL`, `PHONE_DATABASE_URL`, or
`DATABASE_URL`, then falls back to `PHONE_HOME/postgres.json`. It writes a
0600 custom-format archive and SHA-256 receipt, refuses to replace an existing
archive, and never prints the database password. The drill verifies the digest,
restores into a fresh temporary database, and reads every restored public table.
It never writes to the running Phone database. Keep archives in a protected,
backed-up destination; a local archive alone does not cover host loss.

The smoke test requires a positive received-audio packet row and a complete,
error-free subscriber summary from `lk` 2.16. It refuses unknown output formats,
missing tracks and zero traffic even when `lk` exits zero. It does not prove public,
bidirectional or PSTN audio. `PHONE_CONFIG_DIR`, `PHONE_LK_BIN` and `PHONE_NODE_BIN`
allow an isolated local candidate. The recurring `npm --workspace @papercusp/web
run test:phone-media` suite includes an actual private LiveKit process and CLI;
install `livekit-server` and `lk` under `~/.local/bin` before running it, or set
`PHONE_TEST_LIVEKIT_BIN` and `PHONE_TEST_LK_BIN` to maintained local binaries.

For a hosted browser, keep server-to-server control on the internal URL and
provide a separately reachable WSS origin for the browser:

```bash
PHONE_LIVEKIT_PUBLIC_URL=wss://voice.example.com infra/phone-app/deploy.sh --hosted
```

`--hosted` requires a public WSS origin on TCP/443, separate TURN DNS hostname,
and a matching certificate/key with at least seven days of validity. Configuration
uses absolute paths to external injected certificates. It keeps
`PHONE_LIVEKIT_URL` internal and persists separate public coordinates without
rewriting the API credentials. The four additional `PHONE_TURN_*` fields extend
this existing deployer; they do not create another deployment service.

Prepare from the existing credential file without minting keys, installing units,
restarting services, resolving DNS, or claiming public acceptance:

```bash
PHONE_LIVEKIT_PUBLIC_URL=wss://voice.example.com \
PHONE_TURN_DOMAIN=turn.example.com \
PHONE_TURN_CERT_FILE=/external/certificates/turn/fullchain.pem \
PHONE_TURN_KEY_FILE=/external/certificates/turn/privkey.pem \
  infra/phone-app/deploy.sh --hosted --render-only
```

The TURN TLS backend defaults to `7894`; `PHONE_TURN_TLS_PORT` can choose a
different unprivileged non-conflicting backend port. LiveKit advertises TURN/TLS
on **public TCP/443** regardless of this backend port. The approved frontend must
route TURN TCP/443 to that backend and terminate WSS on TCP/443 to `7890`.
Merely opening public `7894` does not satisfy the contract. Do not expose `7890`
directly to browsers. Public DNS, frontend ownership, certificate renewal, ICE
UDP `7892`, optional RTC TCP `7891`, SIP `5070` and RTP `40000–40200/udp`
firewall/NAT rules still require explicit deployment and measurement.

`PHONE_CONFIG_DIR` selects an external config directory for isolated preparation;
the default remains `~/.config/papercusp-phone`. Preparation writes mode-0600
config there, so use a separate directory when reviewing a candidate against a
running deployment. No private key contents are copied into a config or logged.

The public preflight can run on a remote machine with only non-secret coordinates:

```bash
PHONE_LIVEKIT_PUBLIC_URL=wss://voice.example.com \
PHONE_TURN_DOMAIN=turn.example.com \
  node infra/phone-app/media-config.mjs preflight
```

Alternatively `deploy.sh --preflight` reads those coordinates from the external
env file if present. It changes no files or services. Both hosts must resolve
exclusively to global IP addresses, and each measured address must present a
trusted, hostname-matching certificate with at least seven days remaining on
TCP/443. A failed trust, DNS, timeout or renewal check fails closed. This checks
prerequisites only: its report explicitly has `audioVerified: false`.

Before P-002 acceptance, deploy and exercise the maintained certificate renewal
mechanism for the chosen frontend and TURN termination, then prove authenticated
**bidirectional audio** from both an external network and a UDP-blocked network.
The repository's isolated TLS and config tests provide software regression
evidence; they do not discharge those public network or renewal requirements.

## Credentials

The API key/secret pair lives in `~/.config/papercusp-phone/livekit.env` (0600) and
is mirrored into the encrypted operator store as `PHONE_LIVEKIT_API_KEY` /
`PHONE_LIVEKIT_API_SECRET` so the agent worker (P-004) can bind them without reading
a file. Nothing here is committed.

## Not yet wired

- **Trunk (P-003)** — `livekit-sip` is running and accepts SIP, but no carrier trunk
  is configured, so it cannot reach the PSTN yet. That needs a Telnyx account, which
  is an owner-gated wall (see the plan's `## Now`).
- **Public media deployment** — hosted TURN/TLS configuration and remote preflight
  are prepared here. Approved DNS/frontend routing, renewal and both real remote
  audio cases remain unverified. LAN mode keeps UDP TURN and disables TLS.

Upstream contracts: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/),
[configuration](https://github.com/livekit/livekit/blob/master/config-sample.yaml),
and [TURN/TLS advertisement](https://github.com/livekit/livekit/blob/master/pkg/service/roommanager.go).
