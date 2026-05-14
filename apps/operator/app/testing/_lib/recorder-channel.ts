/**
 * BroadcastChannel protocol shared between the /testing page (controller)
 * and the recorder window (the tab opened with ?perf-recorder=1 that
 * actually runs Gremlins + collects metrics).
 */

export const CHANNEL_NAME = 'papercusp-perf-recorder';

export type ControllerMsg =
  | { type: 'start'; runId: string; durationMs: number; blocklist: string[]; dryRun: boolean }
  | { type: 'stop'; runId: string };

export type RecorderMsg =
  | { type: 'ready'; runId: string }
  | { type: 'started'; runId: string }
  | { type: 'progress'; runId: string; clicks: number; elapsedMs: number }
  | { type: 'event'; runId: string; event: RecorderEvent }
  | { type: 'done'; runId: string; summary: RunSummary };

export interface RecorderEvent {
  ts: number;
  route: string;
  kind: 'click' | 'long-task' | 'console-error' | 'layout-shift' | 'unhandled-error';
  target: string;
  inp?: number;
  duration?: number;
  detail?: string;
}

export interface RunSummary {
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  clicks: number;
  events: RecorderEvent[];
  /** route → { count, p50inp, p95inp, maxInp, errors } */
  routes: Record<string, RouteRollup>;
}

export interface RouteRollup {
  route: string;
  clicks: number;
  p50inp: number;
  p95inp: number;
  maxInp: number;
  errors: number;
}

const LS_RUNS_KEY = 'papercusp.testing.chaos-runs.v1';
const MAX_RUNS = 10;

export function saveRun(run: RunSummary): RunSummary[] {
  try {
    const raw = localStorage.getItem(LS_RUNS_KEY);
    const runs = raw ? (JSON.parse(raw) as RunSummary[]) : [];
    runs.unshift(run);
    const trimmed = runs.slice(0, MAX_RUNS);
    localStorage.setItem(LS_RUNS_KEY, JSON.stringify(trimmed));
    return trimmed;
  } catch {
    return [run];
  }
}

export function loadRuns(): RunSummary[] {
  try {
    const raw = localStorage.getItem(LS_RUNS_KEY);
    return raw ? (JSON.parse(raw) as RunSummary[]) : [];
  } catch {
    return [];
  }
}

export function clearRuns(): void {
  try { localStorage.removeItem(LS_RUNS_KEY); } catch { /* noop */ }
}

export function rollupRoutes(events: RecorderEvent[]): Record<string, RouteRollup> {
  const byRoute: Record<string, RecorderEvent[]> = {};
  for (const e of events) {
    (byRoute[e.route] ??= []).push(e);
  }
  const out: Record<string, RouteRollup> = {};
  for (const [route, evs] of Object.entries(byRoute)) {
    const inps = evs.filter((e) => e.kind === 'click' && typeof e.inp === 'number').map((e) => e.inp!).sort((a, b) => a - b);
    const errors = evs.filter((e) => e.kind === 'console-error' || e.kind === 'unhandled-error').length;
    out[route] = {
      route,
      clicks: evs.filter((e) => e.kind === 'click').length,
      p50inp: inps.length ? inps[Math.floor(inps.length * 0.5)] : 0,
      p95inp: inps.length ? inps[Math.floor(inps.length * 0.95)] : 0,
      maxInp: inps.length ? inps[inps.length - 1] : 0,
      errors,
    };
  }
  return out;
}
