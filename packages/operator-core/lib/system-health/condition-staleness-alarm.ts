/**
 * condition-staleness-alarm — the periodic ACTOR for `coord:conditions` (WI-2965,
 * closing the EI-7347 signal-actor-registry waiver for the `coord-conditions` signal).
 *
 * `coord:conditions` (agent-tools/coordination/tools/conditions.ts, computeConditionStates)
 * folds condition-keyed severe-event broadcasts (severe-event-broadcast.ts) into current
 * open/resolved STATE, but is a pure READ — nothing periodically re-evaluates it and takes
 * action on a condition that stays open. This is the exact read-only-signal trap the
 * registry exists to catch (service-health-events.ts's own comment: "it never fires on a
 * transition").
 *
 * IMPORTANT — why this is NOT "escalate every open condition": every current condition
 * SOURCE (git-sync-stall-watchdog.ts, green-stall-watchdog.ts, mcp-dark-watchdog.ts,
 * embed-exhaustion-alert.ts) already fires an immediate owner `notifyAttention` the moment
 * its condition OPENS, alongside the `broadcastSevereEvent` that lands it in coord:conditions.
 * Re-alerting the owner at open-time here would double-fire on literally every condition.
 * The actual gap the waiver names is narrower: if that immediate alert goes unactioned and
 * the condition just... stays open, nobody ever escalates that it is STILL open. This tick
 * closes exactly that gap — nothing more:
 *
 *   A condition OPEN longer than `staleMs` gets ONE distinctly-keyed REMINDER escalation
 *   (`stale-condition:<condition_key>` — a signature namespace that can never collide with
 *   a source watchdog's own open-time signature), durably deduped + auto-resolved the moment
 *   `computeConditionStates` reports it resolved (or no longer stale), mirroring
 *   liveness-alarm.ts's EI-2146 dedup/auto-resolve/debounce architecture exactly so the two
 *   independent alarms never drift on shape.
 *
 * Best-effort + fail-soft: never throws, never blocks the request worker it runs on.
 */
import { managedSetInterval } from '@papercusp/scheduled-registry';
import {
  computeConditionStates,
  readConditionEnvelopes,
  type ConditionState,
} from '../agent-tools/coordination/tools/conditions';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationSeverity,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export const CONDITION_STALENESS_IDENTITY: AgentIdentity = {
  ownerId: 'system:condition-staleness-alarm',
  ownerLabel: 'system · condition-staleness-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One "this condition has been open too long" reminder signal. */
export interface StaleConditionSignal {
  /** `stale-condition:<condition_key>` — the durable dedup/auto-resolve signature. */
  key: string;
  conditionKey: string;
  severity: EscalationSeverity;
  summary: string;
}

const DEFAULT_STALE_OPEN_MS = 45 * 60_000; // 45min: long enough that the source's own
// open-time notifyAttention has had a real chance to be seen/actioned before we nudge again.
const DEFAULT_DEBOUNCE_MS = 30 * 60_000; // re-nudge at most every 30min while still stale
const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * PURE: which currently-OPEN conditions have been open longer than `staleMs`, as of `now`.
 * A condition already resolved (per computeConditionStates) never appears here, regardless
 * of how long it took to resolve — this alarm is only about conditions still stuck open.
 */
export function evaluateStaleConditions(
  states: readonly ConditionState[],
  now: number,
  staleMs: number = DEFAULT_STALE_OPEN_MS,
): StaleConditionSignal[] {
  const out: StaleConditionSignal[] = [];
  for (const s of states) {
    if (!s.open) continue;
    const firstSeenMs = Date.parse(s.first_seen);
    if (!Number.isFinite(firstSeenMs)) continue;
    const ageMs = now - firstSeenMs;
    if (ageMs <= staleMs) continue;
    out.push({
      key: `stale-condition:${s.condition_key}`,
      conditionKey: s.condition_key,
      severity: 'advisory',
      summary:
        `condition '${s.condition_key}' has been OPEN for ${Math.round(ageMs / 60_000)}m` +
        `${s.category ? ` (${s.category})` : ''} — latest: ${s.latest_summary ?? '(no summary)'}. ` +
        `This is a follow-up REMINDER only (the source already alerted the owner when it opened) — ` +
        `check coord:conditions / the source watchdog if it is genuinely stuck.`,
    });
  }
  return out;
}

const SUMMARY_PREFIX = '[condition-stale] ';

/** Derive a legacy (no explicit signature) record's signature from its summary prefix. */
function deriveStaleSignatureFromSummary(summary: string): string | null {
  if (!summary?.startsWith(SUMMARY_PREFIX)) return null;
  const m = summary.match(/condition '([^']+)' has been OPEN/);
  return m ? `stale-condition:${m[1]}` : null;
}

/** The stable signature of an open escalation this alarm wrote (explicit meta, else derived). */
function staleConditionSignatureOf(rec: EscalationRecord): string | null {
  const explicit = (rec as Record<string, unknown>).conditionStalenessSignature;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return deriveStaleSignatureFromSummary(rec.summary ?? '');
}

const lastAlertedAt = new Map<string, number>();
const OPEN_SCAN_WINDOW = 500;

export interface ConditionStalenessDeps {
  readStates?: () => Promise<ConditionState[]>;
  escalate?: (input: {
    severity: EscalationSeverity;
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  listOpen?: () => Promise<EscalationRecord[]>;
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  now?: () => number;
  staleMs?: number;
  debounceMs?: number;
}

/**
 * One tick: fold current condition envelopes → state, find conditions stuck open past
 * `staleMs`, auto-resolve any prior stale-reminder whose condition cleared (or is no longer
 * stale), and fire a durably-deduped + debounced reminder for every new stale signature.
 */
export async function runConditionStalenessTick(
  deps: ConditionStalenessDeps = {},
): Promise<{ fired: StaleConditionSignal[]; signals: StaleConditionSignal[]; resolved: string[] }> {
  const now = (deps.now ?? Date.now)();
  const readStates =
    deps.readStates ?? (async () => computeConditionStates(await readConditionEnvelopes()));
  const escalate = deps.escalate ?? ((input) => openEscalation(CONDITION_STALENESS_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      const { escalations } = await listEscalationsPaginated({ status: 'open', maxRecords: OPEN_SCAN_WINDOW });
      return escalations.filter((e) => e.from === CONDITION_STALENESS_IDENTITY.ownerId);
    });
  const resolve =
    deps.resolve ??
    ((msg_id, choice, note) =>
      resolveEscalation({ msg_id, choice, note, resolver: CONDITION_STALENESS_IDENTITY.ownerId }));
  const staleMs = deps.staleMs ?? DEFAULT_STALE_OPEN_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let states: ConditionState[];
  try {
    states = await readStates();
  } catch {
    // A read failure must never crash the request worker nor look like "all clear".
    return { fired: [], signals: [], resolved: [] };
  }

  const signals = evaluateStaleConditions(states, now, staleMs);
  const currentSigs = new Set(signals.map((s) => s.key));

  let openBySig = new Map<string, EscalationRecord[]>();
  try {
    for (const rec of await listOpen()) {
      const sig = staleConditionSignatureOf(rec);
      if (!sig) continue;
      const list = openBySig.get(sig);
      if (list) list.push(rec);
      else openBySig.set(sig, [rec]);
    }
  } catch {
    openBySig = new Map();
  }

  // Auto-resolve every open stale-reminder whose condition is no longer open+stale.
  const resolved: string[] = [];
  for (const [sig, recs] of openBySig) {
    if (currentSigs.has(sig)) continue;
    for (const rec of recs) {
      try {
        await resolve(
          rec.msg_id,
          'auto-resolved',
          `condition-staleness signal '${sig}' cleared (condition resolved or no longer stale)`,
        );
        resolved.push(rec.msg_id);
      } catch {
        /* a resolve failure must never crash the request worker */
      }
    }
    lastAlertedAt.delete(sig);
  }

  // Fire each NEW stale signature — durably deduped, then in-memory cooldown-debounced.
  const fired: StaleConditionSignal[] = [];
  for (const s of signals) {
    if (openBySig.has(s.key)) continue;
    const prev = lastAlertedAt.get(s.key);
    if (prev !== undefined && now - prev < debounceMs) continue;
    lastAlertedAt.set(s.key, now);
    fired.push(s);
    try {
      await escalate({
        severity: s.severity,
        summary: `${SUMMARY_PREFIX}${s.summary}`,
        body:
          `Detected by the coord:conditions staleness actor (WI-2965) — a periodic re-evaluation ` +
          `of computeConditionStates(), NOT a duplicate of the source watchdog's open-time alert. ` +
          `Condition key: ${s.conditionKey}.`,
        meta: { conditionStalenessSignature: s.key },
      });
    } catch {
      /* an alarm-send failure must never crash the request worker */
    }
  }
  return { fired, signals, resolved };
}

/**
 * Start the alarm on a request-worker loop, mirroring startInfraLivenessAlarm's shape
 * (unref'd timer, env-killable, interval overridable). Wire alongside
 * startInfraLivenessAlarm() in bin/hono-host.ts.
 */
export function startConditionStalenessAlarm(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_CONDITION_STALENESS_ALARM === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_CONDITION_STALENESS_ALARM_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = managedSetInterval(
    'condition-staleness-alarm',
    intervalMs,
    () => runConditionStalenessTick().then(() => undefined, () => undefined),
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-signature debounce. */
export function _resetConditionStalenessDebounce(): void {
  lastAlertedAt.clear();
}
