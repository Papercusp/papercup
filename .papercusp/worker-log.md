# Worker log — EI-188 "Service web is down"

## Diagnosis
The improvement watchdog's `service-down` collector probes `HEALTH_ENDPOINTS`
(`packages/operator-core/lib/service-health.ts`). That list included
`{ name: 'web', url: 'http://127.0.0.1:3001/' }` — the **retired** "old Restart
web app" (confirmed by `docker-compose.papercup.prod.yml` ("the old Restart web
app, which doesn't exist in this container") and `_retired/papercup`). There is
no `apps/web` in the live tree; the standalone web app never runs in this
deployment. So every probe found `web` DOWN, and the watchdog re-captured a
phantom "Service web is down" improvement each cycle (EI-188).

## Fix (self/inline-sized, non-protected surface)
Removed the retired `web` (:3001) endpoint from `HEALTH_ENDPOINTS` and added a
comment warning not to re-add a retired surface. No behavior change for live
services. The dev `service_health` tool reads the same list, so it also stops
reporting the phantom.

Scope note: `service-down:shop` (:4321) is a *separate* open watchdog item with
the same root cause (no `apps/shop` in the tree) — intentionally left for its
own runner per the one-item-per-run boundary, NOT fixed here.

## Files changed
- `packages/operator-core/lib/service-health.ts` — drop `web` from `HEALTH_ENDPOINTS` + comment.
- `packages/operator-core/lib/service-health.test.ts` — regression test: `HEALTH_ENDPOINTS` must not monitor `web`/`:3001`.

## Verification
- `npx vitest run lib/service-health.test.ts` → 7 passed (was 6). New test
  confirmed RED before the fix (stash-tested), GREEN after.
- `npx vitest run lib/harness/improvements/watchdog.test.ts` → 87 passed (nothing
  depended on `web` being probed).

## For the validator to re-verify
- The retired `web`/:3001 endpoint stays out of `HEALTH_ENDPOINTS`.
- Consider a follow-up for the sibling `service-down:shop` phantom (:4321).
