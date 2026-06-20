# papercupai.com → Hetzner deployment

Coolify-driven, three containers on the existing Hetzner host shared with
Restart. Postgres + Traefik network are reused.

## What ships

| Container | Hostname | Purpose |
|---|---|---|
| `papercup` | `papercupai.com` (+ `www.` redirect, + `api.papercupai.com` for `/api/public/papercup/*`) | Next.js public site |
| `operator` | _internal only_ (`http://operator:3055`) | Harness backend (apps/operator) |
| `papercup-zero-cache` | `zero-papercup.papercupai.com` | Rocicorp Zero — browser-side live queries |

All three share `restart-postgres` on the `coolify` Traefik network.

---

## State as of 2026-05-01

What works:
- All three containers deployed; `papercupai.com`, `api.papercupai.com`,
  `chat.papercupai.com`, `docs.papercupai.com`, `zero-papercup.papercupai.com`
  resolve and TLS-terminate correctly.
- Server-rendered registry counts on `papercupai.com` populate from
  operator's `/api/harness/projects`.

What's broken or missing:
1. **`api.papercupai.com/healthz` returns `internal: down`** — papercup
   container can't reach `operator:3055`. Either operator is down or the
   docker network linking lost the alias on a recent redeploy.
   `docker compose -f /opt/papercup-wip/docker-compose.papercup.prod.yml up -d operator`
   should resolve. If not, check `docker logs papercup-operator-1`.
2. **Zero-driven counts on the public site are 0** — the prior
   `HarnessZeroProvider` hardcoded `localhost:4849`. Fixed in commit
   `900f0b7` (env-overridable) and commit `<this commit>` (root layout
   injects `window.__HARNESS_ZERO_SERVER` from the `HARNESS_ZERO_SERVER`
   container env). Compose now sets it to
   `https://zero-papercup.papercupai.com`. Requires a papercup redeploy.
3. **`/opt/papercup-data/restart-org` bind-mount removed** from the
   compose. The `/api/org/*` router was deleted in the public-site
   harness migration; nothing reads this directory anymore. The host
   directory at `/opt/papercup-data/restart-org` can be deleted after
   the next redeploy completes.

## Cutover steps for a fresh deploy

### 1. Pre-flight on Hetzner

```sh
ssh -i ~/.ssh/id_ed25519 root@178.156.253.226

# Bootstrap the papercusp DB and papercup_shared schema in the existing
# restart-postgres container.
docker exec -i restart-postgres-1 psql -U postgres < /opt/papercup/deploy/papercusp-db-init.sql
```

### 2. Migrate Postgres data from local

```sh
# Local laptop
pg_dump -Fc -h localhost -U postgres papercusp        > /tmp/papercusp.dump
pg_dump -Fc -h localhost -U postgres -n papercup_shared restart > /tmp/papercup_shared.dump
scp /tmp/papercusp.dump /tmp/papercup_shared.dump root@178.156.253.226:/tmp/

# Hetzner
ssh root@178.156.253.226
docker cp /tmp/papercusp.dump        restart-postgres-1:/tmp/papercusp.dump
docker cp /tmp/papercup_shared.dump  restart-postgres-1:/tmp/papercup_shared.dump
docker exec restart-postgres-1 pg_restore -U postgres -d papercusp /tmp/papercusp.dump
docker exec restart-postgres-1 pg_restore -U postgres -d restart   /tmp/papercup_shared.dump
```

### 3. Coolify resource

1. Coolify → Projects → Restart → New Resource → Docker Compose
2. GitHub source: `papercupai/papercup`, branch `main`, compose path
   `docker-compose.papercup.prod.yml`
3. Submodules: enable in Coolify's Git settings (the GitHub App must have
   read access to the eight submodule repos under `papercupai/*`).
4. Env vars (Coolify UI):
   - `PAPERCUP_DOMAIN=papercupai.com`
   - `POSTGRES_PASSWORD=<same as Restart>`
   - `PAPERCUP_DATABASE_URL=postgres://postgres_app:${POSTGRES_PASSWORD}@restart-postgres:5432/papercusp`
   - `PAPERCUP_SHARED_DATABASE_URL=postgres://postgres_app:${POSTGRES_PASSWORD}@restart-postgres:5432/restart?options=-c%20search_path=papercup_shared,public`
   - `HARNESS_DATABASE_URL=${PAPERCUP_DATABASE_URL}`
   - `HARNESS_ADMIN_DATABASE_URL=postgres://postgres_admin:${POSTGRES_PASSWORD}@restart-postgres:5432/papercusp`
   - `ZERO_ADMIN_PASSWORD=<any non-empty value>`
5. Deploy. First build takes ~6–8 min.

### 4. Verify

```sh
# 200 + browser-side Zero connect should populate "Active projects" / "Features passed"
curl -k --resolve papercupai.com:443:178.156.253.226 https://papercupai.com/ | head -30

# /healthz should report ok=true
curl https://api.papercupai.com/api/public/papercup/healthz

# Operator reachable from papercup container
docker exec papercup-papercup-1 wget -qO- http://operator:3055/api/build-info

# Zero-cache reachable from outside
curl https://zero-papercup.papercupai.com/keepalive
```

### 5. Cloudflare DNS (one-time)

- `papercupai.com`: proxied A → `178.156.253.226`
- `www.papercupai.com`: proxied A → `178.156.253.226`
- `api.papercupai.com`: proxied A → `178.156.253.226`
- `zero-papercup.papercupai.com`: proxied A → `178.156.253.226`
- `docs.papercupai.com`, `chat.papercupai.com`: already routed elsewhere

### 6. Tear down legacy tunnel

```sh
systemctl --user stop cloudflared-papercup.service
systemctl --user disable cloudflared-papercup.service
```

In Cloudflare Zero Trust → Networks → Tunnels: delete `papercupai-api`.

---

## Running harnesses on Hetzner (deferred)

The current setup keeps the harness *runtime* on the local laptop; only
the Postgres + Zero state is in Hetzner. Moving harness execution to
Hetzner is its own project — unresolved questions:

- Where do harness git working trees live? (`/papercusp-projects` host
  bind exists; orchestrator + run.sh need to point at it.)
- Plugin hooks fire via `papercusp-fire-hook` — does it run inside the
  operator container, or in a sibling worker?
- Does the local `papercusp` CLI become a remote API call, or does each
  developer run their own local harness against the shared Postgres?
- Snapshot storage: Hetzner local FS, or R2?

Track separately. Until then, harnesses run locally and the public site
shows their state via the shared Postgres.
