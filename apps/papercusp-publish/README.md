# `@papercusp/publish-worker`

Cloudflare Worker that fronts CF Pages for hosted publishing — implements
spec §16. Users borrow our infrastructure: they hand us a manifest + files,
we provision/update a CF Pages project under our master account, and they
get a `*.preview.papercuspai.com` URL within ~30s.

The substrate side lives at `libs/papercusp/plugins/cloudflare-pages-hosted/`.

## Architecture

```
┌──────────────────┐                  ┌──────────────────────┐                  ┌─────────────┐
│ substrate :3055  │   JWT + JCS      │ publish.papercuspai  │   master token   │  CF Pages   │
│ plugin           ├─────────────────►│ Worker (this app)    ├─────────────────►│  API        │
│                  │   manifest       │  + D1 + KV + R2      │                  │             │
└──────────────────┘                  └──────────────────────┘                  └─────────────┘
        ▲                                       │
        │                                       │ wildcard route
        │                              *.preview.papercuspai.com
        │                                       ▼
        │                            user's browser ──► reverse-proxy to <prefix>.pages.dev
        └────────────────────────────────────────────────────
```

## Prerequisites (one-time admin setup)

1. **Workers Paid** plan ($5/mo) on the CF account — required, free plan caps subrequests at 50 per Worker invocation.
2. **`wrangler` CLI** installed + authenticated:
   ```
   npm install -g wrangler
   wrangler login
   ```
3. **`papercuspai.com`** zone on the same Cloudflare account.
4. **R2 bucket** `papercusp-marketplace-tarballs` (already exists from M2 marketplace work; we share, prefix `publish/`).

## First-time bootstrap

```bash
cd apps/papercusp-publish

# 1. Create the D1 database. Note the database_id printed; paste into wrangler.toml.
wrangler d1 create papercusp-publish

# 2. Apply the schema.
npm run d1:apply:remote

# 3. Create the KV namespace. Paste id into wrangler.toml.
wrangler kv:namespace create papercusp-publish-counters

# 4. Install secrets (CF_MASTER_TOKEN, CF_ACCOUNT_ID, JWT_SECRET, HASH_PEPPER).
bash scripts/install-secrets.sh

# 5. Deploy.
wrangler deploy

# 6. Add DNS records via dash (one-time):
#    publish.papercuspai.com   → CNAME to <worker>.workers.dev (or via Worker route — auto if wrangler.toml routes set)
#    *.preview.papercuspai.com → CNAME to <worker>.workers.dev (or via Worker route — auto)
#    Wildcard cert: dashboard → SSL/TLS → Edge Certificates → Total TLS = on (or order an Advanced wildcard).
```

## Local development

```bash
# 1. Stub secrets for `wrangler dev`
cat > .dev.vars <<EOF
CF_MASTER_TOKEN=local-stub
CF_ACCOUNT_ID=local-stub
JWT_SECRET=bG9jYWwtanQtc2VjcmV0LWNoYW5nZS1tZS1pbi1wcm9k
HASH_PEPPER=bG9jYWwtcGVwcGVyLWNoYW5nZS1tZS1pbi1wcm9k
EOF

# 2. Apply schema to local D1
wrangler d1 execute papercusp-publish --local --file migrations/001_init.sql --persist-to .wrangler-local

# 3. Run the Worker
wrangler dev --local --port 8788 --persist-to .wrangler-local

# 4. (in another terminal) End-to-end smoke test
SMOKE_BASE=http://localhost:8788 npm run smoke
```

`local-stub` for `CF_MASTER_TOKEN` activates short-circuits in `cf-pages.ts`
that fabricate Cloudflare API responses, so the full publish flow is
exercisable without real credentials. **Never** set `local-stub` in production
secrets — set the real master token via `bash scripts/install-secrets.sh`.

## Routes

| Method | Path                                | Auth        | Purpose                                       |
|--------|-------------------------------------|-------------|-----------------------------------------------|
| GET    | `/`                                 | none        | service liveness                              |
| GET    | `/healthz`                          | none        | health check                                  |
| POST   | `/register-tenant`                  | none (v1)   | issue tenantId + tenantSecret                 |
| POST   | `/publish/start`                    | JWT         | manifest → deploymentId + missing[] uploadUrls|
| PUT    | `/publish/file/:dep/:sha?token=`    | signed-URL  | per-file body (≤25 MB)                        |
| POST   | `/publish/finalize`                 | JWT         | trigger CF deployment                         |
| GET    | `/publish/status/:dep`              | JWT         | poll status                                   |
| POST   | `/rotate-secret`                    | JWT         | issue new tenantSecret, invalidate old        |
| POST   | `/admin/gc/abandoned-uploads`       | cron only   | mark stuck uploads failed (>1h)               |
| POST   | `/admin/gc/expired-archives`        | cron only   | delete R2 prefixes past TTL (30d/365d)        |
| POST   | `/admin/gc/jti`                     | cron only   | drop expired replay-guard rows                |

Wildcard host `*.preview.papercuspai.com` is reverse-proxied to the project's
auto-generated `<prefix>.pages.dev`.

## Rate limits (per §15.5)

| Tier | Limit |
|---|---|
| Per-IP register-hourly | 10/h |
| Per-tenant burst       | 5/min |
| Per-tenant daily       | 50/day free, 500/day paid |
| Per-IP publish-daily   | 50/day (closes wipe-`~/.papercusp` loophole) |
| Per-file               | 25 MB |
| Per-deployment files   | 20,000 |
| Per-deployment bytes   | 1 GB |

## Security trade-off (v1)

The spec §15.4 mandates HMAC(secret, HASH_PEPPER) verification for tenant
secrets. That's one-way and can't verify the per-publish JWT (which is HMAC-
signed by the secret). **v1 stores `tenantSecret` directly** in `tenants.secret_b64`;
D1 is at-rest encrypted by Cloudflare. **v1.1 hardening**: AES-GCM envelope
encryption with `HASH_PEPPER` as the key.

`HASH_PEPPER` is otherwise unused in v1 but required as a Worker secret so
v1.1 can flip the encryption switch without a coordinated secret-rollout.

## Eject path (§15.7)

The plugin supports `byoCloudflareToken` + `byoCloudflareAccountId` config.
If both are present, the substrate plugin bypasses this Worker entirely and
calls CF Pages directly with the user's token. R2 archive is the v1.1
admin-runnable migration path; data model already lives in `r2-archive.ts`.
