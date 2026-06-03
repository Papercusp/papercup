# Writing JSONB columns with postgres-js — use JSON.stringify::jsonb, not sql.json
URL: /internal/docs/agent-insights/postgres-js-jsonb-binding

In operator runtime code (getOrgPg) sql.json(obj) THROWS and a bare object param THROWS — bind JSONB as ${JSON.stringify(value)}::jsonb. The testcontainer client (_pg-helpers) binds JSONB differently, so integration tests can't faithfully test it; verify against the live host.

import { Aside } from '@astrojs/starlight/components';

## TL;DR

To write a JS object/array into a **JSONB** column through the operator runtime
client (`getOrgPg().sql`, `libs/papercusp/libs/db/connection.ts`), bind it as:

```ts
await sql`INSERT INTO t (payload) VALUES (${value == null ? null : JSON.stringify(value)}::jsonb)`;
```

**Do NOT** use `sql.json(value)` and **do NOT** pass a bare object `${value}` —
both THROW under `getOrgPg`:

```
TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string
or an instance of Buffer or ArrayBuffer. Received an instance of Object
    at Buffer.byteLength (node:buffer)
    at .../postgres/cjs/src/bytes.js  (the Bind step)
```

Verified live (P-070 `contributor_usage_events.payload`): `JSON.stringify(v)::jsonb`
stores a real jsonb object — `jsonb_typeof(payload)='object'`, `payload->>'k'` works.

## The trap: the testcontainer client behaves OPPOSITELY

The integration-test client (`apps/operator/test/_pg-helpers.ts`, used by every
`*.integration.test.ts`) binds JSONB params **differently** from the operator
runtime client — despite *identical* postgres-js config (`prepare:false`, same
`types:{bigint}`, same postgres 3.4.9):

| form                            | `getOrgPg` (runtime / production) | `_pg-helpers` (testcontainer)     |
| ------------------------------- | --------------------------------- | --------------------------------- |
| `sql.json(obj)`                 | **throws**                        | works (jsonb object)              |
| `${obj}` (bare)                 | **throws**                        | works (jsonb object)              |
| `${JSON.stringify(obj)}::jsonb` | **jsonb object** ✓                | double-encodes → jsonb **string** |

The root cause of the divergence is unexplained (configs match); it is likely a
postgres-js protocol/connection nuance. The practical consequences:

A `*.integration.test.ts` using `_pg-helpers` will give the WRONG answer for
JSONB param binding — `sql.json` passes there but breaks in production, and the
correct `JSON.stringify::jsonb` form looks "double-encoded" there. **Verify JSONB
write behavior against the live host** (`jsonb_typeof(payload)` over the running
operator's DB), not the testcontainer. Assert only client-agnostic things
(no-throw, row lands, rollup counts) in the integration test.

## Status of affected files

**Fixed 2026-06-03** — every getOrgPg-client jsonb write now binds via
`${JSON.stringify(x)}::jsonb`:

* `apps/operator/lib/sync/hyperbee/projections/issues.ts` (`notes`)
* `apps/operator/lib/sync/hyperbee/projections/contributors.ts` (`device_attestations`)
* `apps/operator/lib/sync/hyperbee/projections/harness-features.ts` (`metadata`, `tags`)
* `apps/operator/lib/sync/hyperbee/projections/usage.ts` (`payload`)
* `apps/operator/lib/agent-governor-pg-store.ts` (`limits`)

The projections also gained `normalizeJsonbInput()` (a `_jsonb-input.ts` helper):
a federated row whose jsonb arrived already-stringified (from a peer on a
double-encoding client) is re-parsed before the write, so the CDC outbox
round-trip stays `IS DISTINCT FROM`-stable. No-op under getOrgPg.

Fixed earlier in P-070: `lib/harness/usage-events.ts`.

**NOT affected — do NOT "fix" these to `${JSON.stringify}::jsonb`:**

* `apps/operator/lib/dock-layouts.ts` and `apps/operator/lib/llm-testing/*` use a
  *fresh* `postgres()` pool (`db()` = `postgres(getHarnessAdminUrl(), {prepare:false})`),
  NOT getOrgPg. On that client `sql.json()` is CORRECT and `${JSON.stringify}::jsonb`
  double-encodes — the inverse of the getOrgPg rule. Leave their `sql.json()` as-is.
* `apps/operator/lib/operator-rate-limit.ts` already binds correctly with
  `${JSON.stringify}::jsonb` (live-verified `jsonb_typeof=object`, with accumulated
  rate-limit state). A 2026-06-03 report that flagged it as a double-encode bug was a
  false positive from testing against the testcontainer client (which behaves oppositely).
