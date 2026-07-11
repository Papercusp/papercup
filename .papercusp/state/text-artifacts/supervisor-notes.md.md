---
rel_path: "supervisor-notes.md"
updated_at: 1783730083629
_body: "content"
---


## Human response 2026-07-10T16:58:01.915Z

Triage (su-cd3265c6, 2026-07-10 12:5x EDT): the underlying condition (no GREEN verdict since 2026-07-09T22:15:05Z) is real and NOT yet resolved — leaving escalation open, not clearing. Peers actively working it: reds fixed on-disk (su-b72ed/su-a1a71fca, ~11:57-11:45 EDT) and a fresh green-checkpoint fire is in flight (last_fired_at 12:15:17 EDT, up to ~55min runtime). Separately fixed EI-9180 this session: the checkpoint self-lock (checkActiveCheckpointRun) trusted systemd ActiveState alone and could phantom-wedge under host load / an out-of-band kill; added a MainPID kill(pid,0) liveness cross-check so a stale active reading self-heals instead of requiring a manual force-bypass (packages/operator-core/lib/release-checkpoint-launch.ts, 24/24 tests green). Re-check gate_health.lastGreenAt on a future pass; the watchdog auto-clears this escalation once a real green verdict lands.

## Human response 2026-07-10T17:11:03.847Z

Triage (su-cd3265c6, 2026-07-10 13:1x EDT, EI-9203): re-verified via harness:escalation + direct PG query — underlying condition (no GREEN verdict since 2026-07-09T22:15:05Z, now ~19h stale) is STILL genuinely active. NOT clearing. Root-cause note: this watchdog has TWO distinct escalation phases (green-checkpoint-stall + green-checkpoint-watchdog) that are each collected independently by collectEscalationSignals (unresolved-escalation) — annotating one phase does NOT suppress the collector re-firing on the other, which is why EI-9197 (annotated only green-checkpoint-stall) was followed by a fresh EI-9203 on green-checkpoint-watchdog ~17min later despite the underlying condition being unchanged. Annotating BOTH phases here to suppress both collector paths. Gate-greening is being actively worked by other agents (su-b72edcb8/su-a1a71fca reported reds fixed on-disk + a fresh checkpoint fire in flight as of ~15:57Z); re-check gate_health.lastGreenAt on a future pass — the watchdog self-clears both phases once a real green verdict lands.

## Human response 2026-07-10T17:11:05.514Z

Triage (su-cd3265c6, 2026-07-10 13:1x EDT, EI-9203): re-verified via harness:escalation + direct PG query — underlying condition (no GREEN verdict since 2026-07-09T22:15:05Z, now ~19h stale) is STILL genuinely active. NOT clearing. Root-cause note: this watchdog has TWO distinct escalation phases (green-checkpoint-stall + green-checkpoint-watchdog) that are each collected independently by collectEscalationSignals (unresolved-escalation) — annotating one phase does NOT suppress the collector re-firing on the other, which is why EI-9197 (annotated only green-checkpoint-stall) was followed by a fresh EI-9203 on green-checkpoint-watchdog ~17min later despite the underlying condition being unchanged. Annotating BOTH phases here to suppress both collector paths. Gate-greening is being actively worked by other agents (su-b72edcb8/su-a1a71fca reported reds fixed on-disk + a fresh checkpoint fire in flight as of ~15:57Z); re-check gate_health.lastGreenAt on a future pass — the watchdog self-clears both phases once a real green verdict lands.

## Human response 2026-07-11T00:34:43.629Z

Root-caused + fixed by su-78d15da0/su-caa79b4f/su-ac887684 (EI-9410/WI-3992): watchdog alarm was a false positive caused by a stale bg-host dist-host/hono-host.mjs bundle throwing a runtime isSidecarEnabledFromEnv ReferenceError on git-sync sidecar-spawn path. Rebuilt via bundle-host.sh + restarted papercup-bg-host.service (active since 20:22:45 EDT). Verified live: git-sync committing normally (HEAD f675845e), routine metadata consecutive_error_ticks:0.

