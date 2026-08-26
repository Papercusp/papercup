# Cold-carry loop fires without waking the session, then parks ~22min

**Status:** NOT YET FILED — `improvements:capture` timed out twice against a degraded MCP
proxy (`mcp_proxy_overloaded`, 175 in flight vs admission max 136; infra-liveness was
reporting 54–61 hard tool-call failures/hr in the same window). File this when the proxy
recovers. Owner-directed.

**Owner framing (correct, and it overrode mine):** *"i dont care if it says it was fired. if
it didnt wake up it didnt work... the system is supposed to wake you up deterministically
when it fired, if it didn't thats a bug that needs to be fixed"* [owner:2026-08-26]

I first misattributed this to my own long turns and retracted that. Turn length explains an
earlier window; it does not explain this one.

## Observed — single `loop:status` read ~20:21Z. `carry:'cold'`, `intervalSec:60`, `active:true`

| field | value |
|---|---|
| `lastFiredAt` | 2026-08-26T20:18:32.920Z |
| `lastTurnAt` / `lastRealTurnAt` | 2026-08-26T20:11:10.758Z — never advanced past the fire |
| `lastWakeAt` | 2026-08-26T19:47:52.895Z — **30 minutes OLDER than the fire** |
| `lastDeliveryOutcome` | `loop-note-refresh` |
| `nextFireAt` | 2026-08-26T20:40:25.191Z — 21m52s after the fire, ~22× the 60s interval |
| health fields | `stalled:false turnsStalled:false cadenceDrift:false consecutiveErrors:0 parked:false` |
| counters | `firesSinceArm:1` vs `expectedFiresSinceArm:40`; `effectiveIntervalSec:1937` |

**Core fact:** the session was IDLE from 20:11:10. The loop fired at 20:18:32. No turn ran.
The owner had to prod manually. A fire that delivers no turn on an idle session is a LOST
iteration, not a slow one.

## Code path

`packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts:826-840`, the cold
branch of settle-detection. Its own comment at `:823-825` names the mode:

> A dead boot / dropped iteration produces NEITHER → the loop stays parked until the
> stuck-park backstop re-fires it, which re-delivers the SAME note — exactly the right retry.

For `carry:'cold'` a completion receipt is either a Stop-hook `ended` newer than the boundary
`started`, or a carry-note refresh with `note_updated_ts > last_fired` (`:832`). A dropped
iteration yields neither, so the loop parks. Lossless — but ~22 minutes of dead time on a
60-second loop.

## The worse half: observability

Through the entire dead window every health field read green. `cadenceDrift` is documented
(`agent-tools/loop/status.ts:36`) as staying false for a parked turn because *"the configured
interval begins after turn settlement"* — which is exactly the state a dropped delivery
induces. **The one field meant to flag slow cadence is structurally blind to this failure.**
I read my own status, concluded "healthy, I'm just slow", and reported that to the owner
before he corrected me. `lastDeliveryOutcome:'loop-note-refresh'` likewise reads as benign
housekeeping rather than "this fire produced no turn".

## NOT ESTABLISHED — candidates, not diagnosis

1. **Why the delivery produced no turn.**
   (a) The cold carry-respawn *quiet-pty window* race — this loop's own goal text records that
   the 60s cadence was chosen because it *"keeps winning the race against the carry-respawn's
   quiet-pty window"*, and that *"two compaction requests were acknowledged but never cut"*.
   So a known drop mode exists on this path.
   (b) Infra load — correlated only. Per the no-blaming-load rule this is not a cause until
   the mechanism is traced.
2. **Why `lastDeliveryOutcome` was `loop-note-refresh` at all.** On my reading of `:832`
   (`noteRefreshed` requires `note_updated_ts > last_fired`), my last checkpoint write (~20:07)
   *predates* the 20:18:32 fire and should NOT satisfy that test. If the outcome was derived
   from a PRE-fire note write, the detector may be crediting a stale receipt to a fire it never
   completed — a distinct and more serious defect than the latency one. **Check this first.**

## Direction

- Make a fire that yields no turn an **observable** state. An agent cannot self-recover from a
  failure its own health read calls healthy.
- Scale the stuck-park backstop to the configured interval; ~22min recovery on a 60s loop is a
  22× overshoot.
- Verify `:832` cannot credit a pre-fire note write to a post-fire iteration.
