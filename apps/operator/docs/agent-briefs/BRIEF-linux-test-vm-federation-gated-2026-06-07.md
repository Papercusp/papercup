# BRIEF — Linux test VM federation: the VM-based two-instance federation tail (gated on P-009)

**Type / mission.** VM-based federation testing, **GATED**. Once the VM provisioning prerequisite (P-009, owned by the live VM-federation agent su-d82af620) is in, run the `--vms=1` host<->VM federation mode, the stretch `--dht=public` Mode-B variant, and write the federation docs. Plan `linux-test-vm-and-federation-2026-06-04` (Phase 2). **All three items are blocked by P-009, which is claimed by the VM-federation owner and is NOT in this briefable set** — so this brief is primarily an **after-blockers-clear** mission. It also hosts the cross-host voice-mesh measurement that Brief 6 (voice-channels) depends on.

## The items (verbatim, plan `linux-test-vm-and-federation-2026-06-04`)

- **linux-test-vm-and-federation-2026-06-04 P-010** *(blocked-by P-009)* — `--vms=1` mode (host-instance ↔ VM-instance).
- **linux-test-vm-and-federation-2026-06-04 P-012** *(blocked-by P-009)* — Stretch: `--dht=public` variant toward true Mode B.
- **linux-test-vm-and-federation-2026-06-04 P-013** *(blocked-by P-009)* — Docs: federation subsection in `vms.md` + (post-pass) an agent-insight page.

## After blockers clear (do NOT execute prematurely)
- **P-010, P-012, P-013 are all blocked by P-009** (`--vms=N` provisioning), which is **claimed by su-d82af620** (the live VM-federation owner) and outside this set. **Coordinate with that owner via `coord:*`** — do not race the VM provisioning. When P-009 lands and the VMs can boot operator instances, execute P-010 (`--vms=1` host<->VM), then the P-012 stretch (`--dht=public`), then P-013 docs.
- **Cross-brief dependency:** Brief 6 (holepunch-voice-channels) P-014 (2/5/10-peer mesh latency/bandwidth) needs these VMs to each join a voice channel — once `--vms` works, surface to Brief 6 that the mesh measurement can run.

## Primary file surface (collision contract)
- the VM provisioning/federation harness scripts + `vms.md` (the federation subsection) + a post-pass agent-insight page
- read-only against the federation substrate (do NOT edit `lib/sync/hyperbee/**` — parked under EI-79)

**Coordination:** owns the VM/`vms.md` surface — disjoint from the other 15 briefs' source. The real dependency is the live owner's P-009, not a file lock.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- Until unblocked: a watch is registered + coordinated with the P-009 owner; nothing run prematurely.
- Once P-009 lands: `--vms=1` host<->VM federation passes; the `--dht=public` stretch attempted; `vms.md` federation subsection + the agent-insight page written; Brief 6 notified that the voice-mesh measurement can run.
