# @papercusp/coordination

Agent-coordination substrate, extracted from
`apps/operator/lib/agent-tools/coordination/` as **three host-agnostic
pieces** (papercusp-systems-abstraction D-009 / P-011). No
`@papercusp/*` / `@restart/*` runtime deps.

## The three pieces

| Import | What it is | Storage |
|---|---|---|
| `@papercusp/coordination/core` | Pure protocol layer — envelope types + `newMsgId`, glob matcher, watermark merge, and the fold/filter logic (thread, inbox, handoffs, escalations, plan-events, promote validation). | none (pure) |
| `@papercusp/coordination/event-log` | `CoordEventLog` — the **one swappable** append-only channel-log seam. `FsCoordLog` (portable default) + `InMemoryCoordLog` (double). Covers messages, handoffs, escalations, plan-events. | fs / in-memory / (future PG) |
| `@papercusp/coordination/presence` | `PresenceStore` — live agent presence. `PgPresenceStore` (over an injected PgHandle) + `InMemoryPresenceStore` (double). | PG / in-memory |

`CoordEventLog` and `PresenceStore` are deliberately separate
interfaces (D-009): an append-only event log and a mutable
single-row-per-owner presence table are different data models, not one
logic over two engines.

## What stays host-side (by design — NOT in this package)

- **Identity resolution** (`resolveAgentIdentity` from a host ctx) —
  host/ctx glue. The pure core receives resolved owner-id strings.
- **Watch/notify subscriptions** — the host fires them as a callback
  (the locks system depends on this); only the pure glob matcher
  (`patternToRegex`) is extracted into `core`.
- **Watermark persistence** — a watermark is a mutable per-agent
  read-cursor doc, not an append-only channel; only its value shape +
  pure `mergeWatermark` live in `core`. The host owns the read/write.
- **`defineTool` verb wrappers**, role gating, and `coord/` repo-root
  resolution.

## Seam injection

`FsCoordLog` takes a `coordDir: () => string` resolver (the host owns
repo-root / env policy). `PgPresenceStore` takes `getSql: () => Sql`
and `ensureSchema: () => Promise<void>`. Both `*InMemory*` doubles pass
the same conformance suites as the production impls — the swappability
(P-050) gate.

Tests: `npm test` (vitest). The PG presence impl is exercised by the
operator's live `coord:presence` dispatch (it needs a real
`harness_shared` schema); the package suite pins the in-memory double.

## Detached-mode proof (P-051)

`examples/detached-mode.ts` stands the whole substrate up with **zero
operator and zero Postgres** — it imports only `core` + `event-log` and
runs the full L3 loop (messages/inbox, thread fold, handoff accept,
append-only escalation resolve, plan-events) over an OS temp dir, proving
the portability claim (D-004): a detached agent participates purely over
the filesystem. Run it:

```
npx tsx packages/coordination/examples/detached-mode.ts   # exits 0 on PASS
```
