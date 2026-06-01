---
title: Finish Next.js removal — rewrite the next/* shim sites + drop next deps
slug: finish-next-removal-2026-06-01
status: ready
created: 2026-06-01
updated: 2026-06-01
owner: avi@storewolf.com
---

# Finish Next.js removal — rewrite the next/* shim sites + drop next deps

## Now

**State:** Scoped from a fresh audit (2026-06-01). The Next→Vite migration's *running* stack shipped — the Vite SPA (`apps/operator-vite`, :3055) + the Hono host (`apps/operator/bin/hono-host.ts`, :3070) are live — but the canonical plan's **Phase H (actually remove Next) was never executed.** Today `operator-vite` is a thin TanStack-Router shell that imports its live page bodies from `apps/operator/app/**` through the `@/app` alias, with `next/{navigation,link,dynamic}` + `@bprogress/next` resolved by compat shims in `apps/operator-vite/shims/`. So the repo still ships the `next` (^16) + `@bprogress/next` deps and ~37 `next/*` import sites in `app/**` plus one live `lib/require-flag.ts` `NextResponse` use. Zero-Next is reachable by rewriting that finite surface to TanStack/native and deleting the shims/deps.

**Next:** Human confirms the scope split (D-001 — remove Next now, defer the directory-fold). Then **Phase 1** starts: rewrite the shimmed `next/*` sites, parallelizable by directory batch.

## Background

This plan finishes, not redesigns, the work in the **canonical** `operator-vite-migration-2026-05-20.md` (status: active). Read that for the frozen architecture decisions — it is authoritative; this plan only sequences the unfinished tail with a verified-current file inventory.

Two prior plans are **superseded/stale** and must not be followed: `next-removal-2026-05-20.md` (the deferred 14-week big-bang) and `next-removal-plan-2026-05-20.md`. Their conclusions were overtaken by the parallel `operator-vite-migration` effort that actually shipped.

The canonical plan's Phase B (page translation) and Phase C/E/F/G (Hono host, config port, Tauri shell, single-process) are **done**. The shims (B5) were shipped deliberately as a *migration enabler* — see canonical §B5 line 513: "this is a migration enabler, not a permanent compat layer. Decommission step is in Phase H: delete `shims/`, delete the resolve.alias entries." This plan is that decommission.

## Scope decision — remove Next now, fold the directory later (or never)

The canonical Phase H **bundles two separable goals** (canonical §H2, "frozen 2026-05-20"):

- **(a) Remove Next** — rewrite the shimmed `next/*` sites + `require-flag` to TanStack/native, delete the shims, drop the `next`/`@bprogress/next` deps, delete the dead Next runtime files. End state: **zero Next in the repo.**
- **(b) Relocate the directory** — physically move `apps/operator/{lib,bin,prompts,scripts,e2e,__tests__,app→src/components}` into `apps/operator-vite/server/` and delete `apps/operator/` as a directory, renaming `@papercusp/web`→`@papercusp/operator-vite` everywhere.

**This plan does (a) only.** (b) is a large mechanical import-path sweep that touches hundreds of files and the Tauri/build/CI wiring on a shared, multi-agent checkout — high churn, high collision risk, zero user-visible benefit beyond tidiness. Decoupling them delivers the user's actual goal (no Next) sooner and far more safely. (b) remains available as a follow-up (canonical §H2 already specs it); it is **out of scope here** and should be its own plan if pursued. See D-001.

## Verified current state (2026-06-01 audit)

| Fact | Evidence |
|---|---|
| `operator-vite` renders live source from `app/**` | **109** `import … from '@/app/…'` statements in `apps/operator-vite/src` (the `@` alias → `apps/operator` in `vite.config.ts`). `__root.tsx` alone pulls ~17 providers/components from `@/app/_components/**`. |
| `apps/operator/app/**` is **NOT dead code** | Contradicts the stale `CLAUDE.md` claim. Only the Next *runtime wrappers* (`app/layout.tsx`, the root `app/page.tsx`, `app/**/route.ts`, `loading/not-found`) are dead-to-Vite; the `*Client.tsx`/panels/`_components/`/some `page.tsx` are live-imported. |
| `app/api/_hono/` no longer exists | The live API is built from `lib/endpoint-route/**` via `bin/host-app.ts` (`registerRouteLiterals`/`registerRouteCatchalls`). Nothing under `app/` is live API code. |
| Only **one** live non-app file imports `next` | `apps/operator/lib/require-flag.ts` — `NextResponse` + `notFound` (its `gateApiRoute()` is used by ~25 live endpoint handlers). |
| The shims are load-bearing today | No `next` is installed for operator-vite to resolve against; the `vite.config.ts` aliases are what make the SPA's `import 'next/navigation'` work in the browser. Removing them requires rewriting the consumers first. |
| Genuinely dead-now cruft | `.next/` (982M) + `.next-prod/` (159M) gitignored build artifacts (~1.14 GB); root `@nx/next` (no `nx.json`/`project.json` exists); `next-themes` (0 import sites repo-wide); fumadocs (0 deps; Starlight is live). |
| Desktop repo is clean | `papercusp-desktop/src-tauri/tauri.conf.json` points at `:3055` (Vite) / `:3070` (Hono); no Next. |

## The exact remaining surface (greppable, verified 2026-06-01)

### Shimmed `next/*` sites to rewrite — 37 files

**`next/navigation` (23)** — `useRouter`/`usePathname`/`useSearchParams`/`useParams`/`redirect`/`notFound`/`useSelectedLayoutSegment`:
`app/_components/{ChromeShell,GlobalCommandPalette,OracleDock,OperatorPanel,RouteLink,RouteProgressProvider,RouteTransitionProvider,ConsoleLauncherButton,AgentLauncherButton,AutoLoginWelcomeToast,SetupWizard/SetupWizard}.tsx`, `app/admin/{page.tsx,_components/AdminShell.tsx}`, `app/settings/layout.tsx`, `app/page.tsx`, `app/login/page.tsx`, `app/signup/page.tsx`, `app/users/[login]/page.tsx`, `app/cupboard/{CupboardClient.tsx,[id]/page.tsx}`, `app/harness/[slug]/{HarnessDockShell.tsx,projects/ProjectsList.tsx}`, `app/installed/templates/[slug]/edit/EditTemplateClient.tsx`.

**`next/dynamic` (10)** — `dynamic(loader,{ssr,loading})` → `React.lazy`+`Suspense`:
`app/pi/page.tsx`, `app/dev/{page.tsx,_components/SqlTab.tsx}`, `app/editor-demo/page.tsx`, `app/harness/brainstorm/{CanvasView,BrainstormFull}.tsx`, `app/harness/dock/{useRegisterPluginPanels.tsx,RealGitPanel.tsx}`, `app/adv/harnesses/AdvGitPanel.tsx`, `app/installed/templates/[slug]/edit/EditTemplateClient.tsx`.

**`next/link` (4)** — `<Link href>` → TSR `<Link to>`:
`app/_components/RouteLink.tsx`, `app/project-docs/page.tsx`, `app/design/page.tsx`, `app/admin/_components/AdminShell.tsx`.

**`@bprogress/next` (4)** — already backed by a live `@bprogress/react` controller via the shim; rewrite imports to `@bprogress/react` directly:
`app/_components/{RouteProgressProvider,WorkspaceSwitcher,RouteLink}.tsx`, `app/marketplace/MarketplaceList.tsx`.

The shims already encode the exact target API (canonical §B5 table), so each rewrite is largely "change the import specifier + adapt the handful of call-site differences" (`useNavigate()` vs `useRouter().push`, etc.). Watch the `'use client'` + module-scope-hook hazard (canonical §B4): audit each file's top level for `use[A-Z]` calls outside the component body before dropping the directive.

### Live non-app rewrite — 1 file
`apps/operator/lib/require-flag.ts` — `gateApiRoute()` returns `NextResponse.json(...)`; rewrite to a plain `Response`/`new Response(JSON.stringify(...),{status,headers})` (it runs inside the Hono host). Drop the `notFound()` path (only served dead Next pages). ~25 endpoint handlers import it — no signature change needed, only the return construction.

### Shims + alias to delete (after the rewrites)
`apps/operator-vite/shims/{next-navigation,next-link,next-dynamic,bprogress}.tsx` and the `next/*` + `@bprogress/next` `resolve.alias` entries in `apps/operator-vite/vite.config.ts` (~lines 82–112).

### Deps to drop (after the rewrites)
- `apps/operator/package.json`: `next`, `next-themes`, `@bprogress/next`.
- root `package.json`: `next`, `next-themes`, `@nx/next` (+ the inert `@nx/*`/`nx` set — no nx config exists; optional broader cleanup).

### Dead Next files to delete (no live importer — verified)
`app/api/[[...route]]/route.ts` (catch-all `handle(app)` shim — replaced by `bin/hono-host.ts`; the backend stream may own this per canonical §H2), `app/wiki/route.ts` + `app/drizzle-studio/route.ts` (reimplemented in `bin/page-routes.ts`), `app/layout.tsx` (Next root layout — operator-vite uses `src/routes/__root.tsx`), `proxy.ts`, `instrumentation.ts`, `next.config.js`, `next-env.d.ts`, the `plugins:[{name:'next'}]` entry + `.next*/types` includes in `apps/operator/tsconfig.json`, the Next-shaped globs in `knip.json`, and the `.next/`+`.next-prod/` build dirs. **`app/page.tsx` / sub `page.tsx`: delete only after confirming zero `@/app/.../page` importers in `operator-vite/src` (some are live-imported) — gate on the acceptance grep, never blanket-`rm`.**

## Phase 1 — Rewrite the shimmed next/* sites to TanStack/native

Parallelizable by directory batch (each batch one PR/commit; lock the files, run typecheck + the relevant Playwright smoke). Suggested batches: `_components/*` (the shared chrome — biggest blast radius, do first), `harness/*`, `settings/*` + `admin/*`, `dev/*` + `editor-demo` + `pi`, `marketplace/*` + `installed/*`, the leaf pages (`login`/`signup`/`users`/`cupboard`/`project-docs`/`design`). Each file: swap `next/{navigation,link,dynamic}` + `@bprogress/next` imports to the TSR/`@bprogress/react` equivalents the shims already model; audit `'use client'` per §B4.
- **P-001** `done` Batch A (do first — biggest blast radius): rewrite app/_components/* shared-chrome next/navigation + next/link + @bprogress/next sites — ChromeShell, GlobalCommandPalette, OracleDock, OperatorPanel, RouteLink, RouteProgressProvider, RouteTransitionProvider, ConsoleLauncherButton, AgentLauncherButton, AutoLoginWelcomeToast, SetupWizard/SetupWizard. Swap to TSR/@bprogress/react per the shim API; audit 'use client' module-scope hooks (§B4). Sequence when the per-window-workspace stream is quiet. importance: high (Done in the full rehome sweep commit ed3cbe182)
- **P-002** `done` Batch B (coordinate with paperclip): rewrite app/harness/* next/* sites — harness/[slug]/HarnessDockShell, harness/[slug]/projects/ProjectsList, harness/brainstorm/{CanvasView,BrainstormFull}, harness/dock/{useRegisterPluginPanels,RealGitPanel}. (harness/* sites repointed in the sweep ed3cbe182)
- **P-003** `done` Batch C: rewrite settings/* + admin/* — settings/layout.tsx, admin/page.tsx, admin/_components/AdminShell.tsx (next/navigation + next/link). (settings/admin sites repointed ed3cbe182)
- **P-004** `done` Batch D: rewrite dev/editor/pi next/dynamic sites — dev/page.tsx, dev/_components/SqlTab.tsx, editor-demo/page.tsx, pi/page.tsx, adv/harnesses/AdvGitPanel.tsx (dynamic → React.lazy+Suspense). (dev/editor/pi sites repointed ed3cbe182)
- **P-005** `done` Batch E: rewrite marketplace/* + installed/* — marketplace/MarketplaceList.tsx (@bprogress/next), installed/templates/[slug]/edit/EditTemplateClient.tsx (next/navigation + next/dynamic). (marketplace/installed sites repointed ed3cbe182)
- **P-006** `done` Batch F (leaf pages): rewrite login, signup, users/[login]/page, cupboard/{CupboardClient,[id]/page}, project-docs/page, design/page, _components/WorkspaceSwitcher (@bprogress) — the remaining next/navigation + next/link sites. (leaf pages repointed ed3cbe182)







## Phase 2 — Rewrite lib/require-flag.ts

Replace `NextResponse.json` with a native `Response`; remove the `notFound` import. Verify all ~25 `gateApiRoute` consumers still compile and the gated `/api/*` routes return correct 403/404 bodies via the Hono host.
- **P-007** `todo` Rewrite apps/operator/lib/require-flag.ts: gateApiRoute() returns a native Response instead of NextResponse.json; drop the notFound import/path. Verify the ~25 gateApiRoute consumers compile and gated /api/* routes still return correct 403/404 via the Hono host. Independent of Phase 1 (can run in parallel). importance: high


## Phase 3 — Delete shims, drop deps, remove dead Next files

Only after Phases 1–2 make the acceptance greps pass: delete `apps/operator-vite/shims/` + the vite aliases, drop the `next`/`next-themes`/`@bprogress/next`/`@nx/next` deps, delete the dead Next files above, strip the Next entries from `tsconfig.json`/`knip.json`, `rm -rf` the `.next*` dirs. Run `npm install` (`--legacy-peer-deps`) + a clean `operator-vite` build.
- **P-008** `done` Delete apps/operator-vite/shims/{next-navigation,next-link,next-dynamic,bprogress}.tsx and the next/* + @bprogress/next resolve.alias entries in apps/operator-vite/vite.config.ts. Confirm operator-vite build stays clean with no real `next` resolvable. blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007 (shims/ + 5 vite aliases deleted; operator-vite build clean ed3cbe182. require-flag's next import is not Vite-bundled, so this didn't need P-007.)
- **P-009** `todo` Drop deps: next + next-themes + @bprogress/next from apps/operator/package.json; next + next-themes + @nx/next from root package.json (optionally the inert @nx/*/nx set). Run npm install --legacy-peer-deps; clean operator-vite build. blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007
- **P-010** `todo` Delete dead Next files (gate each on zero live importer): app/api/[[...route]]/route.ts (coord w/ backend stream), app/wiki/route.ts + app/drizzle-studio/route.ts, app/layout.tsx, proxy.ts, instrumentation.ts, next.config.js, next-env.d.ts; strip the plugins:[{name:'next'}] + .next* includes from tsconfig.json and the Next-shaped globs from knip.json; rm -rf .next/ .next-prod/. Do NOT blanket-delete page.tsx — only those with no @/app/.../page importer in operator-vite/src. blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007




## Phase 4 — Verify zero-Next + fix stale docs

Run the scorecard below. Then correct the docs the audit found wrong: `CLAUDE.md` ("`app/**` is dead code" and "`bin/dev`/`bin/prod` are gone" — both false), the `papercusp-su-engineer` playbook (":3055 Next.js layer" → Vite), and the `apps/operator-docs` MDX pages describing `next build`/`next dev` as current.
- **P-011** `todo` Run the zero-Next scorecard: no next/* imports across apps/libs/packages, no next deps, no next.config/proxy/shims; operator-vite build clean; /api/health + /internal/docs 200; npm run test:affected green. blocked-by: P-008, P-009, P-010
- **P-012** `todo` Fix stale docs the audit flagged: CLAUDE.md ('apps/operator/app/** is dead code' and 'bin/dev/bin/prod are gone' — both false), papercusp-su-engineer playbook (':3055 Next.js layer' → Vite SPA), and apps/operator-docs MDX pages describing next build/next dev as current (build-system/*, tsc-baseline-vs-next-build, data-sync/pitfalls). blocked-by: P-008, P-009, P-010



## Acceptance — the zero-Next scorecard

```
# No next/* imports anywhere in source (incl. app/** now that the shims are gone)
! rg -n "from ['\"]next(/|['\"])" --glob '!**/node_modules/**' --glob '!**/_retired/**' --glob '!**/.next*/**' apps/ libs/ packages/
# No next deps
! rg -n '"(next|next-themes|@bprogress/next|@nx/next)"\s*:' apps/operator/package.json package.json
# No Next config / shims
test ! -f apps/operator/next.config.js && test ! -f apps/operator/proxy.ts && test ! -d apps/operator-vite/shims
# Live stack still green
(cd apps/operator-vite && npm run build)   # clean
curl -sf http://127.0.0.1:3070/api/health                 # 200
curl -sf http://127.0.0.1:3070/internal/docs/agent-policies # 200
npm run test:affected                                      # green
```

(Excludes the `libs/papercusp/apps/web` dead Next app + `libs/papercup-shared/*View.tsx`, which live in submodules and are tracked as a separate retire/delete task — see D-002.)

## Coordination & risks

- **Shared `main` checkout.** Phase 1 touches `app/_components/*` and `operator-vite/src/__root.tsx`-adjacent files — the **`per-window-workspace-context`** stream is actively editing `__root.tsx` / `host-spa` / operator-vite. Declare intent + lock per-batch; sequence `_components/*` when that stream is quiet.
- **paperclip** rewrites `app/harness/*` autonomously — coordinate the `harness/*` batch (canonical §"Paperclip-pause policy").
- **No directory move** (that's the deferred (b) scope) — keeps blast radius bounded.
- **Rollback:** per-batch revert; shims/deps come out last, so until Phase 3 the SPA keeps building via the shims at every step.

## Decisions

(Recorded via plans:add-decision.)

### D-001 — Remove Next now; defer the directory-fold (split canonical Phase H)
Date: 2026-06-01
The canonical operator-vite-migration Phase H bundles (a) removing Next and (b) physically relocating apps/operator/{lib,bin,prompts,scripts,e2e,app→components} into apps/operator-vite/server/ and deleting apps/operator/ as a directory. These are separable. This plan does (a) only — rewrite the ~37 shimmed next/* sites + lib/require-flag.ts to TanStack/native, delete the shims, drop the next/@bprogress/next deps, remove dead Next files → zero Next in the repo. (b) is a large mechanical import-path sweep across hundreds of files + the Tauri/build/CI wiring on a shared multi-agent checkout: high churn, high collision risk, no user-visible benefit. It is OUT OF SCOPE here and, if pursued, becomes its own plan. Rationale: deliver the actual goal (no Next) sooner and far more safely by not coupling it to a cosmetic directory move.

### D-002 — Submodule dead Next apps/views are a separate retire/delete task
Date: 2026-06-01
Two Next-coupled dead surfaces live inside git submodules and are NOT on the critical path to repo-wide zero-Next of the live app: (1) libs/papercusp/apps/web — a full dead Next app (next.config.js, app/, route.ts), not in the workspace globs, no live importer; (2) libs/papercup-shared/src/*View.tsx (Timeline/HarnessConsole/PapercupTabs/Organization/Projects) — dead Next-coupled view components; live code imports only the /agent subpath + event helpers. Both are safe to retire/delete but the edits land in their respective submodules, so they are tracked separately from the apps/operator surface and excluded from this plan's acceptance scorecard. libs/marketplace-public-ui is LIVE (imported by operator-vite's marketplace route) and rides the shim — keep it; its next dep falls out when the shim/usePathname call is rewritten.

### D-003 — Done ahead of execution: build-cache deletion + doc corrections (deps deferred — lockfile constraint)
Date: 2026-06-01
Two zero-risk slices done out-of-band 2026-06-01 (commits 966d491c7 + the rm): (1) deleted apps/operator/.next + .next-prod (~1.14GB gitignored build caches — no git/lockfile/CI impact); (2) corrected the actively-false docs from P-012 — CLAUDE.md ("app/** is dead code" and "bin/dev/bin/prod are gone", both false) and the papercusp-su-engineer playbook (":3055 Next.js layer" → Vite SPA). The operator-docs MDX half of P-012 (build-system/*, tsc-baseline-vs-next-build, data-sync/pitfalls) is NOT done — it needs an Astro rebuild to take effect, so it stays with P-012.

DEP REMOVAL DEFERRED (refines the original Tier-0 offer): dropping @nx/next / next-themes from package.json is NOT safe-now after all. CI runs `npm ci --legacy-peer-deps` (strict — fails if package.json and package-lock.json disagree), the lockfile is currently clean, and local `npm install` is broken on this box (the workspace:* protocol issue). So removing deps without a working lockfile reconcile would break CI's npm ci. Dep removal therefore belongs in P-009 (Phase 3) done with a real install/lockfile reconcile, not as a standalone edit. Items P-009/P-010 remain not-started except the .next deletion; P-001..P-008, P-011 not started.

### D-004 — Rehome the shims as a shared module, not inline per-call-site (refines canonical §B5)
Date: 2026-06-01
Canonical §B5 said "delete the shim, rewrite consumers to TSR-native." Taken literally that would inline the adapter logic (refresh semantics, memoized search params, dynamic→lazy+Suspense) at ~37 call sites — duplicated, error-prone code. Since the usage is uniform and the shims are already correct TSR adapters, I instead PROMOTED them to a permanent shared module apps/operator/lib/router-compat/{navigation,link,dynamic}.tsx and repointed imports (next/navigation|link|dynamic → @/lib/router-compat/*; @bprogress/next[/app] → @bprogress/react). Zero call-site changes → lowest regression risk on core chrome. This still satisfies "remove Next": no next/* imports, no shims/, no vite aliases, next dep droppable. The remaining "Next-ness" is one local hook mimicking the useRouter shape — a thin wrapper, not a build/dep remnant. A future pass can inline to pure TSR idioms if desired. Done as one full sweep (not per-batch) since the Next operator is retired (only Vite consumes app/**), so in-place rewrite no longer risks a live Next build. Verified: operator-vite vite build exit 0.
