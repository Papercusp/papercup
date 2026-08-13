/**
 * pty-host-wedge-guard — find live psu-pty hosts that have gone WAKE-DEAF, from
 * OUTSIDE the host process (EI-20287339148365013 / the owner's "I want a durable fix").
 *
 * ## The class
 * A psu-pty host is a per-session process that runs whatever code it started with,
 * forever. When its owner-composer gate believes an unsubmitted input line is staged,
 * every injected wake is DEFERRED "for the next natural turn" — and the agent simply
 * stops taking turns. Measured 2026-08-12: one host deferred 32 consecutive wakes and
 * sat idle ~50 minutes; the episode ended only because a human noticed.
 *
 * ## Why this must be an EXTERNAL observer, not more host-side code
 * Two independent reasons, both verified rather than assumed:
 *
 *  1. THE WAKE RECEIPT STRUCTURALLY CANNOT REPORT THE DEFERRAL. psu-pty-host.mjs acks
 *     `accepted` BEFORE the delivery gate runs, and says so in its own comment: every
 *     outcome the gate reaches "is already durably recorded via appendHostEvent() ...
 *     exactly as a caller ... would have had to learn it — from the durable event log
 *     or the pty's own output, NEVER from this ACK". So `woken:1 / delivered` is a
 *     statement about DELIVERY TO A HANDLE, not about a turn happening, and no amount
 *     of care at the call site can recover the difference. The per-owner
 *     `<owner>.events.jsonl` ledger is the only channel carrying the truth.
 *
 *  2. A CODE FIX CANNOT REACH A PROCESS THAT STARTED BEFORE IT. The in-host breaker
 *     (`shouldBreakComposerWedge`, b9543fc83e) closes this class going FORWARD, but 64
 *     of the 162 live hosts measured on this box predate the parse fix that stops the
 *     phantom from being staged at all, and a carry-respawn restarts the AGENT, not the
 *     HOST (measured: su-f0c6fa5e respawned 22:56:00Z and deferred its first wake at
 *     22:59:12Z against the same phantom; its host pid had been alive since 08:45:50Z).
 *     Those hosts can never self-heal. The ledger, however, is written identically by
 *     hosts of EVERY vintage — which is precisely what lets one external reader observe
 *     the population that host-side code can no longer reach.
 *
 * ## The layering property worth preserving
 * The in-host breaker trips at 5 consecutive defers. This guard's threshold sits ABOVE
 * it ({@link DEFAULT_MIN_CONSECUTIVE_DEFERS}), so a host running current code breaks its
 * own wedge long before this guard would name it. That is not a redundancy — it means a
 * firing here is itself EVIDENCE that the first-line fix did not run, which is the one
 * thing an external observer can establish and the host cannot report about itself.
 *
 * ## Scope (deliberate)
 * Phase 1 DETECTS and SURFACES. It does not kill or relaunch anything. The tempting next
 * step — teaching the wake-reachability oracle that a wedged host is not reachable — is
 * deliberately deferred: that verdict feeds loop-TERMINATION guards, so a false positive
 * there disarms live agents, and this detector's precision should be measured against the
 * live population before anything acts on it.
 */
import {
  listLiveHosts,
  readHostEventTail,
  hostStartedAt,
  PSU_PTY_DIR,
  type PsuPtyHost,
  type PtyHostEvent,
} from '../../events/await/psu-pty-discovery';
import type { AttentionNotifyInput } from '../../attention-notify';
import { broadcastSevereEvent } from '../../severe-event-broadcast';

/** The host event kind that records a wake being refused for a staged owner line. */
export const DEFER_KIND = 'turn-deferred-for-owner-input';

/**
 * Minimum consecutive defers before this guard will name a host.
 *
 * Sits ABOVE the in-host breaker's default of 5 (PAPERCUSP_PSU_PTY_WEDGE_BREAK_MAX_DEFERS)
 * on purpose — see the layering note in the module header. Raising the breaker's max
 * above this number would silently invert that relationship, which is why both numbers
 * are asserted against each other in the tests rather than merely documented here.
 */
export const DEFAULT_MIN_CONSECUTIVE_DEFERS = 8;

/**
 * Minimum wall-clock span the streak must cover.
 *
 * A burst of wakes can produce many defers in seconds — e.g. a fleet leader waking every
 * member at once, or a retry loop. That is backpressure, not a wedge. A wedge is defined
 * by DURATION: the line never moves and the agent never takes a turn. 10 minutes is well
 * past any legitimate burst and still far inside the ~50-minute strands measured.
 */
export const DEFAULT_MIN_STREAK_SPAN_MS = 10 * 60_000;

/**
 * How long a host must have produced NO pty output before a recovery action could be
 * considered safe. A wedged host can still be mid-turn — measured: su-f0c6fa5e was
 * actively producing output at 23:00:22Z while unable to RECEIVE wakes — so idleness is
 * the discriminator between "safe to replace" and "would destroy in-flight work".
 * Reported, not acted on, in Phase 1.
 */
export const DEFAULT_RECOVERY_IDLE_MS = 15 * 60_000;

/** Tail bytes scanned per host. A defer row is ~150 bytes and a streak of interest is
 *  tens of rows, but respawn-heavy ledgers interleave thousands of unrelated rows, so
 *  this is sized for the interleaving rather than for the streak. */
const WEDGE_SCAN_TAIL_BYTES = 256 * 1024;

/**
 * Event kinds that PROVE the composer accepted input, and therefore end a streak.
 *
 * Each entry is a delivery that had to pass the SAME gate a wake passes, or direct
 * evidence of a human at the keyboard. Note what is deliberately ABSENT: `respawned`.
 * A respawn replaces the agent while the host — and its composer model — persist, which
 * is exactly why the wedge survives one (measured above). Treating a respawn as a clear
 * would have exonerated the very host that proved the class.
 */
const STREAK_CLEARING_KINDS = new Set<string>([
  // The in-host breaker fired and cleared the line itself.
  'owner-composer-wedge-cleared',
  // A respawn cleared a staged line (the current host's respawn-time clear).
  'owner-composer-cleared-on-respawn',
  // Carry text was written into the composer AND submitted — the gate let it through.
  'respawn-carry-delivered',
  'compact-carry-delivered',
  'compact-submitted',
  // A human typed. Whatever else is true, this composer is not an abandoned phantom.
  'owner-input-during-compact-wait',
]);

/** Milliseconds for an event's `ts`, or null when it is missing/unparseable. */
function eventTimeMs(ev: PtyHostEvent): number | null {
  if (typeof ev.ts !== 'string') return null;
  const t = Date.parse(ev.ts);
  return Number.isFinite(t) ? t : null;
}

export interface ComposerWedgeVerdict {
  /** Does this host meet EVERY wedge criterion? */
  wedged: boolean;
  /** Length of the trailing consecutive-defer run, scoped to this host's own lifetime. */
  consecutiveDefers: number;
  /** The staged length shared by every defer in the run; null when none, or when it varied. */
  pendingLength: number | null;
  /** True when the run's pendingLength values were NOT all equal — a moving line. */
  pendingLengthVaried: boolean;
  /** Wall-clock span from the run's first defer to its last. */
  streakSpanMs: number;
  /** Age of the most recent defer, or null when there were none. */
  lastDeferAgeMs: number | null;
  /**
   * Did these defers carry `pendingAgeMs`/`ownerQuietMs`?
   *
   * Their ABSENCE is a precise, cheap signature that the host predates the forensics the
   * in-host breaker keys on — i.e. that it cannot self-recover. Measured across the live
   * population: the wedged group was 0/N on both fields; the healthy group was N/N.
   */
  emitsForensics: boolean;
  /** One honest line, always present — including for the not-wedged verdicts. */
  reason: string;
}

export interface ClassifyComposerWedgeInput {
  /** The host's ledger tail, oldest-first (as {@link readHostEventTail} returns it). */
  events: PtyHostEvent[];
  /** Epoch ms this host process started. Events at or before it belong to a PREDECESSOR. */
  startedAtMs: number;
  now?: number;
  minConsecutiveDefers?: number;
  minStreakSpanMs?: number;
}

/**
 * Classify one host's ledger tail. PURE — no I/O, injectable clock.
 *
 * The discriminator that carries the verdict is CONSTANT `pendingLength`, and it is
 * chosen from measurement rather than intuition: every wedged host in the live
 * population showed the same 11 characters on every defer (VTE's XTVERSION reply
 * `>|VTE(7600)`, mis-parsed into the composer), while healthy backpressure showed lengths
 * that moved (53/48/80). It also happens to be the safe rule for the case this must never
 * get wrong: a person types, so their line's length changes, so a person can never
 * accumulate a streak no matter how long they leave an unsent message staged.
 */
export function classifyComposerWedge(input: ClassifyComposerWedgeInput): ComposerWedgeVerdict {
  const {
    events,
    startedAtMs,
    now = Date.now(),
    minConsecutiveDefers = DEFAULT_MIN_CONSECUTIVE_DEFERS,
    minStreakSpanMs = DEFAULT_MIN_STREAK_SPAN_MS,
  } = input;

  const notWedged = (reason: string, over: Partial<ComposerWedgeVerdict> = {}): ComposerWedgeVerdict => ({
    wedged: false,
    consecutiveDefers: 0,
    pendingLength: null,
    pendingLengthVaried: false,
    streakSpanMs: 0,
    lastDeferAgeMs: null,
    emitsForensics: false,
    reason,
    ...over,
  });

  // Walk BACKWARDS from the tail, collecting the trailing run of defers. Anything in
  // STREAK_CLEARING_KINDS ends the run; every other kind is neutral and is stepped over
  // (a wedged host still respawns, reconnects MCP and drops stale fires throughout).
  const run: PtyHostEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const kind = typeof ev.kind === 'string' ? ev.kind : '';
    const ts = eventTimeMs(ev);

    // THE SCOPING RULE. The ledger is per-OWNER and outlives any one host process, so an
    // event from before this host started belongs to a PREVIOUS incarnation. Counting
    // unscoped charged four hosts with their predecessors' incidents (2026-08-12) — the
    // impossibility that caught it was "defers timestamped before the host they were
    // attributed to had started". An event with no readable ts cannot be proven to be
    // ours, so it stops the walk rather than being credited to us.
    if (ts == null) break;
    if (ts <= startedAtMs) break;

    if (STREAK_CLEARING_KINDS.has(kind)) break;
    if (kind === DEFER_KIND) run.push(ev);
  }

  if (run.length === 0) return notWedged('no deferrals in this host’s own lifetime');

  // run is newest-first; read the ends accordingly.
  const newest = run[0];
  const oldest = run[run.length - 1];
  const newestTs = eventTimeMs(newest) ?? now;
  const oldestTs = eventTimeMs(oldest) ?? newestTs;
  const streakSpanMs = Math.max(0, newestTs - oldestTs);
  const lastDeferAgeMs = Math.max(0, now - newestTs);

  const lengths = run.map((e) => (typeof e.pendingLength === 'number' ? e.pendingLength : null));
  const firstLen = lengths[0];
  const pendingLengthVaried = lengths.some((l) => l !== firstLen);
  const pendingLength = pendingLengthVaried ? null : firstLen;
  const emitsForensics = run.some(
    (e) => typeof e.pendingAgeMs === 'number' || typeof e.ownerQuietMs === 'number',
  );

  const base = {
    consecutiveDefers: run.length,
    pendingLength,
    pendingLengthVaried,
    streakSpanMs,
    lastDeferAgeMs,
    emitsForensics,
  };

  if (pendingLengthVaried) {
    return notWedged(
      `${run.length} consecutive deferral(s) but the staged length CHANGED across them — a moving ` +
        'line is a person typing, never a phantom',
      base,
    );
  }
  if (pendingLength == null || pendingLength <= 0) {
    return notWedged(
      `${run.length} consecutive deferral(s) with no usable pendingLength — cannot distinguish a ` +
        'phantom from a person, so refusing to name this host',
      base,
    );
  }
  if (run.length < minConsecutiveDefers) {
    return notWedged(
      `${run.length} consecutive deferral(s) — below the ${minConsecutiveDefers} floor (the in-host ` +
        'breaker is still expected to handle this)',
      base,
    );
  }
  if (streakSpanMs < minStreakSpanMs) {
    return notWedged(
      `${run.length} consecutive deferral(s) but only over ${Math.round(streakSpanMs / 1000)}s — a ` +
        'burst of wakes is backpressure, not a wedge',
      base,
    );
  }

  return {
    ...base,
    wedged: true,
    reason:
      `${run.length} consecutive wake deferral(s) over ${Math.round(streakSpanMs / 60_000)}m, every ` +
      `one against the SAME ${pendingLength}-char staged line, with no intervening submit` +
      (emitsForensics
        ? ''
        : ' — and no pendingAgeMs/ownerQuietMs on any of them, the signature of a host too old to ' +
          'run the in-host breaker at all'),
  };
}

export interface WedgedHostReport {
  ownerId: string;
  pid: number;
  /** Epoch ms the host process started. */
  startedAt: number;
  /** How long this host process has been alive. */
  hostAgeMs: number;
  /** Idle time from the host's own activity stamps, or null when none are readable. */
  idleMs: number | null;
  /**
   * Would a recovery action be safe RIGHT NOW?
   *
   * `idle` — no pty output for {@link DEFAULT_RECOVERY_IDLE_MS}; replacing this host would
   *   not interrupt anything in flight.
   * `busy` — the agent is still emitting. It is wedged (cannot RECEIVE wakes) yet working,
   *   so trampling it would destroy real work. Surface, never act.
   * `unknown` — no readable activity stamp. Fails toward `busy`, deliberately: the guard's
   *   dangerous error is destroying live work, so absent evidence must not authorise action.
   */
  recoverySafety: 'idle' | 'busy' | 'unknown';
  verdict: ComposerWedgeVerdict;
}

export interface PtyHostWedgeSweepResult {
  /** Live hosts examined. */
  checked: number;
  /** Hosts meeting every wedge criterion, worst (longest streak) first. */
  wedged: WedgedHostReport[];
  /** Hosts whose ledger yielded no readable events — an absence, NOT a clean bill of health. */
  unreadable: string[];
  dryRun: boolean;
}

export interface PtyHostWedgeSweepDeps {
  /** Injectable for tests; defaults to the real live-host census. */
  listHosts?: (dir?: string) => PsuPtyHost[];
  /** Injectable for tests; defaults to the real bounded-tail ledger read. */
  readEvents?: (ownerId: string, dir?: string, maxBytes?: number) => PtyHostEvent[];
  /** Injectable for tests; defaults to the real discovery-file start-time read. */
  readStartedAt?: (ownerId: string, dir?: string) => number | null;
  /** Injectable for tests; defaults to the real fleet-wide broadcast. */
  broadcast?: typeof broadcastSevereEvent;
  /**
   * Injectable for tests; defaults to the real OWNER page, imported dynamically at call
   * time (matching stalled-loops-guard): `attention-notify` pulls in the push/SSE
   * transports, and a routine that runs on a cadence must not carry them just to page on
   * the rare wedge.
   */
  notify?: (input: AttentionNotifyInput) => Promise<void>;
  now?: number;
}

export interface PtyHostWedgeSweepOptions {
  dryRun?: boolean;
  dir?: string;
  minConsecutiveDefers?: number;
  minStreakSpanMs?: number;
  recoveryIdleMs?: number;
}

/**
 * One pass over every live psu-pty host on this box.
 *
 * Cost is one small discovery read plus one bounded tail read per host — no PG, no
 * sockets, and nothing that can perturb a host it is observing. Fail-soft throughout: a
 * host whose ledger cannot be read is REPORTED as unreadable rather than skipped
 * silently, because "I could not see" and "there is nothing there" are the two readings
 * this guard must never conflate.
 */
export async function sweepWedgedPtyHosts(
  opts: PtyHostWedgeSweepOptions = {},
  deps: PtyHostWedgeSweepDeps = {},
): Promise<PtyHostWedgeSweepResult> {
  const {
    dryRun = false,
    dir = PSU_PTY_DIR,
    minConsecutiveDefers = DEFAULT_MIN_CONSECUTIVE_DEFERS,
    minStreakSpanMs = DEFAULT_MIN_STREAK_SPAN_MS,
    recoveryIdleMs = DEFAULT_RECOVERY_IDLE_MS,
  } = opts;
  const now = deps.now ?? Date.now();
  const listHosts = deps.listHosts ?? ((d?: string) => listLiveHosts(d ?? dir));
  const readEvents =
    deps.readEvents ?? ((o: string, d?: string, m?: number) => readHostEventTail(o, d ?? dir, m));
  const readStartedAt = deps.readStartedAt ?? ((o: string, d?: string) => hostStartedAt(o, d ?? dir));

  const hosts = listHosts(dir);
  const wedged: WedgedHostReport[] = [];
  const unreadable: string[] = [];

  for (const host of hosts) {
    const events = readEvents(host.ownerId, dir, WEDGE_SCAN_TAIL_BYTES);
    if (events.length === 0) {
      unreadable.push(host.ownerId);
      continue;
    }
    // Prefer the discovery file's own startedAt; fall back to the host record we already
    // hold. Without a boundary we cannot tell this host's incidents from its
    // predecessor's, so refusing is the only honest option.
    const startedAtMs = readStartedAt(host.ownerId, dir) ?? host.startedAt;
    if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) {
      unreadable.push(host.ownerId);
      continue;
    }

    const verdict = classifyComposerWedge({
      events,
      startedAtMs,
      now,
      minConsecutiveDefers,
      minStreakSpanMs,
    });
    if (!verdict.wedged) continue;

    const stamps = [host.lastActivityAt, host.lastOutputAt, host.lastInputAt].filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    );
    const idleMs = stamps.length ? Math.max(0, now - Math.max(...stamps)) : null;
    const recoverySafety: WedgedHostReport['recoverySafety'] =
      idleMs == null ? 'unknown' : idleMs >= recoveryIdleMs ? 'idle' : 'busy';

    wedged.push({
      ownerId: host.ownerId,
      pid: host.pid,
      startedAt: startedAtMs,
      hostAgeMs: Math.max(0, now - startedAtMs),
      idleMs,
      recoverySafety,
      verdict,
    });
  }

  wedged.sort((a, b) => b.verdict.consecutiveDefers - a.verdict.consecutiveDefers);

  if (wedged.length > 0 && !dryRun) {
    const worst = wedged[0];
    const summary =
      `${wedged.length}/${hosts.length} live psu-pty host(s) are WAKE-DEAF — every wake to them is ` +
      `being deferred against a staged input line that never moves (worst: ${worst.ownerId}, ` +
      `${worst.verdict.consecutiveDefers} consecutive deferrals)`;
    const body = [
      'Each host below acked its wakes as `delivered` and then took no turn. That receipt is not a',
      'bug at the call site: psu-pty-host acks BEFORE its delivery gate runs, so a deferral can only',
      'ever be observed here, in the on-disk ledger.',
      '',
      ...wedged.map(
        (w) =>
          `- ${w.ownerId} (pid ${w.pid}, host up ${Math.round(w.hostAgeMs / 60_000)}m, ` +
          `${w.recoverySafety}${w.idleMs == null ? '' : ` ${Math.round(w.idleMs / 60_000)}m`}): ${w.verdict.reason}`,
      ),
      '',
      'A host marked `idle` can be replaced without destroying in-flight work; one marked `busy` is',
      'still emitting output and must NOT be trampled — it is working, it simply cannot be reached.',
    ].join('\n');

    const broadcast = deps.broadcast ?? broadcastSevereEvent;
    try {
      await broadcast({
        summary,
        body,
        conditionKey: 'pty-host-wedge',
        oneShot: true,
      });
    } catch {
      /* best-effort — a broadcast failure must never fail the sweep */
    }

    try {
      const notify =
        deps.notify ??
        (await import('../../attention-notify').then((m) => m.notifyAttention as typeof notify));
      await notify?.({
        kind: 'pty-host-wedge',
        title: `${wedged.length} agent session(s) cannot receive wakes`,
        body: summary,
        severity: 'warning',
      } as AttentionNotifyInput);
    } catch {
      /* best-effort — paging is not the sweep's contract */
    }
  }

  return { checked: hosts.length, wedged, unreadable, dryRun };
}
