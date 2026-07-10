# Defguard control plane (Papercusp mesh)

Self-hosted WireGuard mesh control plane. Phones and desktops join this mesh; data flows direct P2P between them, falling through the gateway when NAT prevents direct.

## Hetzner setup

1. Create a CX22 (€4.51/mo) in a region near you. Image: Ubuntu 24.04.
2. Add SSH key, set up firewall rules:
   - 22/TCP (SSH, your IP only)
   - 80/TCP, 443/TCP (Caddy)
   - 50066/TCP (Gateway setup/adoption gRPC — Core dials the *gateway* on this
     port. v1 used 50051 on core; v2 reversed the direction. Only needs to be
     reachable from Core, so keep it off the public internet when Core and
     Gateway share a host.)
   - 51820/UDP (WireGuard)
3. Note the public IPv4.
4. In Cloudflare DNS for `papercuspai.com`:
   - `mesh` → `<vps-ip>`, **proxy OFF (DNS only)**. Caddy needs port 443 for Let's Encrypt.
   - `relay` → `<vps-ip>`, **proxy OFF**.

## Deploy

```bash
ssh root@<vps-ip>
apt update && apt install -y docker.io docker-compose-v2
git clone <this-repo>
cd <repo>/infra/defguard
cp .env.example .env
# generate secrets:
for k in DB_PASSWORD DEFGUARD_SECRET_KEY DEFGUARD_AUTH_SECRET DEFGUARD_GATEWAY_SECRET DEFGUARD_YUBIBRIDGE_SECRET ADMIN_PASSWORD; do
  sed -i "s/^$k=$/$k=$(openssl rand -hex 32)/" .env
done
docker compose pull
docker compose up -d
```

Watch logs until Caddy provisions the cert:
```bash
docker compose logs -f caddy
```

Open `https://mesh.papercuspai.com` — Defguard admin UI. Log in with `admin` / `${ADMIN_PASSWORD}` from your `.env`.

## First-time configuration

> **Defguard v2 removed gateway tokens entirely.** There is no `GATEWAY_TOKEN`,
> no `DEFGUARD_TOKEN`, and no "copy the token" step — `/api/v1/network/{id}/token`
> is gone (the SPA serves its fallback page there, which is why probing it looks
> like a routing bug rather than a removed endpoint). A gateway is now **adopted**:
> Core dials the gateway's setup server and they exchange a CSR/signed cert.
> Anything below that mentions a token is v1 and does not apply.

1. **Run the setup wizard.** First visit to `https://mesh.papercuspai.com` walks
   a 12-step wizard (admin account, CA, Edge component). The Edge component
   (`ghcr.io/defguard/defguard-proxy`) is a separate service from the gateway.
2. **Create a Location:** VPN → Locations → "Add Location" — name it
   `papercusp-mesh`, VPN network `10.10.0.1/24`, allowed IPs `10.10.0.0/24`,
   endpoint `relay.papercuspai.com`. **Set the WireGuard port to `51820`** — the
   wizard pre-fills `50051` (a v1 leftover), which is wrong.
3. **Adopt the gateway:** Locations → the location's row **kebab menu → "Gateway
   setup"** → *Configure gateway*. This is the only path to it; the Gateways tab
   shows "No gateways found" with no add button until one is adopted.
   - Deploy the gateway first (`docker compose up -d gateway`). It needs
     `network_mode: host`, `cap_add: [NET_ADMIN]`, and a certs volume — and
     **no token env**.
   - The gateway opens a **10-minute adoption window** on boot, then blocks
     with `Gateway adoption expired`. If you miss it, `docker compose restart
     gateway` to reopen. (`docker compose restart` does **not** apply compose
     file edits — use `up -d --force-recreate` for that.)
   - In the wizard: name the gateway, give the address Core should dial
     (`<host-ip>`), port `50066`, then *Adopt Gateway component*. Six checks run
     (config → availability → version → CSR → signing → TLS).
4. **Configure OIDC** so the desktop can mint tokens for paired devices: Settings → OpenID → register a client. Note client ID + secret — these go into the desktop operator app's mobile-pairing config.
5. **Mint an API token** for `bin/mesh-enroll-desktop`: Settings → API tokens →
   create one, and put it in `apps/operator/.env.local` as `DEFGUARD_API_TOKEN`.
   Without it the enrollment script exits before generating any config.
   > ⚠ **EI-8815 (verified live 2026-07-09):** on this instance, Bearer-token
   > auth with `DEFGUARD_API_TOKEN` against `/api/v1/me` and
   > `/api/v1/device/network/ip/1` currently returns `401 {"msg":"Session is
   > required"}` — i.e. `bin/mesh-enroll-desktop` does NOT currently work
   > end-to-end as written, even with a freshly-minted token in place. The
   > WI-3454 re-enroll worked around this with **browser-session auth**
   > (logged into the admin UI, used the session cookie) instead of the API
   > token. Root cause not yet isolated — could be a missing token scope, or
   > these device-network endpoints may not accept API-token auth at all in
   > this Defguard version. Don't assume the token path works; verify live
   > before relying on it, and prefer the browser-session workaround until
   > this is root-caused.

## What runs on this box

| Service | Port | Purpose |
|---|---|---|
| `caddy` | 80, 443 | TLS termination, reverse proxy to core / edge / posthog |
| `core` | 8000 (internal) | Admin UI + API; dials the gateway to adopt it |
| `edge` | 8080 (internal) | Edge component (`defguard-proxy`), fronted at `relay.` |
| `gateway` | 50066/tcp (adoption gRPC), 51820/udp | WireGuard data-plane fallback when direct P2P fails |
| `postgres` | (internal) | Metadata storage |

The gateway runs with `network_mode: host`, so its ports are the host's — it
does not appear in `docker inspect ... NetworkSettings` with an IP, and `wg0`
lives in the **host** netns (`wg show wg0` on the host, not in the container).

## Cost

- Hetzner CX22: €4.51/mo (~$5)
- Domain `mesh.papercuspai.com`: $0 (subdomain of existing)
- Bandwidth: 20 TB/mo included; relayed traffic is small (only fallback) so you'll never approach this.
