// ../../packages/operator-core/lib/event-loop-sentinel.worker.ts
import { workerData, parentPort } from "node:worker_threads";
import { writeSync } from "node:fs";

// ../../packages/operator-core/lib/event-loop-sentinel.ts
function initialLoopSentinelState(nowMs, counter) {
  return {
    lastCounter: counter,
    lastChangeAtMs: nowMs,
    consecutiveStale: 0,
    startedAtMs: nowMs,
    sawHeartbeat: false
  };
}
var resolveWarnAfterMs = (t) => t.warnAfterMs ?? Math.floor(t.wedgeAfterMs / 2);
function decideLoopSentinelAction(state2, obs, thresholds2) {
  if (obs.counter !== state2.lastCounter) {
    return {
      state: {
        ...state2,
        lastCounter: obs.counter,
        lastChangeAtMs: obs.nowMs,
        consecutiveStale: 0,
        sawHeartbeat: true
      },
      action: { kind: "ok", stalenessMs: 0 }
    };
  }
  const stalenessMs = Math.max(0, obs.nowMs - state2.lastChangeAtMs);
  if (obs.nowMs - state2.startedAtMs < thresholds2.startupGraceMs) {
    return { state: state2, action: { kind: "grace", stalenessMs } };
  }
  if (stalenessMs < thresholds2.wedgeAfterMs) {
    const next2 = { ...state2, consecutiveStale: 0 };
    return stalenessMs >= resolveWarnAfterMs(thresholds2) ? { state: next2, action: { kind: "warn", stalenessMs, consecutiveStale: 0 } } : { state: next2, action: { kind: "ok", stalenessMs } };
  }
  const consecutiveStale = state2.consecutiveStale + 1;
  const next = { ...state2, consecutiveStale };
  if (consecutiveStale < thresholds2.observationsToAct) {
    return { state: next, action: { kind: "warn", stalenessMs, consecutiveStale } };
  }
  if (!state2.sawHeartbeat) {
    return {
      state: next,
      action: { kind: "escalate-never-started", stalenessMs, consecutiveStale }
    };
  }
  return {
    state: next,
    action: {
      kind: "kill",
      stalenessMs,
      consecutiveStale,
      reason: `event loop blocked ${stalenessMs}ms (>= ${thresholds2.wedgeAfterMs}ms) across ${consecutiveStale} consecutive observations after a confirmed heartbeat`
    }
  };
}

// ../../packages/operator-core/lib/event-loop-sentinel.worker.ts
function emit(line, detail) {
  try {
    const fields = Object.entries(detail).map(([k, v]) => `${k}: ${typeof v === "string" ? v : String(v)}`).join(", ");
    writeSync(2, `[event-loop-sentinel] ${line} { ${fields} }
`);
  } catch {
  }
}
var data = workerData;
var view = new Int32Array(data.sab);
var { thresholds, observeIntervalMs, mode, pid } = data;
var state = initialLoopSentinelState(
  Date.now(),
  Atomics.load(view, 0)
);
var warnedThisStall = false;
var reportedThisStall = false;
var acted = false;
var timer = setInterval(() => {
  if (acted) return;
  let decision;
  try {
    decision = decideLoopSentinelAction(
      state,
      { counter: Atomics.load(view, 0), nowMs: Date.now() },
      thresholds
    );
  } catch (err) {
    emit("decider threw \u2014 sentinel disabling itself (host unaffected)", {
      error: String(err).slice(0, 200)
    });
    acted = true;
    clearInterval(timer);
    return;
  }
  state = decision.state;
  const action = decision.action;
  switch (action.kind) {
    case "ok":
    case "grace":
      warnedThisStall = false;
      reportedThisStall = false;
      return;
    case "warn":
      if (!warnedThisStall) {
        warnedThisStall = true;
        emit("main event loop STALLED (not yet actionable)", {
          stalenessMs: action.stalenessMs,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          consecutiveStale: action.consecutiveStale
        });
      }
      return;
    case "escalate-never-started":
      acted = true;
      clearInterval(timer);
      emit(
        "heartbeat NEVER observed \u2014 NOT killing. Either the loop wedged before the sentinel started, or the heartbeat was never armed; these are indistinguishable from here. Check dev:service_health for an accept-queue wedge.",
        {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          pid
        }
      );
      return;
    case "kill": {
      if (mode === "kill") {
        acted = true;
        clearInterval(timer);
      } else {
        if (reportedThisStall) return;
        reportedThisStall = true;
      }
      emit(
        mode === "kill" ? "main event loop WEDGED \u2014 SIGKILLing the host (systemd will restart it)" : "main event loop WEDGED \u2014 observe mode, NOT killing",
        {
          stalenessMs: action.stalenessMs,
          consecutiveStale: action.consecutiveStale,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          mode,
          pid,
          reason: action.reason
        }
      );
      if (mode === "kill") {
        try {
          process.kill(pid, "SIGKILL");
        } catch (err) {
          emit("SIGKILL failed \u2014 host left running", {
            error: String(err).slice(0, 200),
            pid
          });
        }
      }
      return;
    }
  }
}, observeIntervalMs);
parentPort?.postMessage({ kind: "ready" });
