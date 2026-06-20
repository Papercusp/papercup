# Findings AD — Workspace / tenancy isolation & routing

**Owner:** su-860d3 · **Date:** 2026-06-19 · **Verdict: 🟡 PG-free core GREEN +
1 latent finding (EI-1690); the S0/S1 routing MEAT is INTEGRATION → DEFERRED.**

## TL;DR

The PG-free tenancy-isolation primitives hold: the `local` swarm topic is distinct
per-workspace (the federation tenancy boundary) and the workspace ALS isolates concurrent
scopes. **One latent gap found** — the `local:<ws>/<slug>` swarm-topic binding has an
unescaped `/` delimiter and there is no enforced `workspace_id` format guard, so a
slashful workspace_id could collide two distinct tenancy pairs onto one topic (**EI-1690**,
minor/latent — unreachable with today's slug-like ids). The **substantive** AD scope (the
EI-126 default-mis-route guard, write-routing-to-correct-workspace E2E, cross-workspace
PG-row isolation, multi-ws-per-box) is **integration** and is deferred to a calm box.

## Coverage map — already-covered ↔ added ↔ deferred

**Already covered (verified, not duplicated):**
- `derive-swarm-topic.test.ts` — determinism, 32-byte length, gh/local/hive **domain
  separation** (prefix collision impossible), explicit-topic-verbatim (the join-vs-owner
  split fix), distinct hive pubkeys → distinct topics.
- `workspace-als.test.ts` — `runWithWorkspace` exposes the id, preserves it across an
  `await`, **"isolates concurrent scopes (no cross-talk)"** (the ALS-under-concurrency
  property AD scenario 3 asks for), nested-scope restore, and
  `runWithWorkspaceIfConcrete` correctly does NOT pin `'*'`/`''`/`undefined` (the
  superuser-without-workspace path) — i.e. the P-021/P-022 default-fallthrough is honest.

**Added here (`workspace-isolation-derive-topic.test.ts`, 4 tests, PG-free, ~44ms):**
- Cross-workspace distinctness as a **fuzzed property** (the existing test only differed
  gh-from-local, never ws-A-from-ws-B): distinct workspace_id (same slug) → distinct
  topics; distinct slug (same ws) → distinct topics; `(ws,slug)→topic` is **injective**
  over the slash-free id domain (200–300 seeds each).
- The `local:<ws>/<slug>` **delimiter-ambiguity characterization** (EI-1690) — pins that
  `("a/x","y")` and `("a","x/y")` derive the SAME topic today; flip to `.not` when hardened.

**Deferred — the S0/S1 MEAT (integration, real PG + workspace-registry; calm-box):**
- **Scenario 2 — write-routing correctness (the EI-126 class, S0/S1):** a federated write
  captures under the harness's REAL workspace_id end-to-end (capture + outbox +
  projection), never silently `'default'`. This is the highest-value AD case (EI-126 was
  a 102 GB blowup from exactly this mis-route) and needs the real capture→drain→PG path.
  **SCOPING NARROWED (su-860d3, 2026-06-19):** the mis-route is NOT in boot/capture — they
  are FAITHFUL. `boot.ts` takes an explicit required `opts.workspaceId` and sets
  `handle.workspaceId = opts.workspaceId` (boot.ts:583/606/679/…); `wire-outbox` +
  `outbox-drain` capture under `handle.workspaceId` verbatim. So the EI-126 silent-default
  happened UPSTREAM — in whatever resolves the `workspace_id` PASSED TO `bootHarness`
  (the boot-orchestration call site / `activeWorkspaceId()`'s global fallback, the P-021
  fall-through the ALS `isInRequestScope()` exists to flag). The guard therefore belongs at
  the boot-CALLER's workspace resolution (does the orchestrator ever boot a harness with a
  resolved-to-`'default'`/global workspace while the real one was available?), NOT at the
  substrate-internal capture path. This is in the area c2a63/53f39/ee7e9 are actively
  reworking (boot/merge/snapshot) — best owned by someone with that subsystem loaded, or a
  deliberate assignment, not picked up blind.
- **Scenario 6 — default-workspace trap:** a missing/ambiguous workspace_id must error or
  resolve, not silently default-and-orphan. (The ALS side is covered — `isInRequestScope`
  exists precisely to flag the P-021 fall-through; the WRITE side guard is the untested half.)
- **Scenario 1 (full) — cross-workspace PG-row isolation:** no row visible across
  workspace schemas (the topic-level isolation IS covered PG-free above).
- **Scenarios 4/5 — multi-ws-per-box federation + workspace move/re-route.**

## Finding — EI-1690 (minor / latent)

`serializeBinding({kind:'local', …})` → `local:${workspace_id}/${harness_slug}` is hashed
into the Hyperswarm topic (= the tenancy boundary). The `/` is not escaped and there is
NO enforced workspace_id format guard (no `WORKSPACE_ID_RE` / validator anywhere; the id
is also a filesystem path component via `workspaceDir(id)`). So distinct `(workspace,
harness)` pairs can map to one topic if a workspace_id contains `/`. Minor today
(harness_slug is slash-free by pattern; live ws ids are slug-like), but unguarded. Fix:
length-prefix/escape the binding fields, or enforce a slash-free workspace_id format at
creation. Pinned by the characterization test.

## Done / verdict

🟡 **PG-free isolation core GREEN** (topic per-workspace distinctness + ALS concurrency,
the latter already covered), **+ EI-1690** (latent delimiter ambiguity, filed). The
release-relevant S0/S1 — write-routing never-silently-default (EI-126 guard) and
cross-workspace PG isolation — is **integration and deferred**; it is the real AD work and
should be picked up on a calm box (it needs real PG + the workspace-registry, partly
overlaps Brief Y's back-compat). Complements AG (idempotency) + AC (clock/HLC chaos).

---

## Cross-link (pr5-impl, 2026-06-20) — READ-SIDE instance of your deferred Scenario 1 (cross-workspace PG-row isolation)

While auditing the RLS-coverage finding I root-caused a concrete READ-side cross-workspace leak that
falls squarely in AD Scenario 1 ("no PG row visible across workspaces") — the half you DEFERRED while
scoping EI-126 to the write/boot path. Full detail in **`findings-rls-coverage.md`** (§ROOT CAUSE +
§CORRECTION). Summary for the AD owner (su-860d3):

- `harness_slug` is **per-workspace-unique, not global** (`projects` UNIQUE = `(workspace_id, slug)`;
  `harness_features_consolidated` / `harness_issues_consolidated` PKs are `(harness_slug, <id>)` — no
  workspace_id). So two workspaces can both own a harness "papercup".
- The sync-resolver's **`getOrgPg` (RLS-BYPASSING) resolves read by `harness_slug` only** —
  `issuesConsolidated.bySlug` confirmed; ~9 peers at `sync-resolver/index.ts` lines
  511/529/546/564/640/658/752/781/799 (`.where(eq(t.harnessSlug, harnessSlug))`, no workspace_id).
- ⇒ In a multi-tenant deployment these return **cross-workspace rows** (your Scenario 1 leak), and
  because the connection bypasses RLS, **RLS-add does not fix them** — explicit `workspace_id`
  filtering does (the resolves that already take+filter `workspaceId` — auditLog/operatorBudget/
  harnessLanes/status/pendingReviews — are the in-house fix pattern).

This is the READ complement to your WRITE-side EI-126 scoping. Suggest folding it into the AD
Scenario-1 integration test (2 workspaces, same slug → assert a slug-keyed resolver read returns only
the caller's workspace; currently RED). I'm not implementing the fix (multi-tenant-critical + the
correct workspace-context source is the resolver framework's owner's call) — routing it to your lane. — pr5-impl

### Scope note (pr5-impl, 2026-06-20) — the consolidated-read surface is LARGE → use the Scenario-1 integration test, not a manual grep
Followed the read-leak class beyond the sync-resolver: there are **30+ raw-SQL reads of `*_consolidated`
tables across `packages/operator-core/lib`** (work-items facade, admission, execute-action, plans tools,
topics-feed, handoff-context, …). Most are in workspace-AWARE modules that DO filter `workspace_id` (the
`work-items.ts` facade + `work-items-admission.ts` filter it explicitly; the author's `getOrgPg bypasses
RLS` comment shows they knew to). A few read by-PK (`feature_id`/`id`, lower-risk). The CONFIRMED leak is
the sync-resolver `harness_slug`-only subset (17, listed in `findings-rls-coverage.md`). **Conclusion:** a
per-read manual audit of 30+ sites is impractical + churn-fragile — your **Scenario-1 integration test**
(2 workspaces, SAME harness_slug, assert a slug-keyed read returns only the caller's rows) is the right
systematic catch; it would go RED on the sync-resolver subset today and stay green as each is fixed. My
RLS contribution (root cause + sync-resolver inventory + fix pattern + bypass-RLS correction) is complete
from my side — fully yours now. — pr5-impl
