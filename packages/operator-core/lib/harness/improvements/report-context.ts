/**
 * report-context.ts — the captured context block a filed bug carries
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-010, D-001).
 *
 * Stored at `payload.reportContext` on a bug work item, beside the reporter
 * stamp (provenance.ts). It answers "what was the reporter looking at": the
 * app and the version THE REPORTER ran, the screen or URL state, recent errors,
 * a log excerpt and an optional screenshot reference.
 *
 * Why it is not the freshness envelope: `freshnessEnvelope` (createIssue)
 * records the operator runtime that PERSISTED the row. For an end-user report
 * from an installed desktop app, the reporter's own version can differ; this
 * block records the reporter side. For agent and watchdog filings the two agree,
 * and the builder fills the reporter side from the serving build.
 *
 * Bounded and redacted at the boundary: every string goes through the shared
 * `redactSensitiveText` and is cut to a fixed limit; a screenshot is stored only
 * as a reference, never inline bytes. Consent and on-device redaction for end
 * users (D-013) are the reporter door's job (P-014); P-013 adds the
 * untrusted-input rules. This module never rejects a filing — a malformed
 * field is dropped and named in `refused`.
 */

import { redactSensitiveText } from '../../sensitive-text';

export const REPORT_CONTEXT_SCHEMA_VERSION = 1 as const;

export const REPORT_CONTEXT_LIMITS = {
  app: 80,
  appVersion: 120,
  url: 2000,
  route: 300,
  stateKeys: 40,
  stateKey: 80,
  stateValue: 300,
  recentErrors: 10,
  errorMessage: 500,
  errorSource: 120,
  logExcerpt: 4000,
  screenshotRef: 300,
} as const;

export interface ReportContextError {
  at: string | null;
  source: string | null;
  message: string;
}

export interface ReportContextScreen {
  url: string | null;
  route: string | null;
  /** User-meaningful UI state (the nuqs URL params in Papercusp apps). */
  state: Record<string, string> | null;
}

export interface ReportContext {
  schemaVersion: typeof REPORT_CONTEXT_SCHEMA_VERSION;
  capturedAt: string;
  app: string;
  /** The version the REPORTER ran (see header). */
  appVersion: string | null;
  screen: ReportContextScreen | null;
  recentErrors: ReportContextError[];
  logExcerpt: string | null;
  screenshot: { ref: string } | null;
  /** Fields the builder filled itself rather than receiving from the reporter. */
  autoCaptured: string[];
  /** Fields cut to their bound. */
  truncated: string[];
  /** Fields dropped as malformed or disallowed (e.g. an inline screenshot). */
  refused: string[];
}

/** What a filing door may hand in. Every field is optional. */
export interface ReportContextInput {
  app?: unknown;
  appVersion?: unknown;
  screen?: unknown;
  recentErrors?: unknown;
  logExcerpt?: unknown;
  screenshot?: unknown;
}

/** The failing call a watchdog or agent captured, when there is one. */
export interface ReportContextFailure {
  toolName?: unknown;
  errorCode?: unknown;
  status?: unknown;
  message?: unknown;
}

function clean(v: unknown, limit: number, field: string, truncated: string[]): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = redactSensitiveText(v).trim();
  if (!trimmed) return null;
  if (trimmed.length > limit) {
    if (!truncated.includes(field)) truncated.push(field);
    return trimmed.slice(0, limit);
  }
  return trimmed;
}

function cleanScreen(v: unknown, truncated: string[], refused: string[]): ReportContextScreen | null {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    refused.push('screen');
    return null;
  }
  const s = v as Record<string, unknown>;
  const url = clean(s.url, REPORT_CONTEXT_LIMITS.url, 'screen.url', truncated);
  const route = clean(s.route, REPORT_CONTEXT_LIMITS.route, 'screen.route', truncated);
  let state: Record<string, string> | null = null;
  if (s.state && typeof s.state === 'object' && !Array.isArray(s.state)) {
    const entries = Object.entries(s.state as Record<string, unknown>);
    if (entries.length > REPORT_CONTEXT_LIMITS.stateKeys) truncated.push('screen.state');
    state = {};
    for (const [k, raw] of entries.slice(0, REPORT_CONTEXT_LIMITS.stateKeys)) {
      const key = clean(k, REPORT_CONTEXT_LIMITS.stateKey, 'screen.state', truncated);
      const value = clean(
        typeof raw === 'string' ? raw : raw == null ? null : JSON.stringify(raw),
        REPORT_CONTEXT_LIMITS.stateValue,
        'screen.state',
        truncated,
      );
      if (key && value != null) state[key] = value;
    }
    if (Object.keys(state).length === 0) state = null;
  } else if (s.state != null) {
    refused.push('screen.state');
  }
  if (!url && !route && !state) return null;
  return { url, route, state };
}

function cleanErrors(v: unknown, truncated: string[], refused: string[]): ReportContextError[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    refused.push('recentErrors');
    return [];
  }
  if (v.length > REPORT_CONTEXT_LIMITS.recentErrors) truncated.push('recentErrors');
  const out: ReportContextError[] = [];
  // The most RECENT errors are the useful ones: keep the tail.
  for (const raw of v.slice(-REPORT_CONTEXT_LIMITS.recentErrors)) {
    const e = typeof raw === 'string' ? { message: raw } : raw;
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const message = clean(r.message, REPORT_CONTEXT_LIMITS.errorMessage, 'recentErrors', truncated);
    if (!message) continue;
    out.push({
      at: typeof r.at === 'string' ? r.at : null,
      source: clean(r.source, REPORT_CONTEXT_LIMITS.errorSource, 'recentErrors', truncated),
      message,
    });
  }
  return out;
}

function failureAsError(failure: ReportContextFailure | null | undefined, at: string, truncated: string[]): ReportContextError | null {
  if (!failure) return null;
  const head = [failure.toolName, failure.errorCode ?? failure.status]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ');
  const body = typeof failure.message === 'string' ? failure.message : '';
  const message = clean([head, body].filter(Boolean).join(': '), REPORT_CONTEXT_LIMITS.errorMessage, 'recentErrors', truncated);
  if (!message) return null;
  const source = clean(failure.toolName, REPORT_CONTEXT_LIMITS.errorSource, 'recentErrors', truncated);
  return { at, source, message };
}

/**
 * Build the context block for a filing. Pure; never throws.
 *
 * `defaults` is the serving side (app + build) and fills whatever the reporter
 * did not send. `failure` is the captured failing call, used as the recent
 * error when the reporter sent none.
 */
export function buildReportContext(args: {
  input?: ReportContextInput | null;
  defaults: { app: string; appVersion: string | null };
  failure?: ReportContextFailure | null;
  capturedAt: string;
}): ReportContext {
  const truncated: string[] = [];
  const refused: string[] = [];
  const autoCaptured: string[] = [];
  const input = args.input && typeof args.input === 'object' ? args.input : {};

  let app = clean(input.app, REPORT_CONTEXT_LIMITS.app, 'app', truncated);
  if (!app) {
    app = args.defaults.app.slice(0, REPORT_CONTEXT_LIMITS.app);
    autoCaptured.push('app');
  }
  let appVersion = clean(input.appVersion, REPORT_CONTEXT_LIMITS.appVersion, 'appVersion', truncated);
  if (!appVersion && args.defaults.appVersion) {
    appVersion = args.defaults.appVersion.slice(0, REPORT_CONTEXT_LIMITS.appVersion);
    autoCaptured.push('appVersion');
  }

  const screen = cleanScreen(input.screen, truncated, refused);

  let recentErrors = cleanErrors(input.recentErrors, truncated, refused);
  if (recentErrors.length === 0) {
    const fromFailure = failureAsError(args.failure, args.capturedAt, truncated);
    if (fromFailure) {
      recentErrors = [fromFailure];
      autoCaptured.push('recentErrors');
    }
  }

  const logExcerpt = clean(input.logExcerpt, REPORT_CONTEXT_LIMITS.logExcerpt, 'logExcerpt', truncated);

  let screenshot: { ref: string } | null = null;
  if (input.screenshot != null) {
    const raw = input.screenshot;
    const ref = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as Record<string, unknown>).ref : null;
    // A reference only: inline image bytes would put an unbounded, unredactable
    // blob on the work item.
    if (typeof ref === 'string' && ref.trim() && !/^data:/i.test(ref.trim()) && ref.trim().length <= REPORT_CONTEXT_LIMITS.screenshotRef) {
      screenshot = { ref: ref.trim() };
    } else {
      refused.push('screenshot');
    }
  }

  return {
    schemaVersion: REPORT_CONTEXT_SCHEMA_VERSION,
    capturedAt: args.capturedAt,
    app,
    appVersion,
    screen,
    recentErrors,
    logExcerpt,
    screenshot,
    autoCaptured,
    truncated,
    refused,
  };
}
