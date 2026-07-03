/**
 * system-health/mcp-proxy-health — read the resilient MCP proxy's failure ledger and
 * summarize the recent windowed failure counts for the Infra health panel
 * (backend-reliability-100pct-2026-07-03 W8 / P-008).
 *
 * WHY (the under-counting this closes): a connection-level MCP failure — a stale-socket
 * 400 (W1.3), a deploy-window refusal, a post-connect upstream error — NEVER creates a
 * `tool_invocations` row (it errors at the HTTP layer, BELOW tool dispatch). So the
 * agent-facing failure rate was invisible and "transient errors calling tools" felt
 * normal. The proxy now appends each such failure as a JSONL record
 * (apps/operator/lib/mcp-proxy/proxy.ts `recordProxyFailure`); THIS module reads them
 * back and turns them into a first-class SLO signal on the Infra panel: any sustained
 * HARD-failure count reds Infra → operator_degraded → the overall system light, so a
 * regression PAGES instead of being dismissed as "transient". (The status boundary lives
 * with the other SLOs in ./thresholds.ts — `infraStatus` + `MCP_PROXY_HARD_FAIL_CRIT`.)
 *
 * BOUNDED + fail-soft (perf + correctness floor):
 *  - the reader reads only the TAIL of the ledger (last READ_CAP_BYTES) via a positioned
 *    read, so a ledger that grows under a sustained regression never makes the health
 *    tick read an unbounded file (perf anti-pattern A-list: no full-file slurp);
 *  - an ABSENT ledger = no failures recorded yet = a healthy zero (`[]`), NOT an error;
 *  - a read/parse error yields `null` ⇒ the Infra panel greys THIS leg (never blanks);
 *  - the summarizer is PURE (no fs) so the window/classification logic unit-tests hermetically.
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpProxyHealth } from './types';

/** The ledger path — MUST match apps/operator/lib/mcp-proxy/proxy.ts `failureLogPath()`.
 *  Resolved per-call (not cached) so the env override is honoured at runtime + in tests. */
export function mcpProxyFailureLogPath(): string {
  return process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG || join(homedir(), '.papercusp', 'mcp-proxy-failures.jsonl');
}

/** Tail bytes read from the ledger — bounded regardless of total file size. 256KB holds
 *  far more than a 1h window's worth of records at any rate that isn't already a loud
 *  crit (a sustained >256KB/h failure stream reds the panel long before the tail clips). */
export const MCP_PROXY_READ_CAP_BYTES = 256 * 1024;

/** The default SLO lookback window (1h) — mirrors the dashboard's "this window". */
export const MCP_PROXY_WINDOW_MS = 60 * 60_000;

/** One parsed failure record (a superset of what `recordProxyFailure` writes). */
export interface McpProxyFailureRecord {
  ts: string;
  kind: string;
  status?: number;
  attempts?: number;
  connection?: string | null;
  method?: string;
  path?: string;
  elapsedMs?: number;
}

/**
 * Read the TAIL of the JSONL ledger and return the parsed records (best-effort). A partial
 * leading line (the tail may start mid-record) is skipped; a malformed line is skipped.
 * Returns `[]` when the ledger is absent/empty (a healthy zero) and `null` on a genuine
 * read error (⇒ the collector greys the leg, fail-soft). Synchronous + bounded: at most
 * one statSync + one positioned readSync of ≤ capBytes — negligible on the health tick.
 */
export function readMcpProxyFailureTail(
  path: string = mcpProxyFailureLogPath(),
  capBytes: number = MCP_PROXY_READ_CAP_BYTES,
): McpProxyFailureRecord[] | null {
  let fd: number | undefined;
  try {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return []; // absent ledger ⇒ nothing has failed yet ⇒ healthy zero (not an error)
    }
    if (size === 0) return [];
    const start = Math.max(0, size - capBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // The tail likely begins mid-line — drop everything up to the first newline so we
      // only parse whole records.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const out: McpProxyFailureRecord[] = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s) as McpProxyFailureRecord;
        if (rec && typeof rec.ts === 'string' && typeof rec.kind === 'string') out.push(rec);
      } catch {
        /* skip a malformed / truncated line */
      }
    }
    return out;
  } catch {
    return null; // genuine read error ⇒ grey the leg (fail-soft)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** True when a forwarded non-2xx bears the W1.3 stale-socket-400 signature: HTTP 400 with
 *  `connection: close`. That is the exact shape :3070 returns when a forward lands on a
 *  half-closed pooled keep-alive socket — the ~13% bug P-010 fixed. Surfaced as a HARD
 *  failure so any regression of that class is instantly visible, never silently transient. */
export function isStaleSocket400(rec: Pick<McpProxyFailureRecord, 'status' | 'connection'>): boolean {
  return (
    rec.status === 400 &&
    typeof rec.connection === 'string' &&
    rec.connection.toLowerCase().includes('close')
  );
}

/**
 * PURE: fold failure records into the windowed {@link McpProxyHealth} summary.
 *
 * Classification:
 *  - `recovered`                         → SOFT (proxy retried a refused upstream and
 *                                          succeeded; the agent saw success) → `recovered`.
 *  - `exhausted_refused` | `upstream_error` → HARD (the call terminally failed: 503 after
 *                                          the retry window, or a 502 post-connect error).
 *  - `upstream_non2xx` + stale-socket-400 signature → HARD (W1.3 regression).
 *  - `upstream_non2xx` otherwise         → `otherNon2xx` (a genuine upstream 4xx/5xx).
 *
 * Records outside `[now - windowMs, now + skew]` are ignored (a small future-skew guard
 * tolerates minor clock differences without admitting far-future garbage).
 */
export function summarizeMcpProxyHealth(
  records: readonly McpProxyFailureRecord[],
  nowMs: number,
  windowMs: number = MCP_PROXY_WINDOW_MS,
): McpProxyHealth {
  const SKEW_MS = 60_000;
  const byKind: Record<string, number> = {};
  let total = 0;
  let hardFailures = 0;
  let recovered = 0;
  let otherNon2xx = 0;
  let newestAt: number | null = null;
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) continue;
    if (t < nowMs - windowMs || t > nowMs + SKEW_MS) continue;
    total += 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (newestAt === null || t > newestAt) newestAt = t;
    if (r.kind === 'recovered') {
      recovered += 1;
    } else if (r.kind === 'exhausted_refused' || r.kind === 'upstream_error') {
      hardFailures += 1;
    } else if (r.kind === 'upstream_non2xx') {
      if (isStaleSocket400(r)) hardFailures += 1;
      else otherNon2xx += 1;
    }
  }
  return { windowMs, total, hardFailures, recovered, otherNon2xx, byKind, newestAt };
}
