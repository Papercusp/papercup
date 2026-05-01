# Live data replication: local → Hetzner

The harness *runtime* runs on the local laptop. Hetzner Postgres is a logical-
replication subscriber so papercupai.com always reflects current local state.

## Layout

```
[local laptop]                      [Hetzner]
papercusp Postgres :5432            restart-postgres-1
  └── publication papercup_mirror     └── subscription papercup_from_local
        (101 tables across 17 schemas)        ↓ writes
                                           harness_shared.* + harness_<slug>.*
                                              ↓ caught by zero_harness pub
                                           papercup-zero-cache
                                              ↓ websocket
                                           papercupai.com browsers
```

## Wire path

Hetzner can't reach local PG directly (NAT). A reverse SSH tunnel
(local → Hetzner port 5433) is held open by `papercup-pg-tunnel.service`
on the local laptop:

```
local PG :5432  ←──── reverse SSH ────  Hetzner :5433  ←──  restart-postgres-1
                                       (0.0.0.0)              (10.0.2.1:5433)
```

Hetzner's `/etc/ssh/sshd_config` has `GatewayPorts clientspecified` so the
tunnel can bind the docker bridge gateway IP.

## One-time setup

### 1. Hetzner schema migration

Local has features (config_token, directive_summaries, executed_actions,
messages, supervisor_notes per harness; autoloop_state, token_index in
harness_shared; parent_slug column in projects) that didn't exist on
Hetzner. Apply once:

```sh
ssh root@178.156.253.226 'docker exec -i restart-postgres-1 psql -U postgres_app -d papercusp' \
  < deploy/replication/01-hetzner-schema-migration.sql
ssh root@178.156.253.226 'docker exec -i restart-postgres-1 psql -U postgres_app -d papercusp' \
  < deploy/replication/02-hetzner-shared-missing.sql
```

### 2. Local: publication + tunnel

Publication on local DB:

```sql
-- See generated CREATE PUBLICATION in 03-local-publication.sql for the
-- full table list (101 tables across 17 common schemas).
CREATE PUBLICATION papercup_mirror FOR TABLE ...;
```

Tunnel via systemd user unit (already installed at
`~/.config/systemd/user/papercup-pg-tunnel.service`):

```sh
systemctl --user enable --now papercup-pg-tunnel.service
```

### 3. Hetzner: subscription

```sh
ssh root@178.156.253.226 'docker exec -i restart-postgres-1 psql -U postgres_app -d papercusp' <<'SQL'
CREATE SUBSCRIPTION papercup_from_local
  CONNECTION 'host=10.0.2.1 port=5433 user=postgres_app password=postgres dbname=papercusp'
  PUBLICATION papercup_mirror
  WITH (copy_data = true, create_slot = true, slot_name = 'papercup_from_local');
SQL
```

Initial copy takes ~60s for 101 tables. Verify with:

```sh
ssh root@178.156.253.226 'docker exec restart-postgres-1 psql -U postgres_app -d papercusp -tAc \
  "SELECT srsubstate, COUNT(*) FROM pg_subscription_rel GROUP BY srsubstate"'
# Expect:  r|101  (all tables in 'ready' state)
```

## Monitoring

- Tunnel up? `systemctl --user status papercup-pg-tunnel.service` on local.
- Subscription healthy? Connect to Hetzner postgres and `SELECT * FROM pg_subscription;`.
- Replication lag? `SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(),
  confirmed_flush_lsn)) AS lag FROM pg_replication_slots WHERE slot_name='papercup_from_local';`
  on local.

## Failure modes

- **Tunnel drops**: autossh reconnects; Postgres subscription keeps state and
  resumes from the WAL slot. Bounded by `wal_keep_size` on local.
- **Local PG schema diverges further**: subscription apply worker errors out;
  visible in `restart-postgres-1` logs as `relation "..." does not exist` or
  `column "..." of relation "..." does not exist`. Re-run a schema migration
  on Hetzner to catch up.
- **Initial copy needed for new harness schema**: `harness_<new>` schemas
  added on local won't auto-replicate. Add them to local's `papercup_mirror`
  publication and refresh the subscription:
  ```sql
  -- on local:
  ALTER PUBLICATION papercup_mirror ADD TABLE harness_<new>.harness_features, ...;
  -- on hetzner:
  ALTER SUBSCRIPTION papercup_from_local REFRESH PUBLICATION;
  ```

## Why not run harnesses on Hetzner directly

That's the long-term answer (no replication needed; Hetzner becomes
authoritative). Requires:
- claude CLI in the operator container
- ANTHROPIC_API_KEY in compose env
- Persistent worker loops for each harness (systemd in operator container)
- Plugin runtime (papercusp CLI) installed there
- Snapshot/git working trees on Hetzner storage

That's a separate project — likely a few days of design + testing. This
replication path is the bridge until then.
