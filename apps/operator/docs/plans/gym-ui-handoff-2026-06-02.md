---
title: Handoff brief — Generalized Gym UI (prompt-edit + proposer-diff review)
slug: gym-ui-handoff-2026-06-02
status: handoff
audience: the agent building the gym UI
backend-owner: (this agent — gym engine, robustness framework, read-api, proposer, generalization wiring)
created: 2026-06-02
---

# Handoff brief — Generalized Gym UI

You're building the **UI** for the harness gym. I (the other agent) own the **backend**
(gym engine, the agent-turn-robustness framework, `read-api.ts`, proposer, promotion, and
the "works for any harness" wiring). You consume the contracts below; I'll provide/adjust
endpoints as you need them. Coordinate via `coord:*`.

## What the gym is (1 paragraph)

The harness gym runs a harness's *own* multi-agent pipeline on synthetic + real tasks,
scores each run with a frozen judge, and uses a reflective **proposer** to suggest edits to
the role prompts (worker/validator/judge/etc.) — an eval-driven self-improvement loop
(DSPy/GEPA for a coding harness). Plan: `harness-gym-eval-optimizer-2026-06-02.md`. We're
**generalizing it to any registered harness**: a user picks a harness, edits its custom
prompts (judge + any role), turns on autoloop, and **reviews the proposer's suggested prompt
changes in a merge/diff interface**, accepting or rejecting per role.

## Your scope — four surfaces

1. **Prompt editor** (per harness): edit the judge rubric prompt + each role's prompt
   (markdown). Use **`@uiw/react-md-editor`** (already a dep). Save → the prompt-override
   contract (below).
2. **Proposer-diff review / merge** (the headline ask): for each cycle, show the proposer's
   suggested prompt change per role as a **side-by-side diff** (original = current role
   prompt, modified = proposed), with the **rationale** + the hard numbers (dev-anchor Δ,
   cost Δ, probe status) beside it. **Accept → promote** (writes the override); **reject →**
   discard. Use the **Monaco `DiffEditor`** from **`@monaco-editor/react`** (already a dep)
   — it's the right "merge diff" surface for markdown *source*. (Markdown prompts are source
   text, so a source diff, not a rendered-prose diff. `diff`/jsdiff is also available if you
   want custom line/word rendering.)
3. **Autoloop control**: a per-harness toggle + status (running / paused / budget spent /
   last cycle), backed by the autoloop contract.
4. **Dashboard views**: frontier (Pareto scatter), variants (+ lineage), compare (A-vs-B),
   cycles (ledger). The layout + nuqs params + data binding are already drafted in
   **`apps/operator/lib/gym/DASHBOARD-MOCKUP.md`** — start there and extend it (incl. the
   new editor + diff-review surfaces).

## Data + contracts (what I expose / will add)

The **pure read cores already exist** in `apps/operator/lib/gym/read-api.ts`:
`compareVariants(sql,a,b,rubricHash)` → per-task `{taskId,aComposite,bComposite,delta}`;
`frontierView` → on-frontier variant ids; `readCycleHistory` → `{cycle,parentId,candidateId,decision}`;
`variantLineage`. The gym tables are `harness_gym.{gym_variants,gym_runs,gym_scores,gym_cycles,gym_runs_params}`.

The **proposer output shape** you'll render (`apps/operator/lib/gym/proposer.ts`
`CandidateProposal`): `{ overlay: { promptOverrides: Record<role, fullPromptMarkdown> },
rationale: string, diffFromParent: string }`. So "the judge's suggested changes" = the
candidate's `promptOverrides[role]` (the *new* full prompt) vs the parent's prompt for that
role → feed both into the DiffEditor.

**Endpoints — ✅ LIVE on `:3070` (D-020).** All workspace-scoped (active workspace via
`routeWithWorkspace`), `auth:'public'` like every sibling `/adv`,`/harness`,`/coord` route
(loopback-only model). Source: `apps/operator/lib/endpoint-route/routes/gym/control.ts` over
`apps/operator/lib/gym/control-plane.ts`.
- `GET /api/gym/harnesses` → `[{ harnessSlug, pendingCount, lastCycle, autoloop }]`.
- `GET /api/gym/:slug` → `{ harnessSlug, status, prompts:{judgeRubric,roles}, editableKeys }`.
- `GET /api/gym/:slug/prompts` → `{ judgeRubric, roles, editableKeys }`;
  `POST /api/gym/:slug/prompts { role, md }` (role=`'judge'` = rubric) → `{ ok, judgeRubric, roles }`.
- `GET /api/gym/:slug/proposals?status=pending` (`status=all` for history; `&variantId=` filter)
  → `{ proposals: [{ id, cycle, variantId, role, originalMd, proposedMd, rationale, devAnchorDelta, costDelta, probeStatus, status }] }`.
- `POST /api/gym/:slug/accept { id | variantId }` → promote `proposedMd` → `harness_prompt_overrides`;
  `POST /api/gym/:slug/reject { id | variantId }` → discard.
- `GET /api/gym/:slug/autoloop` → `{ autoloop, configured }`;
  `POST /api/gym/:slug/autoloop { enabled?, budgetUsd?, status? }`.
- `GET /api/gym/:slug/{cycles|variants|compare?a&b&rubricHash|frontier?rubricHash}` — run analytics;
  return `{ available:false }` until a gym run DB is wired server-side (`PAPERCUSP_GYM_DATABASE_URL`) —
  build the views against the shapes now.

Diff-review surface: render Monaco `DiffEditor(originalMd → proposedMd)` per proposal row,
rationale + (devAnchorDelta, costDelta, probeStatus) beside it; accept POSTs `{ id }`. Proposals
are produced by the gym loop (`makeLoopProposalRecorder`, `autoPromote:false`) — until the
autoloop runner service lands you can POST a test row via `psql` or build against `/proposals → []`.
TS types remain in `read-api.ts` / `proposer.ts` / `control-plane.ts`.

## Conventions you MUST follow (operator repo)

- **All user-meaningful state in nuqs** (URL), not `useState` — tabs, selected harness,
  selected variant/cycle, A/B selection, pool, the open diff. See CLAUDE.md "nuqs".
- **Design-docs first**: read `/internal/docs/design` + use `design-phase:*` tokens/registry
  before hand-rolling components. Match the operator design system.
- **It's the Tauri DESKTOP app.** Run/verify ONLY via the Tauri shell
  (`cd papercusp-desktop && npm run dev`) per `/internal/docs/testing` +
  `/internal/docs/testing/agent-e2e`. **Do NOT** open `:3055`/`:3070` in a browser /
  verdict / playwright for operator UI (a PreToolUse hook blocks it). `verdict` is for
  non-operator pages only.
- **Operator UI lives in the Vite SPA** (`apps/operator-vite`, TanStack Router) importing
  page impls from `apps/operator/app/**` via the `@/app` alias. New routes go there.
- **Testing**: Playwright e2e (`apps/operator/e2e/<name>.spec.ts`) + Vitest unit. Per the
  updated CLAUDE.md testing section, new tests must match a `/admin/testing` + `/adv` Tests
  tab registry glob — if `npm run lint:tests` fires for a new area, widen/add a domain in
  `apps/operator/lib/testing-domains-registry.ts` then `npm run gen:contract`. Use `verdict`
  only for ad-hoc non-operator browser checks.
- **Adding an MCP tool** (if you wrap any read for the UI): `defineTool` +
  `guidance.when` + the `tools-md-sync` test (CLAUDE.md "Adding a tool").
- Commit every turn (`git commit --no-verify`); stay on `main`; use `locks:*`/`coord:*`.

## Boundary (who owns what)

- **You:** the four UI surfaces + their nuqs state + e2e tests; the DiffEditor merge UX;
  the prompt editor; consuming my contracts.
- **Me:** the gym engine, the robustness framework, `read-api`, proposer, promotion, the
  generalize-to-any-harness wiring, and the endpoints/MCP tools above.
- **Sync:** ping me on `coord:*` for the contract you need next; I'll prioritize it. The
  proposer already emits the per-role diff data, so the **diff-review surface is unblocked**
  the moment I wrap `gym:proposals` + `gym:accept` (tell me if that's your first need).

## First steps I'd suggest

1. Read `DASHBOARD-MOCKUP.md` + the `read-api.ts`/`proposer.ts` types.
2. Build the **proposer-diff review** surface first (highest-value, and the proposer data
   shape is settled) against mocked `gym:proposals` data with Monaco `DiffEditor`.
3. Tell me to land `gym:proposals` + `gym:accept` so you can wire it live.
