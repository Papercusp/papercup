/**
 * Read the mcp-proxy's failure JSONL and summarise it for an AGENT
 * (plan outage-must-not-be-silent-2026-08-02, P-007 / D-004).
 *
 * ## Why this exists
 *
 * `apps/operator/lib/mcp-proxy/proxy.ts` has recorded every forwarded failure, retry and
 * recovery to `~/.papercusp/mcp-proxy-failures.jsonl` since W8 of
 * backend-reliability-100pct-2026-07-03. Its own header says the point is that
 * "a health collector / SLO can ingest" it.
 *
 * **Nothing ingests it.** The file is well-formed, 27MB, nine distinct record kinds — and no
 * agent has ever been shown a line of it. During the 2026-08-02 outage it held the single
 * highest-value artifact available (`:3070` recovering 7× in 20 minutes) and it took manual
 * `tail` + `jq` to find, hours in.
 *
 * That is D-004 in one file: the detection was already perfect, the delivery was absent. This
 * module is delivery only — it adds no new detection whatsoever.
 *
 * ## A `recovered` record is NOT good news
 *
 * The most important thing this summary does is refuse to let recoveries read as health.
 * WI-6740 documented the trap precisely: 269 handshake stalls between 2026-07-10 and
 * 2026-08-01, **every one followed by `recovered`**, which "reads as benign self-healing at
 * the watchdog's layer and is why this went unfixed for three weeks. The severity is
 * invisible to the layer that observes it."
 *
 * A recovery means a real fault occurred and was survived by retrying. A cluster of them is a
 * flapping upstream — the exact signature that preceded the outage. So `recoveries` is
 * surfaced as a FIRST-CLASS number, not folded into a total, and never as an "ok" signal.
 *
 * ## Bounded by construction
 *
 * The log is append-only, unrotated and already 27MB. Reading it whole would be slower than
 * the incident it describes and would blow any caller's memory budget, so this reads a
 * bounded TAIL (default 256KB ≈ the most recent few thousand records) and reports
 * `truncated` when it did not see the whole file. A diagnostic that itself becomes a
 * performance problem will be removed by the next person to notice it.
 */
import { readSync, openSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One record as the proxy writes it. Every field optional — this is forensic data, and a
 *  summariser that throws on an unexpected shape is useless exactly when it is needed. */
export interface ProxyFailureRecord {
  ts?: string;
  kind?: string;
  target?: string;
  status?: number;
  attempts?: number;
  elapsedMs?: number;
}

export interface ProxyFailureSummary {
  /** The window actually summarised. */
  windowMinutes: number;
  /** Records inside the window. */
  total: number;
  /** Count per `kind`, descending — the shape of what is going wrong. */
  byKind: Record<string, number>;
  /**
   * Faults that were SURVIVED by retrying. Deliberately first-class: a nonzero value means
   * the upstream is flapping, not that things are fine. See the header.
   */
  recoveries: number;
  /** Requests the proxy could NOT rescue — these reached the agent as errors. */
  exhausted: number;
  /** ISO timestamp of the newest record seen, if any. */
  newestTs?: string;
  /** True when only a tail of the file was read, so counts are a LOWER BOUND. */
  truncated: boolean;
  /** Present only when something is actually wrong — a one-line agent-facing read. */
  headline?: string;
}

/** Kinds that mean "a request finally failed", as opposed to "a request was rescued". */
const EXHAUSTED_KINDS = new Set(['exhausted_refused', 'upstream_error', 'upstream_non2xx']);
/** Kinds that mean "a fault happened and retrying saved it" — real faults, survived. */
const RECOVERY_KINDS = new Set([
  'recovered',
  'post_connect_retry',
  'handshake_timeout_retry',
]);

/**
 * Summarise already-read JSONL lines. PURE — no I/O, no clock — so the whole verdict is
 * unit-testable without a 27MB fixture.
 */
export function summarizeProxyFailureLines(
  lines: string[],
  opts: { nowMs: number; windowMinutes: number; truncated?: boolean },
): ProxyFailureSummary {
  const cutoff = opts.nowMs - opts.windowMinutes * 60_000;
  const byKind: Record<string, number> = {};
  let total = 0;
  let recoveries = 0;
  let exhausted = 0;
  let newestMs = -Infinity;
  let newestTs: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: ProxyFailureRecord;
    try {
      rec = JSON.parse(trimmed) as ProxyFailureRecord;
    } catch {
      continue; // a torn tail line is expected, never fatal
    }
    const ms = rec.ts ? Date.parse(rec.ts) : NaN;
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    total++;
    const kind = rec.kind || 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (RECOVERY_KINDS.has(kind)) recoveries++;
    if (EXHAUSTED_KINDS.has(kind)) exhausted++;
    if (ms > newestMs) {
      newestMs = ms;
      newestTs = rec.ts;
    }
  }

  const sorted: Record<string, number> = {};
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) sorted[k] = v;

  const summary: ProxyFailureSummary = {
    windowMinutes: opts.windowMinutes,
    total,
    byKind: sorted,
    recoveries,
    exhausted,
    truncated: opts.truncated ?? false,
  };
  if (newestTs) summary.newestTs = newestTs;

  // Only speak when there is something to say. A cheerful "0 problems" every call trains the
  // reader to skip the field, which is how the next real signal gets missed.
  if (recoveries > 0 || exhausted > 0) {
    const parts: string[] = [];
    if (recoveries > 0) {
      parts.push(
        `${recoveries} upstream fault(s) SURVIVED by retry in the last ${opts.windowMinutes}m — ` +
          `a recovery is a fault that happened, not a sign of health (WI-6740: 269 such stalls ` +
          `went unfixed for 3 weeks because every one was followed by "recovered")`,
      );
    }
    if (exhausted > 0) {
      parts.push(`${exhausted} request(s) the proxy could NOT rescue — these reached callers as errors`);
    }
    summary.headline = parts.join('; ');
  }
  return summary;
}

/** Where the proxy writes it — mirrors `failureLogPath()` in proxy.ts, same env override. */
export function proxyFailureLogPath(): string {
  return (
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG ||
    join(homedir(), '.papercusp', 'mcp-proxy-failures.jsonl')
  );
}

/**
 * Read a bounded TAIL of the failure log and summarise it. Never throws — a missing or
 * unreadable log yields an empty summary, because a diagnostic that fails loudly when the
 * thing it inspects is absent is just another outage.
 */
export function readRecentProxyFailures(opts?: {
  path?: string;
  windowMinutes?: number;
  maxBytes?: number;
  nowMs?: number;
}): ProxyFailureSummary {
  const windowMinutes = opts?.windowMinutes ?? 20;
  const maxBytes = opts?.maxBytes ?? 256 * 1024;
  const nowMs = opts?.nowMs ?? Date.now();
  const path = opts?.path ?? proxyFailureLogPath();

  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const readLen = Math.min(size, maxBytes);
    const start = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    readSync(fd, buf, 0, readLen, start);
    let text = buf.toString('utf8');
    // Drop the first line whenever we started mid-file: it is almost certainly partial, and a
    // half-record would parse as garbage or, worse, as a plausible wrong one.
    const truncated = start > 0;
    if (truncated) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return summarizeProxyFailureLines(text.split('\n'), { nowMs, windowMinutes, truncated });
  } catch {
    return {
      windowMinutes,
      total: 0,
      byKind: {},
      recoveries: 0,
      exhausted: 0,
      truncated: false,
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}
