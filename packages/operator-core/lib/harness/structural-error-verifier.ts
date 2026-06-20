/**
 * structural-error-verifier — the INVERSE of completion-ref-verifier (EI-1747).
 *
 * `completion-ref-verifier` confirms a DONE feature's fix-commit is PRESENT on the
 * remote (git ls-remote). THIS confirms an OPEN watchdog structural-error EI's error
 * signature is ABSENT from the deployed operator's live telemetry — so an
 * already-fixed-but-open item AUTO-RESOLVES instead of rotting. Watchdog-filed
 * structural-error EIs carry no `completion_ref`, so the completion-ref daemon never
 * touches them; they accumulate and agents burn cycles re-investigating landed fixes
 * (F-FIX-033/034/035 were all already-fixed-but-open; verifying WI-214 / F-FIX-034
 * cost real time this session). Together the two daemons close both ends of the fix
 * lifecycle: presence-on-remote (done items) ↔ absence-on-deployed (open items).
 *
 * WHY telemetry-absence == deployed-fix: `harness_shared.tool_invocations` is LIVE
 * telemetry of the RUNNING (deployed) operator. "Zero error-status invocations of this
 * tool in the trailing window" == the deployed code stopped emitting the error == the
 * fix shipped. A window-based absence check therefore inherently reads DEPLOYED state
 * (no deploy-sha resolution needed) and correctly keeps an item open until its fix
 * actually ships (an item whose fix is only on staging keeps erroring on :3070, so it
 * stays open until the deploy promotes).
 *
 * Design (su-dfe5e + su-fa300, EI-1747): a PLAIN, shed-aware `setInterval` — deliberately
 * NOT a DBOS scheduled workflow (EI-1622 workflow_status bloat) and NOT a routine-engine
 * action (wedge-prone). The decision is a pure function; all I/O is an injected seam so
 * the orchestration is unit-testable without PG or a clock.
 */
import { getOrgPg } from '@papercusp/db-org';
import { parseRepeatedToolErrorKey } from './improvements/watchdog-key-migration';

/**
 * The conservative auto-resolve decision (PURE). Resolve ONLY when the error has not
 * recurred within the window AND the item is itself older than the window — so a young
 * item that simply has not had time to recur is never closed, and a transient telemetry
 * gap on a fresh item cannot false-positive into a premature resolve. Erring toward
 * keeping-open is correct: a re-open is cheap, a wrongly-closed real bug is not.
 */
export function decideStructuralAutoResolve(input: {
  recentRecurrences: number;
  itemAgeMs: number;
  windowMs: number;
}): boolean {
  return input.recentRecurrences === 0 && input.itemAgeMs >= input.windowMs;
}

/** A selected OPEN structural-error item, with its tool parsed out of the watchdogKey. */
export interface OpenStructuralItem {
  workspaceId: string;
  issueId: string;
  /** the offending tool, parsed from `repeated-tool-error:<tool>:structural`. */
  tool: string;
  watchdogKey: string;
  ageMs: number;
}

/** Injected I/O seam — concrete PG impl in `makePgStructuralVerifierDeps`; fakes in tests. */
export interface StructuralVerifierDeps {
  selectOpenStructuralItems(): Promise<OpenStructuralItem[]>;
  /** count error/timeout-status `tool_invocations` for `tool` in `workspaceId` over the trailing windowMs. */
  countRecentToolErrors(tool: string, workspaceId: string, windowMs: number): Promise<number>;
  resolveItem(workspaceId: string, issueId: string, note: string): Promise<void>;
}

export interface StructuralVerifierOptions {
  /** quiet window: error-absence for ≥ this long (and item older than this) ⇒ resolve. Default 6h. */
  windowMs?: number;
  /** safety cap on items processed per tick. Default 50. */
  maxPerTick?: number;
}

const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_MAX_PER_TICK = 50;

/**
 * One verification pass: select OPEN structural items → for each, count recent error
 * recurrences of its tool → decide → resolve the quiet+old ones (else leave open).
 * Pure over its injected deps (no PG, no wall-clock) — fully unit-testable. A single
 * item's failure (count/resolve throw) is swallowed so one bad row never aborts the pass.
 */
export async function runStructuralErrorVerifierOnce(
  deps: StructuralVerifierDeps,
  opts: StructuralVerifierOptions = {},
): Promise<{ checked: number; resolved: number; kept: number; errored: number }> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const items = (await deps.selectOpenStructuralItems()).slice(0, maxPerTick);
  let resolved = 0;
  let kept = 0;
  let errored = 0;
  for (const item of items) {
    try {
      const recentRecurrences = await deps.countRecentToolErrors(item.tool, item.workspaceId, windowMs);
      if (decideStructuralAutoResolve({ recentRecurrences, itemAgeMs: item.ageMs, windowMs })) {
        const hrs = Math.round(windowMs / 3_600_000);
        await deps.resolveItem(
          item.workspaceId,
          item.issueId,
          `auto-resolved (EI-1747 structural-error verifier): \`${item.tool}\` has emitted no error in the deployed operator's telemetry for ≥${hrs}h, so the structural error is fixed on the deployed sha. Reopens automatically if the watchdog re-files on recurrence.`,
        );
        resolved++;
      } else {
        kept++;
      }
    } catch {
      // best-effort cleanup — one bad row must never abort the pass.
      errored++;
    }
  }
  return { checked: items.length, resolved, kept, errored };
}

/** Concrete Postgres-backed deps. */
export function makePgStructuralVerifierDeps(
  getPg: typeof getOrgPg = getOrgPg,
  now: () => number = Date.now,
): StructuralVerifierDeps {
  return {
    async selectOpenStructuralItems(): Promise<OpenStructuralItem[]> {
      const { sql } = getPg();
      const rows = await sql<{ workspace_id: string; issue_id: string; watchdog_key: string; created_ms: string }[]>`
        SELECT workspace_id,
               issue_id,
               payload->>'watchdogKey' AS watchdog_key,
               (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_ms
        FROM harness_shared.engineer_issues
        WHERE state = 'open'
          AND payload->>'watchdogKey' LIKE 'repeated-tool-error:%:structural'
        ORDER BY created_at ASC
        LIMIT 200
      `;
      const out: OpenStructuralItem[] = [];
      for (const r of rows) {
        const parsed = parseRepeatedToolErrorKey(r.watchdog_key);
        // Only structural-class keys with a parseable tool. (The LIKE is a coarse
        // pre-filter; the parser is the authority — a fingerprinted key ending in a
        // segment containing 'structural' still parses its class correctly.)
        if (!parsed || parsed.klass !== 'structural') continue;
        out.push({
          workspaceId: r.workspace_id,
          issueId: r.issue_id,
          tool: parsed.tool,
          watchdogKey: r.watchdog_key,
          ageMs: now() - Number(r.created_ms),
        });
      }
      return out;
    },

    async countRecentToolErrors(tool: string, workspaceId: string, windowMs: number): Promise<number> {
      const { sql } = getPg();
      const sinceIso = new Date(now() - windowMs).toISOString();
      const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
        FROM harness_shared.tool_invocations
        WHERE tool_name = ${tool}
          AND workspace_id = ${workspaceId}
          AND status IN ('error', 'timeout')
          AND invoked_at > ${sinceIso}
      `;
      return Number(rows[0]?.n ?? 0);
    },

    async resolveItem(workspaceId: string, issueId: string, note: string): Promise<void> {
      const { sql } = getPg();
      // Primary lifecycle = the top-level `state` column (what improvements:digest /
      // issues:list read). Also reflect into payload.ideaLifecycle.state when present, so
      // the lifecycle projection stays consistent. Append the note to `body` for audit.
      // Guarded `state = 'open'` so a concurrent manual resolve never double-writes.
      await sql`
        UPDATE harness_shared.engineer_issues
        SET state = 'resolved',
            body = body || ${'\n\n' + note},
            payload = CASE
              WHEN payload ? 'ideaLifecycle'
                THEN jsonb_set(payload, '{ideaLifecycle,state}', '"resolved"'::jsonb)
              ELSE payload
            END,
            updated_at = NOW()
        WHERE workspace_id = ${workspaceId} AND issue_id = ${issueId} AND state = 'open'
      `;
    },
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the shed-aware periodic verifier. Idempotent (a second call is a no-op while one
 * is running). The tick is best-effort cleanup: it is SKIPPED while the host is shedding
 * load, and a tick failure is swallowed (the next tick retries). The timer is `unref`'d
 * so it never holds the process open.
 */
export function startStructuralErrorVerifier(
  opts: {
    intervalMs?: number;
    windowMs?: number;
    isShedding?: () => boolean;
    deps?: StructuralVerifierDeps;
    log?: (msg: string) => void;
  } = {},
): { stop: () => void } {
  if (timer) return { stop: stopStructuralErrorVerifier };
  const intervalMs = opts.intervalMs ?? 30 * 60 * 1000; // every 30m — slow, low-stakes cleanup
  const deps = opts.deps ?? makePgStructuralVerifierDeps();
  const run = async (): Promise<void> => {
    if (opts.isShedding?.()) return; // shed under load — cleanup is never urgent
    try {
      const r = await runStructuralErrorVerifierOnce(deps, { windowMs: opts.windowMs });
      if (r.resolved > 0) {
        opts.log?.(
          `[structural-error-verifier] auto-resolved ${r.resolved}/${r.checked} stale structural EIs (${r.kept} kept, ${r.errored} errored)`,
        );
      }
    } catch (e) {
      opts.log?.(
        `[structural-error-verifier] tick failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  timer = setInterval(() => void run(), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return { stop: stopStructuralErrorVerifier };
}

export function stopStructuralErrorVerifier(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
