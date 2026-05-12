# @papercusp/telemetry-sink

Reference HTTP sink for Papercusp desktop telemetry. Receives the
anonymized crash/diagnostic reports that the operator's flush worker
(`apps/operator/lib/telemetry-flush.ts`) POSTs when a user has opted
into telemetry and configured a `telemetry_sink_url`.

This is a **reference implementation**: it works as-is, but you should
treat it as a starting point and adapt to your hosting + retention
policy.

## What it does

| Method | Path       | Behavior                                              |
| ------ | ---------- | ----------------------------------------------------- |
| GET    | `/healthz` | liveness (always 200)                                 |
| GET    | `/readyz`  | readiness — checks PG reachability                    |
| POST   | `/report`  | accepts one telemetry report; inserts a row + returns `{ ok, id }` |

Wire shape (matches what the operator sends):

```json
{
  "workspace_id": "default",
  "received_at": "2026-05-12T18:48:14.301Z",
  "kind": "crash",
  "app_version": "0.0.1",
  "os": "linux",
  "payload": { "...": "anything" }
}
```

Each accepted report becomes one row in `papercusp_telemetry.events`
with the source IP attached for abuse investigation.

## Defenses (in order)

1. **Bearer token** — when `PAPERCUSP_TELEMETRY_SINK_TOKEN` is set the
   endpoint requires `Authorization: Bearer <token>`. When unset the
   endpoint is anonymous. Anonymous mode is fine for closed networks;
   set the token for anything internet-facing.
2. **Size cap** — bodies over `PAPERCUSP_TELEMETRY_MAX_BODY_BYTES`
   (default 32 KB) are rejected before parsing.
3. **Shape validation** — `workspace_id`, `received_at`, `kind`,
   `app_version`, `os` are strictly typed/length-limited. `kind`
   must match `/^[a-z0-9_\-]{1,64}$/i`.
4. **Per-IP rate limit** — token bucket, defaults to 30-burst
   /1-per-second (60 req/min sustained per IP). Tune via
   `PAPERCUSP_TELEMETRY_RL_CAPACITY` / `PAPERCUSP_TELEMETRY_RL_REFILL`.
5. **Put a CDN / reverse-proxy rate limit in front of this in
   production** — the in-memory limiter resets on restart and doesn't
   coordinate across instances.

## Config (env)

| Var                                | Default                                                 | Purpose                       |
| ---------------------------------- | ------------------------------------------------------- | ----------------------------- |
| `PORT`                             | `8787`                                                  | listen port                   |
| `PAPERCUSP_TELEMETRY_DB_URL` / `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:5432/papercusp_telemetry` | Postgres connection           |
| `PAPERCUSP_TELEMETRY_SINK_TOKEN`   | _(unset)_                                               | bearer token expected on POST |
| `PAPERCUSP_TELEMETRY_MAX_BODY_BYTES` | `32768`                                               | max request body size         |
| `PAPERCUSP_TELEMETRY_RL_CAPACITY`  | `30`                                                    | burst capacity per IP         |
| `PAPERCUSP_TELEMETRY_RL_REFILL`    | `1`                                                     | tokens added per second per IP |

## Deploy

### Local (dev)

```sh
npm install
npm run migrate       # creates papercusp_telemetry.events
npm run dev           # tsx watch on :8787
```

Then point an operator at it:

```sh
# Either via env on the operator process:
PAPERCUSP_TELEMETRY_SINK_URL=http://127.0.0.1:8787/report
PAPERCUSP_TELEMETRY_SINK_TOKEN=<your-token>

# Or via the Setup Wizard UI:
#   /settings/setup-wizard?step=telemetry → "Sink URL"
```

### Docker

```sh
docker build -t papercusp-telemetry-sink .
docker run --rm -p 8787:8787 \
  -e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/papercusp_telemetry \
  -e PAPERCUSP_TELEMETRY_SINK_TOKEN=$(openssl rand -hex 32) \
  papercusp-telemetry-sink
```

Run `npm run migrate` once against the target database before sending
the first report.

### Fly.io / Railway / Render / generic VPS

Drop the Dockerfile in; expose `PORT`; set the env vars above. The
service is stateless apart from PG — scale horizontally if you need to.

### Production checklist

- [ ] PG with daily backups (the reports are anonymized but represent
      operational ground truth; restoring from a corrupted store is
      worth more than the cost of backups)
- [ ] CDN / reverse proxy in front for TLS + edge rate limiting
- [ ] `PAPERCUSP_TELEMETRY_SINK_TOKEN` rotated per release of the
      desktop app (so a leaked token doesn't outlive the build it
      ships with)
- [ ] Retention sweep job: `DELETE FROM papercusp_telemetry.events
      WHERE ingested_at < now() - interval '<N> days'` on a cron
- [ ] Alerting on the `events_daily` view (e.g. spike in `kind='crash'`)

## Relationship to the operator's flush worker

The operator's worker
(`apps/operator/lib/telemetry-flush.ts`) reads its destination from
either `PAPERCUSP_TELEMETRY_SINK_URL` (env) or
`setup_wizard_state.telemetry_sink_url` (PG, configurable via the
Setup Wizard UI). It POSTs the same JSON shape this sink accepts and
sets `forwarded_at` on success. Failed POSTs are retried on the next
flush tick (default hourly) so a flaky sink doesn't drop reports.
