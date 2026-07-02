# Lane C — Worktree bridge & cold-clone bootstrap (git-plan fleet)

You are **Lane C** of the `git-plan` fleet (model `claude-fable-5` @ xhigh). Leader:
**su-3700b**. Plan: `cross-machine-coord-parity-and-trust-2026-07-01` (harness `papercusp`).

**FIRST:** read `docs/plans/FLEET-git-briefs-2026-07-01.md` — the LEADER-LANDED FOUNDATION
(you build on `storage.ts` + `fetch-transport.ts` + `integrator.ts`) and **§0 shared ground
rules**. Then `plans:get` each item. Build in `sync/hive-git/`.

1. **G-7c worktree advance = ff-only, NEVER reset --hard (P-040)** — do this FIRST; the others
   depend on the invariant. A machine's working tree advances to a new canonical `staging` ONLY
   when it is a fast-forward of the local worktree head; otherwise SURFACE it (return a
   "diverged, manual" result), never `reset --hard`. Pure decision + the git apply.

2. **G-7 worktree bridge (P-031)** — `sync/hive-git/worktree-bridge.ts`: on a staging-advance
   event, fetch the canonical staging (via `fetchPeerNamespace`/`fetchOverDuplex` from
   `fetch-transport.ts`) then ff-update the working tree to it. Injectable seams so it tests
   against a real temp worktree + bare repo, no swarm. Acceptance (integration test): a
   ff-advance updates the worktree; a divergent one is refused + surfaced.

3. **G-7b worktree-advance safety invariant (P-036)** — a staging advance NEVER touches a file
   the local user has dirty/uncommitted. Check `git status --porcelain` (or an index diff)
   before applying; if the advance would overwrite a dirty path, refuse + surface. Acceptance:
   a dirty file blocks the advance of that path; a clean tree advances.

4. **G-8 cold-clone bootstrap (P-032)** — `bootstrapFromPeer(localRepo, duplex, ...)`: a new
   joiner seeds the WHOLE repo (all member namespaces + staging) from any one member peer via
   the G-2 transport (fetch `refs/namespaces/*`). Acceptance (integration test, two bare repos +
   a socket duplex, reuse the `fetch-transport.integration.test.ts` link pattern): a fresh empty
   repo ends up with every namespace the peer had.

Report `coord:send { to:['su-3700b'], plan_slug:'cross-machine-coord-parity-and-trust-2026-07-01' }`
on each item green or on a blocker. The leader reviews every diff.

## STATUS AT LAUNCH (2026-07-02 ~08:50Z, from leader su-3700b)
All 4 lane items open: P-031 (G-7 worktree bridge), P-032 (G-8 cold-clone bootstrap), P-036 (G-7b advance safety test), P-040 (G-7c ff-only advance — marked wip by a DEAD recovery bee; rehome it, check for partial work in sync/hive-git/ before starting).
Lane B landed staging-advance.ts (epoch-fenced advance events), release-promotion.ts, handoff-token.ts in sync/hive-git/ — your worktree bridge consumes staging-advance events; build on those modules.
