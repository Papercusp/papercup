# Defguard control plane (Papercusp mesh)

Self-hosted WireGuard mesh control plane. Phones and desktops join this mesh; data flows direct P2P between them, falling through the gateway when NAT prevents direct.

## Hetzner setup

1. Create a CX22 (€4.51/mo) in a region near you. Image: Ubuntu 24.04.
2. Add SSH key, set up firewall rules:
   - 22/TCP (SSH, your IP only)
   - 80/TCP, 443/TCP (Caddy)
   - 50051/TCP (Defguard gRPC for gateways)
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

1. **Create the gateway token:** Settings → Network → "Add Gateway" → copy the token, paste into `.env` as `GATEWAY_TOKEN`, `docker compose up -d gateway`.
2. **Create a Location:** Settings → Locations → "Add Location" — call it `papercusp-mesh`, allowed IPs `10.10.0.0/24` (or whatever).
3. **Configure OIDC** so the desktop can mint tokens for paired devices: Settings → OpenID → register a client. Note client ID + secret — these go into the desktop operator app's mobile-pairing config.

## What runs on this box

| Service | Port | Purpose |
|---|---|---|
| `caddy` | 80, 443 | TLS termination, reverse proxy to core |
| `core` | 8000 (internal), 50051 (public) | Admin UI + API + gateway-control gRPC |
| `gateway` | 51820/udp | WireGuard data-plane fallback when direct P2P fails |
| `postgres` | (internal) | Metadata storage |

## Cost

- Hetzner CX22: €4.51/mo (~$5)
- Domain `mesh.papercuspai.com`: $0 (subdomain of existing)
- Bandwidth: 20 TB/mo included; relayed traffic is small (only fallback) so you'll never approach this.
