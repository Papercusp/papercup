---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-cont60-rawtimer-guard.log"
updated_at: 1794255622680
_body: "content"
---

✗ NEW bare setInterval() call(s) outside the scheduled-registry:
  Use managedSetInterval(name, intervalMs, fn, { category }) from @papercusp/scheduled-registry
  so the timer is NAMED + visible in schedule:inventory (visibility != control —
  a watchdog still runs out-of-band; it just registers).

    packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts

  1 offender(s). See plan schedule-inventory-and-ephemeral-tier-2026-06-26 (P-007/P-008).

