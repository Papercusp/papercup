# worker-log EI-278 (run 1781529442-worker, 2026-06-15)

**Outcome: needs-human** (3rd dispatch; matches prior workers ad494296 / 2135b1c3).

## What I did
Independent re-verification, no code change. Verified the load-bearing facts
against the LIVE code, not the issue comments:

- Storm fix present + wired: `apps/operator/providers/HarnessZeroProvider.tsx:49,58,71`
  passes `ssePollIntervalMs = 180_000` into the SSE path → `SSEAdapter.tsx:254,260`
  defaults `SSE_DRIFT_REPAIR_DEFAULT_MS = 180_000`.
- Pin test present: `SSEAdapter.test.tsx` clamps the const to the 60_000–300_000ms
  band with the EI-278 rationale.
- Option (a) (`refetchInterval:false` under healthy SSE) still deferred —
  `usePollingQuery.ts:59` `refetchInterval: interval` is unconditional; the
  root-cause comment marks the conditional-disable design-dependent on a
  bridge-coverage audit.

## Tests run
`npx vitest run` in `libs/generic/sync` → **110/110 green** (incl. the EI-278 pin
in SSEAdapter.test.tsx and usePollingQuery.test.tsx).

## Why needs-human (not fixed, not could-not-fix)
The product-affecting cause of the 16GB-in-14h webview OOM — the ~3.2 req/s SSE
fetch storm — is already fixed, shipped, wired, and pinned. There is no new
inline fix to make and no localized unbounded-accumulation bug left to pin with a
regression test (metrics = integer counters; queryClient gcTime=60min; bus-tap is
a Set with unsubscribe; resilient-event-source clears timers/closes ES on every
reconnect). The remaining work is NOT auto-implementable:
1. A multi-hour soak on a live desktop instance to confirm webview RSS stays flat
   (the issue author's explicit close criterion — "stays open pending the soak").
2. Profiling discriminator runs to localize the sub-threshold residual ~96MB/hr
   idle leak (su-0feaf) before any fix can be pinned — a speculative leak fix
   without profiling evidence would be a wrong auto-fix.
3. The deferred option-(a) cadence change pending a bridge-coverage audit
   (larger / design-dependent).
4. The debug-only auto-opened WebKit inspector (`src-tauri/src/main.rs`
   `#[cfg(debug_assertions)]`, compiled out of release) — tracked under EI-180.

## Validator re-verify
- Re-run `npx vitest run` in `libs/generic/sync` (expect 110/110).
- Recommend running the soak to confirm closure of the FILED magnitude bug; if
  webview RSS still climbs with the storm gone, spin a scoped residual-leak issue
  off su-0feaf's discriminator-run plan.
