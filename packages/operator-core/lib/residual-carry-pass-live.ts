/**
 * residual-carry-pass-live — the LIVE legs of P-019 (deterministic-context-carry-
 * 2026-07-14, Phase 6/7), deferred by D-010 to ride the Phase-7 cold-boot drills
 * (P-020): the reserved-maintenance-lane LLM call that fills the `ResidualLlmFn`
 * seam in {@link runResidualCarryPass}, and a small durable sample ledger so
 * per-class miss-rate evidence accumulates across real compaction boundaries
 * instead of living only in one process's memory.
 *
 * Mirrors cold-boot-drill-live.ts's split: the PURE scorer/prompt/parser cores
 * stay in residual-carry-pass.ts; this module is the impure edge — a real fetch
 * to the gateway, and a bounded JSONL ledger under the same PSU_PTY_DIR the P-020
 * drill ledger already uses (one durable-state directory, not a second one).
 *
 * Lands DEFAULT-OFF in the sense D-010 describes: nothing here runs on a timer.
 * A caller must explicitly build the llmFn and invoke the pass (or feed a
 * pre-computed sample to the ledger) — this module performs no ambient sampling.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GATEWAY_PORT } from './inference-gateway/launch';
import { PSU_PTY_DIR } from './events/await/psu-pty-discovery';
import {
  RESIDUAL_MAX_TOKENS,
  DEFAULT_MISS_RATE_PARAMS,
  scoreResidualMissRate,
  type MissRateSample,
  type MissRateReport,
  type ResidualLlmFn,
} from './residual-carry-pass';

const RESIDUAL_LEDGER_FILE = 'residual-carry-samples.events.jsonl';
const RESIDUAL_LEDGER_MAX_BYTES = 1024 * 1024;

/** Whole-call deadline for the reserved-lane request (loopback admission + upstream generation). */
export const RESIDUAL_LLM_TIMEOUT_MS = 30_000;

export interface MaintenanceResidualLlmOpts {
  /** Gateway base URL (default: loopback on the shared DEFAULT_GATEWAY_PORT). */
  baseUrl?: string;
  /** Test/alt seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Whole-call timeout; defaults to {@link RESIDUAL_LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Build the `ResidualLlmFn` the pure core calls: POSTs `{ prompt, maxTokens }` to
 * the gateway's already-live `/maintenance/summarize` reserved lane (P-002) — the
 * SAME endpoint P-017's deterministic-carry branch answers from when a
 * `carryOwner` query param is present. We deliberately never send `carryOwner`
 * here, so the request always falls through to the endpoint's real LLM branch
 * (a cheap hosted model, tier-1 admission, never the caller's own backend) and
 * returns `{ summary }` — the raw model text `runResidualCarryPass` parses as
 * strict JSON findings. Fail-soft is the CALLER's job (`runResidualCarryPass`
 * already treats an llmFn throw as `parseError`, never a throw of its own) — this
 * function is allowed to throw on a non-2xx or network failure.
 */
export function buildMaintenanceResidualLlmFn(opts: MaintenanceResidualLlmOpts = {}): ResidualLlmFn {
  const baseUrl = (opts.baseUrl ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? RESIDUAL_LLM_TIMEOUT_MS;
  return async (prompt: string, callOpts: { maxTokens: number; sessionClass: string }): Promise<string> => {
    const maxTokens = Math.min(Math.max(1, callOpts.maxTokens), RESIDUAL_MAX_TOKENS);
    const r = await fetchImpl(`${baseUrl}/maintenance/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`residual-carry-pass-live: maintenance/summarize failed (${r.status}): ${text.slice(0, 300)}`);
    }
    const j = (await r.json()) as { summary?: unknown; ok?: boolean };
    if (typeof j.summary !== 'string' || !j.summary) {
      throw new Error('residual-carry-pass-live: maintenance/summarize returned no summary text');
    }
    return j.summary;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable sample ledger — one bounded JSONL file, mirrors cold-boot-drill-live's
// pattern so P-019/P-020 evidence lives in the same directory convention.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResidualSampleLedgerEvent extends MissRateSample {
  ts: string;
  ownerId: string;
  /** Free-form provenance for where this boundary's stage-1/dropped-context came
   *  from (e.g. a drillId, a real self-compaction ownerId+ts, or a labeled smoke
   *  run) — never fed silently into the miss-rate corpus without one. */
  source: string;
  /** Findings, when the caller wants them preserved for a human audit later. */
  findingsCount?: number;
}

export function residualCarryLedgerPath(dir: string = PSU_PTY_DIR): string {
  return join(dir, RESIDUAL_LEDGER_FILE);
}

function parseJsonl<T>(body: string): T[] {
  const out: T[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row as T);
    } catch {
      // A concurrent writer mid-append can leave a partial final line; the next
      // read sees it once the append completes. Not a corruption.
    }
  }
  return out;
}

export async function readResidualCarryLedger(dir: string = PSU_PTY_DIR): Promise<ResidualSampleLedgerEvent[]> {
  try {
    return parseJsonl<ResidualSampleLedgerEvent>(await fs.readFile(residualCarryLedgerPath(dir), 'utf8'));
  } catch {
    return [];
  }
}

/** Bounded append — halves the file past ~1MB, same rule as the P-020 drill ledger. */
export async function appendResidualCarryLedgerEvent(
  event: ResidualSampleLedgerEvent,
  dir: string = PSU_PTY_DIR,
): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const path = residualCarryLedgerPath(dir);
    try {
      const stat = await fs.stat(path);
      if (stat.size > RESIDUAL_LEDGER_MAX_BYTES) {
        const body = await fs.readFile(path, 'utf8');
        await fs.writeFile(path, body.slice(Math.floor(body.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      // First append creates the file.
    }
    await fs.appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await fs.chmod(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Score every persisted sample by session class — the same aggregator P-022 will
 *  read from once a class clears the retirement gate. */
export async function reportResidualCarrySamples(
  readLedger: () => Promise<ResidualSampleLedgerEvent[]> = readResidualCarryLedger,
  params = DEFAULT_MISS_RATE_PARAMS,
): Promise<MissRateReport> {
  return scoreResidualMissRate(await readLedger(), params);
}
