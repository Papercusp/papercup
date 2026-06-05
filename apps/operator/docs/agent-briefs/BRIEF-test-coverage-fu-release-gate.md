# BRIEF — Follow-up: release-gate CLI chokepoint test + release-manager pin/persona (EI-7)

**Parent:** BRIEF-test-coverage-2026-06-04 (lead: su-5cf8c). **Readiness: READY NOW** — release-gate (release-gate-ready-branch-2026-06-04, su-f7aab) is settled; no active owner is editing `apps/operator/lib/release/`. This brief is **fix + test** (a small product refactor is in scope, unlike the parent's test-only rule).

## Context: what's already covered
The parent brief added (all green): `health-probe.test.ts`, `verify-release-paths.test.ts`, `deploy-gate.test.ts` (gatherPlan non-FF/forced + the refusal predicate transcribed inline + `release-manager ∈ AGENT_ROLES`), `deploy-rollback-edges.test.ts`, and `release-actions.test.ts` (system-action registration + release-trigger noop-gating). Two things were **deferred because they need a product change**, which the test-only parent brief couldn't make:

## Task 1 — Make `deploy-cli.ts main` testable, then test the real exit-2 chokepoint
`apps/operator/lib/release/deploy-cli.ts` runs `main().then(process.exit)` at module top-level and exports nothing, so it can't be imported without launching a real deploy. The parent brief tested `gatherPlan` + transcribed the gate predicate, but **never drove the CLI's own refusal exit code**.
- Refactor: export `main` (taking injectable `argv`/deps) and guard the top-level call with `if (import.meta.url === pathToFileURL(process.argv[1]).href)` (the ESM equivalent of `require.main === module`). Minimal, standard, no behavior change for the real CLI.
- Then test (in `apps/operator/lib/release/deploy-cli.test.ts`): a non-green `ready` with no `--force` → `main` returns exit 2 and **never** invokes `executeDeploy`/the swap; a green non-noop target → proceeds; `--deploy-commit` forces + emits the loud audit broadcast.

## Task 2 — EI-7: give release-manager an in-tree model pin + persona, then test
See issue **EI-7**. The `release-manager` role is in `AGENT_ROLES` but has **no committed model pin** (AGENT_MODELS is env-only; the "opus:xhigh" is a `.env.local` value + a doc-comment) and **no persona/tools prompt**. So the deploy gate's judgment half silently downgrades on any host without the env var.
- Add a committed default model pin for `release-manager` in the role→model default map (find where other roles' defaults live; the env `AGENT_MODELS` should OVERRIDE, not be the only source).
- Add `apps/operator/prompts/release-manager.persona.md` (+ `.tools.md` if the role needs scoped tool guidance) — model it on an existing reviewer/validator persona; its job is to judge a green-checkpoint deploy candidate (read `apps/operator/lib/release/README.md` for the gate's intent).
- Test: assert the committed default resolves `release-manager` to the intended high-tier model even with `AGENT_MODELS` unset, and that the persona file exists + is non-empty (mirror an existing persona-presence test if one exists).
- **This is partly an owner design call** (whether to pin in-tree vs keep env-driven). If you disagree with pinning, comment on EI-7 instead of forcing it — but don't leave it silently degradable.

## Rules
- Pre-alpha: a clean refactor that makes the gate correct is welcome (no back-compat shim needed). Surface what you changed.
- Verify: `cd apps/operator && npx vitest run lib/release/` green; `npm run lint:tests` passes. If you touch AGENT_ROLES/model config, run `cd packages/operator-core && npx vitest run lib/__tests__/tools-md-sync` + any role-config test.
- Close EI-7 (issues:close) when done, or comment with the outcome.
