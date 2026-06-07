# BRIEF — Voice operator persona, production readiness (prompt/persona hardening for the voice brain)

**Type / mission.** Prompt/persona engineering + LLM-scenario coverage. Harden the voice operator persona against the failure modes the plan catalogs: cap-holding under weak models, explicit card-based disambiguation, grounding (never narrate state before the tool result), banning domain jargon/IDs in `<say>`, and stray built-in emissions (the brain emitting `Bash(...)` into voice). Plan `voice-persona-production-readiness-2026-06-02`.

## The items (verbatim, plan `voice-persona-production-readiness-2026-06-02`)

- **voice-persona-production-readiness-2026-06-02 P-002** — If a stronger instruction doesn't hold the cap (models are weak
- **voice-persona-production-readiness-2026-06-02 P-003** — Make card-based disambiguation explicit: "when a voice
- **voice-persona-production-readiness-2026-06-02 P-004** — Grounding: never narrate state/an action before the tool result
- **voice-persona-production-readiness-2026-06-02 P-007** — Voice jargon: ban domain-internal jargon/IDs in `<say>` for voice
- **voice-persona-production-readiness-2026-06-02 P-008** — Stray built-ins: the brain emitted `Bash({command:'echo …'})` as a

## Primary file surface (collision contract)
- the **voice operator persona/playbook prompt files** (`<role>.persona.md` / `<role>.tools.md` for the voice/operator brain under `packages/operator-core/lib/` prompt-assembly inputs) — owns the voice-persona prose
- `apps/operator/lib/llm-testing/scenarios/<role>/` — judge-scored voice scenarios for each behavior (cap, disambiguation, grounding, jargon ban, no stray built-ins)
- the voice `<say>` / built-in-emission guard logic if a deterministic backstop is needed (confirm the exact module via the plan before editing)

**Coordination:** this is the only brief editing the **voice persona prompts** — disjoint from the TUI/desktop voice **transport** work in Brief 6 (holepunch-voice-channels). Keep to persona/scenario surfaces; do not edit the voice socket/transport.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- Each behavior has a judge-scored LLM scenario that fails the old persona and passes the hardened one (the cap holds; disambiguation emits a card; no state narrated pre-tool-result; no jargon/IDs in `<say>`; no stray `Bash(...)`).
- `npm run test:affected` green; the tools-md-sync test stays green if any tool `guidance`/allowed-surface changed (`tools-md-sync.test.ts`).
- If a behavior cannot be enforced by a stronger instruction (P-002's "if a stronger instruction doesn't hold the cap"), surface the deterministic-backstop decision rather than shipping a weak prompt.
