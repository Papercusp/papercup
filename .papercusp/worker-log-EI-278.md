# Worker log — EI-278 (auto-implement dispatch, run 1781528620-worker)

## Task
Auto-implement EI-278 (kind=bug): "Tauri webview RSS grows to the 16GB WebKit
kill threshold on a long-lived instance — OOM-killed after ~14h."

## Outcome: needs-human (re-confirmed; independently re-verified)

## What I did
Read-only audit + test run. **No code change** — there is no auto-implementable
inline fix remaining, and manufacturing a speculative leak fix without profiling
evidence would be a wrong auto-fix on the exact class this gate prevents.

### Independently re-verified the prior audit's claims (trust what runs, not comments)
1. **Storm fix shipped + wired + pinned.**
   - `apps/operator/providers/HarnessZeroProvider.tsx` passes `ssePollIntervalMs=180_000` into the SSE path.
   - `libs/generic/sync/src/transports/sse/SSEAdapter.tsx:254` defaults `SSE_DRIFT_REPAIR_DEFAULT_MS=180_000`.
   - `SSEAdapter.test.tsx` pins it into the 60-300s band with the EI-278 rationale.
2. **`observability/metrics.ts`** - integer counters, zero per-event allocation. (The 162k "misses" were a units artifact: every network fetch, not a growing buffer.)
3. **`transports/polling/queryClient.ts`** - `gcTime=60min` (NOT Infinity). Bounded working set.
4. **`bus-tap.ts`** - `Set` with proper unsubscribe; sole consumer `DesktopAttentionNotifier.tsx` returns the unsubscribe directly from its `useEffect`.
5. **`@papercusp/sse` `resilient-event-source.ts`** - closes the prior EventSource + clears all timers (reconnect/zombie/visibility) on every reconnect/setUrl/close, and removes the visibilitychange listener on close. No listener/timer leak.

### Tests run
`cd libs/generic/sync && npx vitest run` -> **15 files / 110 tests passed** (incl. the `SSEAdapter.test.tsx` EI-278 pin). The product-affecting fix holds.

### Why needs-human (not an inline fix)
- The product-affecting cause (the ~3.2 req/s SSE fetch storm -> 16GB-in-14h OOM) is **already fixed + shipped + pinned**. The issue author explicitly kept it open "pending the soak."
- No localized, regression-testable, unbounded-accumulation bug exists in the client sync path (all 5 candidates bounded).
- The soak's dominant residual accumulator (auto-opened WebKit inspector, `papercusp-desktop/src-tauri/src/main.rs` `#[cfg(debug_assertions)]`) is compiled out of release -> cannot affect the product; tracked under EI-180.
- Per su-0feaf's own magnitude analysis, the residual ~96MB/hr idle leak extrapolates to ~1.3GB over 14h - far short of 16GB; it required the now-fixed storm multiplier.
- Remaining work is NOT auto-implementable: (a) a multi-hour soak to confirm flat webview RSS (the explicit close criterion); (b) profiling discriminator runs to localize the sub-threshold residual before any fix can be pinned; (c) the deferred option-(a) cadence change (`refetchInterval:false` under healthy SSE) which depends on a bridge-coverage audit - larger + design-dependent.

### Why it re-appeared in the auto lane
The policy (`policy.ts:270` `classifyImprovement`) already routes `needsHuman:true` -> human tier. The prior worker set `needsHuman:true` at 12:57Z, but this dispatch's `lastDispatchAt` is 12:30Z - my dispatch raced (predated) the flag. Re-confirming needs-human keeps the flag set and closes this dispatch's ledger row.

## For the human / next agent
1. Run the soak (desktop on /adv several hours) to confirm webview RSS now stays flat -> then close EI-278.
2. If RSS still climbs with the storm gone, spin a scoped residual-leak issue off the discriminator-run plan su-0feaf outlined (samples were at /tmp/e2e-r2-soak.tsv).
3. The debug-only inspector accumulation belongs to EI-180.
