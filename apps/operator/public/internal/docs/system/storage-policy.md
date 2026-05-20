# Storage policy — Postgres by default
URL: /internal/docs/system/storage-policy

When to put state in Postgres vs. when a file is the right answer. Default is PG; the exceptions are short and specific.

# Storage policy

**New durable state goes in Postgres by default.** Files are reserved for
specific cases listed below.

## Why this is a policy and not a preference

Across rounds 1-14 of the file→PG migration we've moved \~30 distinct surfaces
out of files / in-memory `Map`s into PG. The same drift pattern keeps
recurring:

1. Someone "temporarily" stores state in a JSON file or a module-local Map.
2. It works fine on a single-process desktop.
3. A second consumer reads it (settings UI vs. runtime, mobile vs. desktop,
   restart vs. live process) and now there's drift between two sources of
   the same data.
4. A later session has to migrate it under load, often after a real bug.

The migrations are mechanical and the cleanup is consistent. Better to land
new state in PG from day one.

## Default: Postgres

For per-workspace single-row-per-key state, the helper is
`apps/operator/lib/operator-state-pg.ts`:

```ts
import { readOperatorState, writeOperatorState } from '@/lib/operator-state-pg';

const cur = await readOperatorState<MyShape>('my_table');
await writeOperatorState('my_table', { /* … */ });
```

Steps to add a new piece of state:

1. Write a SQL migration at `libs/papercusp/libs/db/sql/<NNN>-<slug>.sql` —
   typical shape is `(workspace_id TEXT PK, payload JSONB, updated_at BIGINT)`.
2. Add the table name to the `StateTable` union in `operator-state-pg.ts`.
3. Use `readOperatorState` / `writeOperatorState` / `updateOperatorState` from
   your module.
4. If the data is sensitive (API keys, bearers, signing fingerprints), add
   the table to `ENCRYPTED_TABLES` in `apps/operator/lib/db-encryption.ts`
   and follow the cipher pattern from migration 027 + the runbook in
   `/docs/system/credentials-encryption`.

For compound-key tables (per-harness, per-feature, append-only audit logs),
write a focused module that runs SQL directly via `getOrgPg()`. See
`apps/operator/lib/operator-notes.ts` (compound key) or
`apps/operator/lib/provision/audit-log.ts` (append-only) for examples.

## Acceptable file uses

Files are correct for these specific cases:

| Use                                                                     | Example                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Bootstrap state needed before a PG connection exists                    | `~/.papercusp-workspaces/registry.json`, `~/.papercusp/db-encryption-key`  |
| Postgres's own data                                                     | `pglite-data/`, `embedded-pg-data/`                                        |
| Code, scripts, templates, snapshots                                     | `provision/runner.ts:RUNTIME_LIB_SH`, plugin tarballs                      |
| Harness contract artifacts read by tools running inside the harness     | `<harness>/.harness/config.json`, `SPEC.md`, `supervisor-notes.md`         |
| Append-only logs at high volume where SQL log tables would dwarf state  | `.harness/action-runs/<runId>.log` (run metadata in PG, log bytes on disk) |
| Per-process locks via O\_EXCL                                           | `expert-dispatcher.ts` lockfiles                                           |
| Plugin-sandbox storage (the plugin host exposes a virtual FS by design) | `plugin-host.ts` `read`/`write` API to plugins                             |
| Per-device UX preferences that should NOT sync across devices           | voice config (per audio stack), one-time UI hint dismissals                |

## NOT acceptable

These patterns recur and have all been migrated; please don't reintroduce:

* **Plain JSON state files for app-level operator data.** Use PG.
* **Module-scoped `Map<>`s holding TTL'd auth/session state.** OAuth nonces
  (round 12), mobile pair tokens (round 13), rate-limit state (round 13)
  all looked fine until a restart killed an in-flight flow or a bypass
  emerged. Use PG.
* **localStorage that should sync across devices.** If "settings should
  follow the user, not the device", it's not localStorage data; it's
  `operator_user_profile` data with a small `/api/profile` REST surface +
  localStorage as a per-device cache (round 14 pattern).
* **File-primary, PG-mirror.** Round 11 caught two of these
  (`dismissed.json`, `prompt-user.md`); they always drift. Either go full
  PG or document a real reason the file is authoritative.
* **Duplicating bearer tokens or other secrets to disk** when they're
  already in PG. The duplicate is just an extra plaintext surface to leak
  (round 9 caught operator + oracle config files duplicating
  `token_index` rows).

## Dual-purpose state: PG-primary, file-mirror

Some surfaces are **both** operator state (read by the UI) and harness
contract (read by tools inside the harness process). Feature notes are
the canonical example: the orchestrator's role prompt directs LLMs to
write `<projectDir>/.harness/notes/<featureId>.md` so the autonomous
worker reads it; the operator UI also reads/writes the same notes for
human-in-the-loop steering.

The correct pattern is **PG-primary, file-mirror**:

* Writes go to PG first (canonical, cross-machine sync, encrypted-at-rest
  if sensitive).
* Then `writeFile` the same content to the disk path (best-effort —
  the PG row above wins if the disk write fails).
* Reads merge PG + file content, deduping by a stable key (e.g.
  `(author, ts)` for note blocks). The worker may write blocks
  directly to the file via tool use; reads should pick those up too.

Round 6 (file→PG) missed this duality and removed the file write
entirely, silently breaking the autonomous worker's view of user notes
for \~weeks. Round 17 restored it. Don't drop file mirrors when the
file is part of the harness contract — verify by grepping the
orchestrator role-prompt for the file path before refactoring.

## When you genuinely need a file

If your state truly fits one of the acceptable buckets, document *why* in
the module's header doc. Lessons learned: the round-11 audit found a
"file fallback for offline/pre-migration safety" that nobody had updated
since the PG side was finished — the comment was right when written and
wrong by the time we found it. If you write a "we use a file because X"
comment, link to the issue or spec section that justifies it so the next
auditor can confirm the X still applies.

## Migration history

| Round | Surfaces                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-5   | Operator state JSON files (budget, last-scan, idle-snapshot, voice-prefs, voice-creds, agent-config, scanner-session, first-run, user-profile, prompt-user, preferences, publish-credentials, oracle prompt+memory, marketplace token) |
| 6     | Harness registry, feature notes, provision state + audit log + trust store                                                                                                                                                             |
| 7     | pgcrypto encryption-at-rest for credentials-class tables                                                                                                                                                                               |
| 8     | Operator-config bifurcation; system principals; orphan cleanup                                                                                                                                                                         |
| 11    | `paused.flag`; `dismissed.json` flipped from file-primary to PG-primary                                                                                                                                                                |
| 12    | OAuth nonces (Map → PG)                                                                                                                                                                                                                |
| 13    | Mobile pair tokens; per-workspace rate limit (Maps → PG)                                                                                                                                                                               |
| 14    | Browser localStorage for cross-device preferences (auto\_scan, toast\_last\_seen\_ms)                                                                                                                                                  |

If you're adding new state and it's not obviously in this list, default to PG.
