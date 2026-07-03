# The hive:* tool namespace — local hive lifecycle
URL: /internal/docs/agent-insights/hive-tool-namespace

The hive:* namespace is the full LOCAL hive lifecycle (a kind:'hive' harness + its Queen/bees) — list/get/create/dissolve/update plus the Queen run-loop verbs (start/pause/wake/declare-wake/status/survey). Gotchas — create/dissolve/update are root-only; create must stamp harness_kind:'hive' (harness:create doesn't); deploy:hive is a DISTINCT cloud step; bee placement stays fleet:*.

## What

`hive:*` (`packages/operator-core/lib/agent-tools/hive/`) is the **local hive
lifecycle** surface — the verbs that manage a hive on this machine:

* **`hive:list`** — workspace-local hives (kind:'hive' harnesses) + a live-agent count (one batched fleet read, no per-hive fan-out).
* **`hive:get`** — one hive in depth: wake schedule + bees `{doing,queued,load}` + todo frontier depth. A pure aggregator.
* **`hive:create`** / **`hive:create_from_repo`** — stand up a new hive (home harness + the `hive` blueprint + optional Queen wake), transactional with rollback; the `_from_repo` variant onboards a GitHub URL.
* **`hive:dissolve`** — tear one down (clear the wake, cancel bees, delete `hive_members`, tear down the learning loop + sandbox desktop, deregister; optional schema drop), confirm-gated + owner-tier-gated.
* **`hive:update`** — edit deployment target / per-instance config overrides.
* **`hive:start`** / **`hive:pause`** / **`hive:wake`** / **`hive:declare-wake`** / **`hive:status`** / **`hive:survey`** / **`hive:set-steering`** — the Queen run-loop control surface (start/pause the hive, fire or schedule the next wake, read status, the placement survey, owner steering).

It **composes** existing primitives (`fleet:*`, `coord:*`, `harness:create` internals) rather than reinventing them. A hive is read through one seam, `resolveHive` (`_resolve.ts`), which now points onto the first-class Hive entity (`shared-hive-federation`) — the verbs didn't have to change. (The same `hive:*` namespace also carries the **shared-hive** surface — membership/approval, moderation, and cross-hive ask/grant — covered in the [shared hives guide](/system/shared-hive-guide/).)

## Gotchas

* **Create/dissolve/update are ROOT-ONLY.** They refuse a parented bee (a `bee:spawn` child — `resolveAgentIdentity(ctx).source === 'fleet-spawn'`) up front; the `assertNotNestedHive` guard in `fireLaunchBlueprint` is the runtime backstop. Hives are peers, never nested — a bee that needs structure spins a `kind:'harness'` subharness, never a hive.

* **`hive:create` must stamp `harness_kind:'hive'` itself.** `harness:create` never sets `harness_kind`, and `resolveHive`/`hive:list` filter on it — so a hive home harness created any other way (or a pre-existing plain harness) is **invisible** to the namespace until stamped. `createHiveHarness` sets it; that's the one non-negotiable difference from a plain `harness:create { blueprintId:'hive' }`.

* **`deploy:hive` / `deploy:teardown_hive` are DISTINCT** — they are the *cloud execution-plane* (provision/destroy frames for an already-existing hive), not local lifecycle. `hive:create` does NOT deploy; `hive:dissolve` does NOT destroy a cloud frame. Order: `hive:create` → (later) `deploy:hive`; `deploy:teardown_hive` → `hive:dissolve`.

* **The Queen run-loop verbs live under `hive:*`.** `hive:start` / `hive:pause` (the hive on/off switch), `hive:wake` / `hive:declare-wake` (fire or schedule the next Queen wake; pause-without-stopping = `hive:declare-wake { mode:'none' }`), and `hive:status` / `hive:survey` are all in the namespace. (This supersedes the original `pot:*` aliasing — there is **no** `pot:*` tool namespace.) Bee placement stays `fleet:*`; per-loop error/backoff control is `autoloop:control`.

* **`hive:dissolve` leaves workspace-scoped event-wake subscriptions.** The hive time-wake routine is per-home-slug (cleared cleanly), but the hive's event-wake subscriptions are one row per *workspace* today — so dissolve clears only the time wake to avoid clobbering sibling hives (`dissolve.ts` step 1). The first-class Hive entity makes event subs per-hive.

## Tests

`agent-tools/hive/{_resolve,_create,dissolve,guard}.test.ts`: descriptor shaping, `harness_kind` stamping, create rollback-on-failure, dissolve unwind (incl. the membership / learning-loop / desktop teardown legs), and the root-only + owner-tier refusals — all PG-free (deps mocked). The live create→wake→dissolve path (a real Queen spawn on shared infra) is a manual smoke, not auto-run.
