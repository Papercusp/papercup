# Phone app — self-hosted media plane

Plan: `phone-app-2026-08-30` · items **P-002** (this directory) and **P-003** (trunk).
Decision **D-002**: we self-host the media plane from day one — no LiveKit Cloud phase.

This is the call-carrying infrastructure for the Phone app: a LiveKit server plus a
LiveKit SIP gateway, both running on this host as `systemd --user` units, entirely
under our control.

## What runs

| Unit | What | Listens |
|---|---|---|
| `papercusp-phone-livekit.service` | LiveKit server (WebRTC SFU + embedded TURN) | `7890` http/ws · `7891` rtc-tcp · `7892/udp` rtc-mux · `7893/udp` turn |
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
infra/phone-app/verify-media-plane.sh # acceptance test, exits non-zero on failure
systemctl --user status papercusp-phone-livekit papercusp-phone-sip
journalctl --user -u papercusp-phone-livekit -f
```

`deploy.sh --rotate-secret` mints a fresh API secret (restarts both units).

For a hosted browser, keep server-to-server control on the internal URL and
provide a separately reachable WSS origin for the browser:

```bash
PHONE_LIVEKIT_PUBLIC_URL=wss://voice.example.com infra/phone-app/deploy.sh --hosted
```

`--hosted` fails closed unless the public URL is `wss://`; it persists that URL
beside the internal `PHONE_LIVEKIT_URL` without rewriting the API credentials.
It does not provision DNS, a TLS reverse proxy, firewall/NAT, or TURN/TLS: those
remain deployment prerequisites and must pass the real remote-browser check.

## Credentials

The API key/secret pair lives in `~/.config/papercusp-phone/livekit.env` (0600) and
is mirrored into the encrypted operator store as `PHONE_LIVEKIT_API_KEY` /
`PHONE_LIVEKIT_API_SECRET` so the agent worker (P-004) can bind them without reading
a file. Nothing here is committed.

## Not yet wired

- **Trunk (P-003)** — `livekit-sip` is running and accepts SIP, but no carrier trunk
  is configured, so it cannot reach the PSTN yet. That needs a Telnyx account, which
  is an owner-gated wall (see the plan's `## Now`).
- **TURN/TLS** — embedded TURN runs UDP-only; TLS needs a cert for a real hostname.
  Fine for LAN and for a server with a public IP; revisit before shipping clients on
  restrictive networks.
