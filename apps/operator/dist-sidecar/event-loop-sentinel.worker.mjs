// ../../packages/operator-core/lib/event-loop-sentinel.worker.ts
import { workerData, parentPort } from "node:worker_threads";
import { writeSync, readFileSync } from "node:fs";

// ../../packages/operator-core/lib/proc-thread-cpu.ts
var USER_HZ = 100;
function parseProcStat(raw) {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 13) return null;
  const state2 = rest[0];
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { state: state2, ticks: utime + stime };
}
var UNKNOWN = {
  kind: "unknown",
  cpuMs: null,
  cores: null,
  suspectWrongSubject: false
};
function classifyThreadCpu(opts) {
  const {
    baselineTicks,
    currentTicks,
    elapsedMs,
    userHz = USER_HZ,
    spinningCores = 0.5,
    parkedCores = 0.05
  } = opts;
  if (baselineTicks == null || currentTicks == null) return UNKNOWN;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return UNKNOWN;
  if (!(userHz > 0)) return UNKNOWN;
  const deltaTicks = currentTicks - baselineTicks;
  if (deltaTicks < 0) return UNKNOWN;
  const cpuMs = deltaTicks / userHz * 1e3;
  const cores = cpuMs / elapsedMs;
  const suspectWrongSubject = cores > 1.5;
  const kind = cores >= spinningCores ? "spinning" : cores <= parkedCores ? "parked" : "partial";
  return { kind, cpuMs, cores, suspectWrongSubject };
}

// ../../packages/operator-core/lib/event-loop-sentinel.ts
var SENTINEL_SAB_IDX = {
  HEARTBEAT: 0,
  LAG_P50_MS: 1,
  LAG_P95_MS: 2,
  LAG_P99_MS: 3,
  LAG_MAX_MS: 4
};
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
function lastKnownLag() {
  return {
    lastLagP50Ms: Atomics.load(view, SENTINEL_SAB_IDX.LAG_P50_MS),
    lastLagP95Ms: Atomics.load(view, SENTINEL_SAB_IDX.LAG_P95_MS),
    lastLagP99Ms: Atomics.load(view, SENTINEL_SAB_IDX.LAG_P99_MS),
    lastLagMaxMs: Atomics.load(view, SENTINEL_SAB_IDX.LAG_MAX_MS)
  };
}
function readMainThreadStat() {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/task/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}
function readMainThreadWchan() {
  try {
    const w = readFileSync(`/proc/${pid}/task/${pid}/wchan`, "utf8").trim();
    return w === "" || w === "0" ? null : w;
  } catch {
    return null;
  }
}
var healthyCpu = null;
function mainThreadActivity() {
  const now = readMainThreadStat();
  const verdict = classifyThreadCpu({
    baselineTicks: healthyCpu?.ticks ?? null,
    currentTicks: now?.ticks ?? null,
    elapsedMs: healthyCpu ? Date.now() - healthyCpu.atMs : 0
  });
  const out = {
    mainThreadActivity: verdict.kind,
    mainThreadState: now?.state ?? "unknown"
  };
  if (verdict.cpuMs != null) out.mainThreadCpuMsDuringStall = Math.round(verdict.cpuMs);
  if (verdict.cores != null) out.mainThreadCores = Number(verdict.cores.toFixed(2));
  if (verdict.suspectWrongSubject) out.suspectWrongSubject = true;
  const wchan = readMainThreadWchan();
  if (wchan) out.mainThreadWchan = wchan;
  return out;
}
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
    case "grace": {
      warnedThisStall = false;
      reportedThisStall = false;
      const healthy = readMainThreadStat();
      if (healthy) healthyCpu = { ticks: healthy.ticks, atMs: Date.now() };
      return;
    }
    case "warn":
      if (!warnedThisStall) {
        warnedThisStall = true;
        emit("main event loop STALLED (not yet actionable)", {
          stalenessMs: action.stalenessMs,
          wedgeAfterMs: thresholds.wedgeAfterMs,
          consecutiveStale: action.consecutiveStale,
          ...mainThreadActivity(),
          ...lastKnownLag()
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
          pid,
          ...lastKnownLag()
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
          reason: action.reason,
          ...mainThreadActivity(),
          ...lastKnownLag()
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
