# Harness Tests-tab domains are harness-owned, not operator-hardwired
URL: /internal/docs/agent-insights/harness-tests-tab-domains

The harness Tests tab's domain nav comes from the harness's OWN contract at <worktree>/.papercusp/testing-domains.json (served by GET /api/harness/:slug/testing/domains), falling back to the generic generalized+Acceptance set. Do not special-case a harness in operator code. Also — harness endpoints resolve against reg.current (the global active workspace), so a CLI curl can silently hit the wrong workspace.

import { Aside } from '@astrojs/starlight/components';

Two things to know before you touch the harness **Tests** tab (`/adv` →
`HarnessTestsView` → `@papercusp/testing-shell`, backed by
`/api/harness/:slug/testing/*`).

## The domain nav is HARNESS-owned data, not an operator registry

The operator's testing API (`/api/admin/testing/*`; the old `/admin/testing`
UI route was removed 2026-06-11) reads `adminRegistry` (the 8-domain Universal
tier — formerly "generalized" — plus \~30 Papercusp domains, i.e.
`[...operatorUniversal, ...papercuspRegistry]`) from
`packages/operator-core/lib/testing-domains-registry.ts` — operator-internal code.
The **harness** Tests tab does NOT import that. Each harness declares its own
test domains in its contract surface:

```
<worktree>/.papercusp/testing-domains.json   ->  { domains: TestDomain[], tierLabels?: {} }
```

served by `GET /api/harness/:slug/testing/domains`
(`endpoint-route/routes/harness/testing.ts` → `loadHarnessDomains(root)`). A
harness that declares **no** file falls back to the generic
`harnessTestingRegistry` (Built-in *Universal* tier + Acceptance —
`[...universalDomains, ACCEPTANCE_DOMAIN]`, in
`packages/operator-core/lib/harness-testing-registry.ts`). The frontend fetches
that route for its nav; it does not import a static registry.

The wrong fix (rejected) was `isSelfHarness(slug) ? adminRegistry : …` wired
into the view/route. That hard-wires the operator's internal registry into a
harness surface. The right place for a harness's test config is the harness's
own `.papercusp/` contract — the same surface where `tests.json` (tester-created
tests) lives. To give a harness more domains, write its
`.papercusp/testing-domains.json`; don't edit operator code.

The **papercup dogfood harness** (its worktree IS the operator repo) ships a
`.papercusp/testing-domains.json` **generated from `adminRegistry`** (so there's
no hand-maintained drift) — that's why its Tests tab shows the full
`adminRegistry` set while a generic harness shows the sparse Universal tier +
Acceptance. Regenerate it the same way (load `adminRegistry` + the Acceptance
domain, serialize) if the domains change. Note that several Universal-tier
domains are `admin-suite` runners that are non-functional in the harness
data-source, and others (`live-web`/`chaos-web`/`routes`) glob operator-internal
paths — so for a *non-papercup* harness the Built-in tier is mostly empty;
that's expected, not a bug. Default the nav to the first non-`universal`
(content-bearing) tab.

"Generated from `adminRegistry` so there's no hand-maintained drift" is the
*intent*, not the dev-box reality. The only guards that catch a stale
`.papercusp/testing-domains.json` (or a test file that matches no domain glob →
invisible in the tab) are `gen:contract:check` and `lint:tests` — and those run
**only in GitHub Actions CI** (`.github/workflows/test.yml`). git-sync commits
the shared tree with `[skip ci]`, and the local green-checkpoint gate runs only
`npm run test:affected` (the registry self-tests check structure, not
contract↔registry freshness). So on the dev box a stale contract sails straight
to `main`/`:3070` and the Tests tab silently shows old domains. Found 2026-06-18:
the committed contract was stale and a real test (`gitnexus-bridge/index.test.ts`)
was an uncaught orphan. **After ANY edit to `testing-domains-registry.ts`, run
`npx tsx scripts/gen-testing-domains-contract.ts` + `npm --prefix apps/operator
run lint:tests`** yourself — do not trust the tab to reflect a registry change,
and do not trust CI to have caught a stale contract. (Systemic fix tracked
separately — wire both gates into green-checkpoint.)

## Harness endpoints resolve against `reg.current` — your curl can hit the wrong workspace

`resolvePhasedProject(slug, phase)` resolves the harness from the registry
scoped to `activeWorkspaceId()`, which reads `current` from
`~/.papercusp-workspaces/registry.json` — a **single global** value, not
per-request. The `:3070` host serves whatever `reg.current` is *right now*.

This bites hard when debugging: a `curl /api/harness/papercup/...` returns
`{"error":"unknown project"}` not because the harness is gone, but because
`reg.current` is a workspace that doesn't contain it (it switches under you —
the desktop, or a concurrent agent, flips it). I burned real time concluding
"the papercup harness was deleted" when it was simply that `reg.current` had
moved from `papercusp-workspace` to `default` mid-session.

Check the active workspace and where the harness actually lives:

```bash
python3 -c "import json;d=json.load(open('$HOME/.papercusp-workspaces/registry.json'));print('current:',d['current'])"
```

To list a *specific* workspace's harnesses (the `?workspace=` query param on
`projects/lite` is ignored — it uses `reg.current`), call
`loadHarnessRegistry('<workspace-id>')` directly via a one-off `tsx` script.
The papercup self-harness lives in the `papercusp-workspace` workspace, pointed
at the operator repo.

Corollary: server-side edits to `harness/testing.ts` need a host restart
(`systemctl --user restart papercup-dev-api.service`) — the `:3070` host has no
hot-reload — and frontend edits to `HarnessTestsView` ship via the operator-vite
watch-build + a desktop reload.
