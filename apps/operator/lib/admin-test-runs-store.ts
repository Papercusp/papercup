import {
  type AdminTestCheckResult,
  type AdminTestLogEntry,
  type AdminTestRunSnapshot,
  type AdminTestRunStatus,
  type AdminTestSuiteDone,
  type AdminTestSuiteId,
  type AdminTestSuiteProgress,
} from './admin-test-suites-shared';
import { runAdminTestSuites } from './admin-test-suites';

interface RunRecord {
  snapshot: AdminTestRunSnapshot;
  controller: AbortController;
  seq: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __papercuspAdminTestRuns: Map<string, RunRecord> | undefined;
}

const MAX_LOGS = 400;
const MAX_RUNS = 20;

function store(): Map<string, RunRecord> {
  if (!globalThis.__papercuspAdminTestRuns) {
    globalThis.__papercuspAdminTestRuns = new Map();
  }
  return globalThis.__papercuspAdminTestRuns;
}

function nextRunId(): string {
  return `testrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneSnapshot(snapshot: AdminTestRunSnapshot): AdminTestRunSnapshot {
  return structuredClone(snapshot);
}

function setRunStatus(record: RunRecord, status: AdminTestRunStatus, error: string | null = null): void {
  record.snapshot.status = status;
  record.snapshot.error = error;
  record.snapshot.finishedAt = Date.now();
}

function appendLog(record: RunRecord, suiteId: AdminTestSuiteId | 'system', level: 'info' | 'warn' | 'error', line: string): void {
  const entry: AdminTestLogEntry = {
    id: ++record.seq,
    suiteId,
    level,
    line,
    ts: Date.now(),
  };
  record.snapshot.logs.push(entry);
  if (record.snapshot.logs.length > MAX_LOGS) {
    record.snapshot.logs.splice(0, record.snapshot.logs.length - MAX_LOGS);
  }
}

function updateResult(record: RunRecord, result: AdminTestCheckResult): void {
  record.snapshot.results = record.snapshot.results.filter(
    (row) => !(row.suiteId === result.suiteId && row.id === result.id),
  );
  record.snapshot.results.push(result);
}

function updateProgress(record: RunRecord, progress: AdminTestSuiteProgress): void {
  record.snapshot.progressBySuite[progress.suiteId] = progress;
}

function finishSuite(record: RunRecord, done: AdminTestSuiteDone): void {
  record.snapshot.summaries[done.suiteId] = done;
  delete record.snapshot.progressBySuite[done.suiteId];
}

function trimStore(): void {
  const entries = Array.from(store().entries()).sort((a, b) => b[1].snapshot.startedAt - a[1].snapshot.startedAt);
  for (const [runId] of entries.slice(MAX_RUNS)) {
    store().delete(runId);
  }
}

export function startAdminTestRun(selection: AdminTestSuiteId | 'all-safe', returnHref: string | null = null): AdminTestRunSnapshot {
  const controller = new AbortController();
  const runId = nextRunId();
  const record: RunRecord = {
    controller,
    seq: 0,
    snapshot: {
      runId,
      selection,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      results: [],
      summaries: {},
      progressBySuite: {},
      logs: [],
    },
  };
  store().set(runId, record);
  trimStore();

  const restoreHref = returnHref ? withRunId(returnHref, runId) : null;

  void (async () => {
    try {
      await runAdminTestSuites(selection, {
        suite: (payload) => appendLog(record, payload.suiteId, 'info', `Started ${payload.label}`),
        progress: (payload) => updateProgress(record, payload),
        result: (payload) => updateResult(record, payload),
        done: (payload) => {
          finishSuite(record, payload);
          appendLog(record, payload.suiteId, payload.status === 'fail' ? 'error' : payload.status === 'warn' ? 'warn' : 'info', `${payload.label} finished ${payload.status} in ${(payload.durationMs / 1000).toFixed(1)}s`);
        },
        log: (payload) => appendLog(record, payload.suiteId, payload.level, payload.line),
      }, controller.signal, { returnHref: restoreHref });
      if (record.snapshot.status === 'running') setRunStatus(record, 'done');
    } catch (error) {
      if (controller.signal.aborted) {
        appendLog(record, 'system', 'warn', 'Run aborted by user.');
        setRunStatus(record, 'cancelled');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(record, 'system', 'error', message);
        setRunStatus(record, 'error', message);
      }
    }
  })();

  return cloneSnapshot(record.snapshot);
}

export function getAdminTestRunSnapshot(runId: string): AdminTestRunSnapshot | null {
  const record = store().get(runId);
  return record ? cloneSnapshot(record.snapshot) : null;
}

export function cancelAdminTestRun(runId: string): AdminTestRunSnapshot | null {
  const record = store().get(runId);
  if (!record) return null;
  if (record.snapshot.status === 'running') {
    record.controller.abort();
  }
  return cloneSnapshot(record.snapshot);
}

function withRunId(href: string, runId: string): string {
  const url = new URL(href);
  url.searchParams.set('run', runId);
  return url.toString();
}
