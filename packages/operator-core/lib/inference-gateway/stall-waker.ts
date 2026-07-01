/**
 * stall-waker — auto-wake CLI bees whose turn died on a rate limit, once the account recovers
 * (gateway-rate-limit-stall-autowake P-003/P-004).
 *
 * The gateway (P-002) records a STALL when it sheds an all-throttled 429 to an identified bee
 * (`x-papercusp-owner`), exposing `{ownerId, accountId, soonestResetAt}` on GET /admin/stalls. This loop
 * consumes those, and for each:
 *   1. CONFIRMS the bee actually stalled — it went idle, it did NOT recover on its own CLI retry
 *      (the false-positive guard — otherwise we'd wake bees that were fine).
 *   2. WAITS for the account's `soonestResetAt`, then confirms capacity is genuinely back.
 *   3. WAKES the bee (`coord:send {wake:true}` via `wakeRecipients`), which resumes its session.
 *
 * The gateway stays a thin proxy; ALL the confirm-wait-wake state lives here. Pure + deps-injected so the
 * decision logic is unit-tested without a clock, a gateway, or a DB. `now()` is injectable.
 */

export interface StallEvent {
  ownerId: string;
  accountId: string;
  soonestResetAt: number;
  at: number;
}

export interface StallWakerDeps {
  /** GET /admin/stalls?since=<ms> on the running gateway → the new stall candidates. */
  fetchStalls: (sinceMs: number) => Promise<{ now: number; stalls: StallEvent[] }>;
  /** Did this OWNER (ANY role — a harness bee, an su/psu session, anything holding a coord wake-key) actually
   *  STALL (go idle/stream-silent), vs recover on its own retry? The false-positive guard: we only wake an
   *  owner we've confirmed is sitting idle. Role-agnostic — the autowake works the same for every caller. */
  ownerIsIdle: (ownerId: string) => Promise<boolean>;
  /** Has the account's budget actually returned (its pause expired + the gateway can serve again)? Guards
   *  against waking a bee straight back into a still-throttled pool. */
  capacityBack: (accountId: string, soonestResetAt: number) => Promise<boolean>;
  /** Fire the targeted coord wake. Returns `woken` (>0 = a watching bee was re-invoked; 0 = nobody home —
   *  the bee process is gone, not a resumable session). Honors the hive pause/manual gate internally. */
  wake: (ownerId: string, summary: string) => Promise<{ woken: number }>;
  /** FAST un-wedge (owner-requested 2026-06-23): ESC the owner's dead turn NOW (no wake), decoupled from the
   *  capacity gate. A turn that DIED on a gateway error is WEDGED — its CLI can't receive ANY message (not even
   *  a wake) until the dead turn is ESC'd. This re-arms it immediately so it's reachable again, WITHOUT shoving
   *  it back into a still-throttled pool (the capacity-gated `wake` below does the resume once budget returns).
   *  Optional — omit to keep only the legacy capacity-gated ESC+wake.
   *
   *  Resolves `{ ok }` — `true` only when the ESC genuinely landed, `false` on ANY refusal/failure — plus an
   *  `expected` flag: `true` when the ESC found NOTHING to interrupt (no live pty + no session pid — the owner
   *  is idle or already ended its turn, i.e. NOT actually wedged). tick() uses `expected` to stay quiet for
   *  that non-event (it recurs every cooldown for the same gone owners → host-log spam) while still warning
   *  on a genuine refusal (e.g. storm-guard rate-limit). Never throw to signal failure (root-cause fix,
   *  2026-07-01, gateway-mass-outage-storm-guard: the underlying `turn:interrupt` core never throws, it
   *  returns `{ok:false, error:...}` as a normal value, so a `Promise<void>` shape here silently swallowed
   *  every refused/failed ESC — `tick()` logged "un-wedged … reachable again" and armed the cooldown even
   *  though nothing was delivered, masking the exact failures a correlated gateway outage produces). */
  unwedge?: (ownerId: string) => Promise<{ ok: boolean; expected?: boolean }>;
  now: () => number;
  log: (level: 'info' | 'warn', msg: string) => void;
}

export interface StallWakerOptions {
  /** A bee that hasn't gone idle within this window after its stall RECOVERED on its own → drop it. Default 2 min. */
  confirmWindowMs?: number;
  /** Don't re-wake the same bee within this cooldown. Default 60 s. */
  wakeCooldownMs?: number;
  /** Don't re-fast-ESC (un-wedge) the same wedged owner within this cooldown — so a session that keeps
   *  erroring isn't ESC-stormed. Default 45 s. */
  unwedgeCooldownMs?: number;
  /** Give up on a bee after this many wake attempts (it isn't resuming). Default 3. */
  maxWakesPerBee?: number;
  /** Forget a pending stall entirely after this long (bound the map; the reset never came). Default 2 h. */
  pendingTtlMs?: number;
}

interface Pending {
  accountId: string;
  soonestResetAt: number;
  recordedAt: number;
}

const DEFAULTS: Required<StallWakerOptions> = {
  confirmWindowMs: 2 * 60_000,
  wakeCooldownMs: 60_000,
  unwedgeCooldownMs: 45_000,
  maxWakesPerBee: 3,
  pendingTtlMs: 2 * 60 * 60_000,
};

export class StallWaker {
  private since = 0;
  /** ownerId → the pending stall we're waiting to act on (one per bee; soonestReset = the max seen). */
  private readonly pending = new Map<string, Pending>();
  private readonly lastWokeAt = new Map<string, number>();
  private readonly lastUnwedgeAt = new Map<string, number>();
  private readonly wakeCount = new Map<string, number>();
  private readonly opt: Required<StallWakerOptions>;

  constructor(private readonly deps: StallWakerDeps, opts: StallWakerOptions = {}) {
    this.opt = { ...DEFAULTS, ...opts };
  }

  /** Observability: how many bees are currently waiting for a wake. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** One pass: pull new stalls, then re-evaluate every pending bee. Never throws (each step is guarded);
   *  returns what it pulled + which bees it woke this tick. */
  async tick(): Promise<{ pulled: number; woken: string[]; dropped: string[]; unwedged: string[] }> {
    const woken: string[] = [];
    const dropped: string[] = [];
    const unwedged: string[] = [];
    const now = this.deps.now();

    // 1. Pull new stall candidates and fold them into `pending` (one entry per bee).
    let pulled = 0;
    try {
      const res = await this.deps.fetchStalls(this.since);
      for (const s of res.stalls) {
        this.since = Math.max(this.since, s.at);
        pulled++;
        const ex = this.pending.get(s.ownerId);
        if (!ex) this.pending.set(s.ownerId, { accountId: s.accountId, soonestResetAt: s.soonestResetAt, recordedAt: now });
        else ex.soonestResetAt = Math.max(ex.soonestResetAt, s.soonestResetAt); // a later stall pushes the wait out
      }
    } catch (e) {
      this.deps.log('warn', `stall-waker: fetchStalls failed: ${(e as Error).message}`);
    }

    // 2. Re-evaluate each pending bee.
    for (const [ownerId, info] of [...this.pending]) {
      // Bound the map: a stall whose reset never arrives is forgotten.
      if (now - info.recordedAt > this.opt.pendingTtlMs) {
        this.pending.delete(ownerId);
        dropped.push(ownerId);
        continue;
      }

      // 2a. FALSE-POSITIVE GUARD — only act once the bee is confirmed idle. A bee that recovered on its own
      //     CLI retry is still running → not idle → dropped after the confirm window.
      let idle = false;
      try {
        idle = await this.deps.ownerIsIdle(ownerId);
      } catch (e) {
        this.deps.log('warn', `stall-waker: ownerIsIdle(${ownerId}) failed: ${(e as Error).message}`);
        continue; // unknown → re-check next tick, don't wake blindly
      }
      if (!idle) {
        if (now - info.recordedAt > this.opt.confirmWindowMs) {
          this.pending.delete(ownerId);
          dropped.push(ownerId);
          this.deps.log('info', `stall-waker: ${ownerId} never went idle (recovered on its own) — dropped`);
        }
        continue;
      }

      // 2a-FAST. UN-WEDGE NOW (owner-requested 2026-06-23): the bee is confirmed idle = its turn DIED on a
      // gateway error and the CLI is wedged (can't receive ANY message — not even the wake below — until the
      // dead turn is ESC'd). Don't make it wait out the capacity gate to become reachable: ESC it immediately
      // so it can receive messages again. Storm-safe (ESC only, NO wake → we don't push it back into a still-
      // throttled pool); the capacity-gated wake below does the actual resume once budget returns. Cooldowned
      // so a session that keeps erroring isn't ESC-stormed.
      if (this.deps.unwedge && now - (this.lastUnwedgeAt.get(ownerId) ?? 0) >= this.opt.unwedgeCooldownMs) {
        // Attempt cadence unconditional (keeps the existing unwedgeCooldownMs pacing regardless of
        // outcome — a permanently-unreachable owner, e.g. a headless bee with no live pty, must not
        // be retried every tick). What changed (root-cause fix, 2026-07-01): the OUTCOME is now
        // actually checked — `unwedge` returns false on a refused/failed ESC (it never throws for
        // that), so we must NOT report success (push to `unwedged` / log "reachable again") when it
        // didn't land. Silently treating a refusal as success was exactly why a mass gateway-outage
        // burst (>~10 distinct owners/60s trips the storm guard) left owners past the cap wedged with
        // no visible failure and no urgency to retry.
        this.lastUnwedgeAt.set(ownerId, now);
        try {
          const res = await this.deps.unwedge(ownerId);
          if (res.ok) {
            unwedged.push(ownerId);
            this.deps.log('info', `stall-waker: fast-ESC un-wedged ${ownerId} (turn died on a gateway error) — reachable again`);
          } else if (res.expected) {
            // EXPECTED non-event: the "stalled" owner has no live turn to ESC (idle, or already ended its turn)
            // — it is NOT wedged. Non-actionable, and it recurs every cooldown for the same gone owners, so we
            // DON'T log it (this was the ~27×/15min `[stall-waker] … no live interruptible session` host-log
            // spam). A truly gone owner is dropped when its bee row / coord presence ages out; a resumable one
            // is handled by the capacity-gated wake path below.
          } else {
            this.deps.log(
              'warn',
              `stall-waker: unwedge(${ownerId}) did NOT land (refused — e.g. storm-guard rate-limit) — owner stays wedged, retrying after the ${this.opt.unwedgeCooldownMs}ms cooldown`,
            );
          }
        } catch (e) {
          this.deps.log('warn', `stall-waker: unwedge(${ownerId}) threw: ${(e as Error).message}`);
        }
      }

      // 2b. Wait for the account's reset.
      if (now < info.soonestResetAt) continue;

      // 2c. Confirm capacity is genuinely back (don't wake into a still-throttled pool).
      let back = false;
      try {
        back = await this.deps.capacityBack(info.accountId, info.soonestResetAt);
      } catch (e) {
        this.deps.log('warn', `stall-waker: capacityBack(${info.accountId}) failed: ${(e as Error).message}`);
      }
      if (!back) continue;

      // 2d. Cooldown + attempt cap.
      if (now - (this.lastWokeAt.get(ownerId) ?? 0) < this.opt.wakeCooldownMs) continue;
      if ((this.wakeCount.get(ownerId) ?? 0) >= this.opt.maxWakesPerBee) {
        this.pending.delete(ownerId);
        dropped.push(ownerId);
        this.deps.log('info', `stall-waker: ${ownerId} hit the wake cap — giving up`);
        continue;
      }

      // 2e. Wake.
      try {
        const r = await this.deps.wake(ownerId, `rate limit recovered on ${info.accountId} — resume your turn`);
        this.lastWokeAt.set(ownerId, now);
        this.wakeCount.set(ownerId, (this.wakeCount.get(ownerId) ?? 0) + 1);
        if (r.woken > 0) {
          woken.push(ownerId);
          this.pending.delete(ownerId);
          this.deps.log('info', `stall-waker: woke ${ownerId} (capacity back on ${info.accountId})`);
        } else {
          // Nobody watching the wake key — the bee process is gone (a one-shot turn that exited), not a
          // resumable session. Drop it; re-SPAWN-on-stall is future scope.
          this.pending.delete(ownerId);
          dropped.push(ownerId);
          this.deps.log('info', `stall-waker: ${ownerId} wake fired but nobody home (woken:0) — bee gone, dropped`);
        }
      } catch (e) {
        this.deps.log('warn', `stall-waker: wake(${ownerId}) failed: ${(e as Error).message}`);
      }
    }

    return { pulled, woken, dropped, unwedged };
  }
}
