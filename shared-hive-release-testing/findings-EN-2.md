# Findings — EN-2 (P-RATE) per-member rate-limit enforcement

**Author:** su-09486. **Plan:** `PLAN-owner-enforcement-layer.md` (Phase EN-2).
**Status:** 🟢 enforcement mechanism BUILT + teeth-verified (42 tests). Live boot
wiring is owned by EN-4 (su-151ef) who nests the EN-2 wrapper inside the single
`policy-admission` decorator; this doc is the EN-2 mechanism + trust-model record.

## What landed

Two pure, dependency-injected, fully-tested modules under
`packages/operator-core/lib/sync/hyperbee/`:

1. **`rate-limiter.ts`** — `MemberRateLimiter`, the pure decider. A deterministic
   per-`(github_user_id, class)` tumbling-window counter. Public surface:
   `decide(authorId, opId, tsMs, [{cls, cap}])` (atomic multi-class),
   `check(...)` (single-class sugar), `snapshot(caps)` (observability),
   `windowCount()`/`size()` (anti-OOM gauges), `capForClass(caps, cls)`,
   `RATE_WINDOW_MS`. `RateCaps` is a **type-alias of EN-1's canonical
   `HivePolicyRate`** (type-only import — no drift, runtime-pure).
2. **`rate-limit-admission.ts`** — `makeRateLimitedApply(deps)`, a drop-in
   `applyImpl` wrapper for the merge driver: author attribution + op
   classification + atomic enforcement + fail-closed + default-off passthrough.
   Helpers `classifyOpRate`, `buildOpId`, `originOf`, and the
   `CONTENT_TABLE_TAGS` / `NEVER_RATE_LIMITED_TABLE_TAGS` sets are exported for
   EN-4 reuse.

Wiring (EN-4's lane): `boot.ts` `mergeOpts.applyImpl` is decorated so the EN-2
rate gate runs INNER (ban/allowlist/content/takedown outer). `currentCaps()` =
`getHivePolicy(ws, hiveHomeProjectionSlug ?? slug)?.policy.rate ?? null`, refreshed
once per merge pass (NOT per op — the merge applies up to 50k ops/pass; an async
PG read per op is a non-starter). `resolveAuthorId` = `admittedIdentities.get(srcKey)?.githubUserId`.

## The core design — why it is convergent, bounded, and Date.now-free

**The hard constraint** of a P2P hive: honest peers must CONVERGE on the same
canonical state, so the drop decision must be a deterministic function of the op
STREAM, not of local wall-clock arrival timing (two peers receiving a flood at
different instants must drop the same excess or they diverge).

**The mechanism** (no consensus needed):
- The limiter is keyed **per author**. Every op from one member originates from
  that member's single append-only log, and every honest peer reads that one log
  in identical append-index order. So a member's ops are processed in the SAME
  order on every honest peer.
- Windows are **tumbling + absolute**, from the op's own write-time `ts`:
  `windowIndex = floor(ts / windowMs)`. Intrinsic to the op ⇒ identical everywhere.
- Within a `(author, class, window)` we admit the **first `cap`** ops (in log
  order) and drop the rest. Same input order + same cap ⇒ identical admit/drop set
  on every honest peer ⇒ exact convergence at the fixpoint.

**Idempotency (re-folds).** The substrate re-applies winning ops on a cursor reset
/ full re-fold. We remember ADMITTED opIds per window and short-circuit a replay to
its prior `admit`. A DROPPED op is **not** remembered — yet it re-drops
deterministically because the window's admitted count is already at `cap` and never
moves. This is the key memory property: dropped ops cost **O(1)**, so per
`(author, class, window)` state is at most `cap` opIds. An unbounded flood cannot
grow state. Window proliferation is bounded by pruning windows older than
`retentionWindows` behind the high-water-mark.

**No `Date.now()`.** The windowing + pruning clock is derived ENTIRELY from the op
stream's own timestamps (a monotonic high-water-mark). Safe in the substrate
sidecar/worker paths where `Date.now` is unavailable, AND deterministic (a real
clock would make the fixpoint host-dependent).

**Default-off.** `currentCaps()` null (no policy / no rate axis) ⇒ pure
passthrough, **zero behavior change** for an un-policed hive — proven both at the
limiter (`size()===0`, no state) and the wrapper (every op applies).

## Scope boundaries (stated honestly)

- **`opsPerMin` + `rowsPerHour` are substrate-enforced.** `ops` = every applied
  non-ephemeral, non-governance op; `rows` = content-table PUTs (the rows a flood
  lands in the canonical hive). Classification:
  - NEVER limited: `presence`, `usage` (ephemeral telemetry churn) + `contributors`,
    `hive-members`, `hive-settings-by-key` (identity/governance — and hive-settings
    carries the owner's signed policy itself; throttling it could choke propagation).
  - CONTENT (`ops`+`rows`): coord-messages/threads/thread-posts/conversations,
    issues, engineer-issues, features-by-id, plans-by-slug, plan-parts.
  - everything else (queue/working-set/claims/item-assignments): `ops` only.
- **`prsPerDay` is NOT substrate-enforced.** There is no PR op on the content
  substrate — pull requests ride the CODE plane (git-sync → `main`, Brief AH). The
  `prs` class exists in the type + limiter so the policy is complete and a future
  code-plane enforcer can reuse the SAME `MemberRateLimiter`, but EN-2's substrate
  wiring feeds only `ops` + `rows`. **The owner-facing GUI should label `prsPerDay`
  as code-plane (fast-follow), not silently accept a cap that does nothing.**
- **Local (own-log) ops are never limited** — they are the operator's own writes,
  not a member to police.

## Honest-majority trust model + the documented residual (ties Brief X)

- A malicious peer CAN ignore the policy on its own machine (its local store may
  hold the flood) but it CANNOT make honest peers accept the over-cap ops: every
  honest peer runs this gate independently and drops the excess, so the flood never
  becomes canonical on the honest majority. Proven:
  `rate-limit-enforcement.test.ts > honest-majority` (malicious peer store has 30,
  honest peer store has 3).
- **Residual (asserted, not hidden):** the limiter is deterministic over the
  op-INTRINSIC `ts` (required for convergence), so it cannot distinguish "100 ops
  genuinely one window apart" from "100 real-time-burst ops with forged spread-out
  `ts`". A truthful flood (a normal client stamps truthful clustered `ts`) is fully
  caught; a client RECOMPILED to forge `ts` across windows can pace under the
  per-window cap. This is an inherent limit of ANY convergent (op-time) scheme —
  perfect convergence + perfect evasion-resistance from self-declared timestamps is
  impossible without an external trusted clock/consensus. The `±1-window` clamp
  bounds the OOM dimension (a single far-future op cannot jump many windows; live
  windows stay ≤ retention) and the naive single-jump evasion; the slow-ramp
  residual is captured explicitly in `rate-limiter.test.ts > DOCUMENTED RESIDUAL`.
  Mitigation fast-follow: a non-convergent receiver-wall-clock burst guard
  (defense-in-depth, best-effort) and/or HLC-monotonicity bounds.

## Tests (teeth-verified) — 42 green, type-clean

- `rate-limiter.test.ts` (21): under/over cap, default-off (no state), cap 0
  block-all, window reset + boundary (no off-by-one), idempotent admit/drop replay,
  full re-fold reproduces the set, per-author + per-class isolation, cross-peer
  convergence (same per-author order, any interleave), anti-OOM (100k flood ⇒
  `windowCount ≤ 4`), the forged-ts residual, atomic multi-class `decide`, snapshot
  + throttled signal, TEETH (neuter ⇒ flood admits).
- `rate-limit-admission.test.ts` (14): classification, origin, opId stability,
  passthrough (no policy / local / ephemeral+governance), enforcement, per-author
  isolation, FAIL-CLOSED (unattributable), atomic ops-drop-doesn't-spend-rows,
  faithful apply-result passthrough, TEETH.
- `rate-limit-enforcement.test.ts` (7): drives the REAL
  `mergeAdmittedLogsIncremental` + the wrapper over in-memory peer logs + an
  in-memory canonical store — flood dropped, two honest peers converge WITHOUT the
  flood, honest-majority (malicious can't make it canonical), default no-op, no
  total ban (next-window ops apply), local never limited, anti-OOM through the merge.

The TEETH controls go RED if enforcement is silently a no-op (neutering the cap
re-admits the whole flood — proven at the limiter, wrapper, AND merge levels).

## Done bar

🟢 An owner-set per-member rate cap causes an honest peer to DROP a member's
over-cap ops at op admission (the member can't spam the canonical hive), with NO
effect when no policy is set, proven under an adversarial flood + cross-peer
convergence + anti-OOM — at the merge level. Remaining for full release: EN-4's
`policy-admission` boot wiring (in flight) + EN-1's GUI panel reading
`limiter.snapshot()` for the "member X at N/cap" surface.
