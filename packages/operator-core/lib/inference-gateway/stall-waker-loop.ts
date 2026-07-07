/**
 * stall-waker-loop — wires the {@link StallWaker} to the LIVE gateway + coord + spawned_agents and runs it
 * on a poll loop (gateway-rate-limit-stall-autowake P-003). Idempotent + `unref`'d; started lazily from the
 * spawn path when the inference gateway is on (that's exactly when bees — and thus stalls — exist).
 */
import { StallWaker, type StallEvent, type StallWakerDeps } from './stall-waker';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { gatewayPort } from './spawn-env';
import { fetchGatewayHeadroom } from './observability';
import { getOrgPg } from '@papercusp/db-org';
import { getSpawnPg } from '../fleet/pg-stores';
import { accountStatus } from '../deployment/account-pool-store';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { forceEndTurn } from '../agent-tools/turn/interrupt';
import { isOwnerFocusedOnDesktop } from '../desktop-window-liveness';

const POLL_MS = Number(process.env.PAPERCUSP_STALL_WAKER_POLL_MS) || 20_000;
/** A bee stream-silent this long is idle/sleeping (turn ended, waiting on its wake key) — NOT actively
 *  retrying. We only wake a CONFIRMED-idle bee, so we never interrupt one mid-recovery. */
const IDLE_SILENCE_MS = Number(process.env.PAPERCUSP_STALL_WAKER_IDLE_MS) || 30_000;
/** Settle window between the ESC and the wake (coord-end-turn D-003): let the bee's CLI finish ending its
 *  dead turn + re-arm its inbox-wake watch before the wake fires. */
const ENDTURN_SETTLE_MS = Number(process.env.PAPERCUSP_ENDTURN_SETTLE_MS) || 1500;

/** Per-account dedupe for the usage-wall hold log (WI-3310): capacityBack runs every poll tick for
 *  every pending stall, and a weekly wall lasts DAYS — log once per (account, wall-reset), not per 20s. */
const usageWallLoggedUntil = new Map<string, number>();

/** Build the real deps: gateway HTTP (stalls), spawned_agents (idle), account-pool (capacity), coord (wake). */
export function createStallWakerDeps(workspaceId: string): StallWakerDeps {
  const base = () => `http://127.0.0.1:${gatewayPort()}`;
  return {
    fetchStalls: async (since) => {
      const r = await fetch(`${base()}/admin/stalls?since=${since}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { now: Date.now(), stalls: [] };
      return (await r.json()) as { now: number; stalls: StallEvent[] };
    },
    ownerIsIdle: async (ownerId) => {
      // ROLE-AGNOSTIC idle check (2026-06-22): the auto-wake must behave the SAME for ANY caller that holds a
      // coord wake-key — a harness bee, an su/psu engineer session, anything — not just bee spawns. Take the
      // most-recent activity from EITHER source: (a) the bee nursery's stream output (only a bee has a
      // spawned_agents row) and (b) coord presence's last_active_at (EVERY coord agent has one, any role).
      // Silent past the threshold from BOTH = the turn ended and the owner is sleeping on its wake-key
      // (wake-able), not mid-retry. (Before this it read ONLY spawned_agents, so an su/psu agent was never
      // recognized as idle → never auto-woken — the role-specific gap su-b813f hit.)
      const sql = getOrgPg().sql;
      const node = await getSpawnPg(sql, workspaceId, ownerId).catch(() => null);
      const beeOut = node?.lastOutputAt ? new Date(node.lastOutputAt).getTime() : 0;
      const presence = await sql<{ last_active_at: string | null }[]>`
        SELECT last_active_at FROM harness_shared.coord_presence WHERE owner_id = ${ownerId} LIMIT 1`.catch(
        () => [] as { last_active_at: string | null }[],
      );
      const coordAct = presence[0]?.last_active_at ? new Date(presence[0].last_active_at).getTime() : 0;
      const lastActivity = Math.max(beeOut, coordAct);
      if (lastActivity === 0) return false; // truly unknown owner (no bee row + no coord presence) → not wake-able
      return Date.now() - lastActivity > IDLE_SILENCE_MS;
    },
    capacityBack: async (accountId, soonestResetAt) => {
      // H5 (inference-gateway-audit-2026-06-23): don't wake a stalled bee back onto a still-throttled pool.
      // (1) Honor the soonestResetAt the gateway computed — the arg used to be silently DROPPED. For an
      //     egress-class stall the gateway records a fabricated now+30s reset, so this is a real floor: never
      //     wake before it.
      if (soonestResetAt && Date.now() < soonestResetAt) return false;
      // (2) The gateway pool must NOT be wholesale-throttled. The old check only read the ACCOUNT's pausedUntil,
      //     so a fabricated 30s reset would wake the bee straight back into an all-accounts storm → re-stall →
      //     wake-cap burn → bee abandoned. The gateway /stats is the shared capacity oracle; unreachable ⇒ fall
      //     back to the per-account verdict (never strand a wake on a missing signal).
      const gw = await fetchGatewayHeadroom({ timeoutMs: 1000 }).catch(() => null);
      if (gw?.reachable && (gw.paused || gw.rejected)) return false; // whole pool throttled → keep waiting
      // (3) ...and the account itself must be able to SERVE: pause clear AND usage headroom.
      //     `available` is usage-aware as of WI-3310 (`!accountFull`): a weekly-usage-exhausted
      //     account whose bounded (≤6h) rate pause lapsed used to read available:true here, so the
      //     waker fired "rate limit recovered on avistorewolf.com" wakes for DAYS while the 7d
      //     window sat at 100% — the rate limit and the usage limit are different meters, and pause
      //     expiry is not usage recovery. When the account is usage-walled we log the REAL reset
      //     (once per account per wall, not per 20s tick) so the multi-day hold is visible, and hold.
      const rows = await accountStatus(workspaceId).catch(() => [] as Awaited<ReturnType<typeof accountStatus>>);
      const a = rows.find((x) => x.id === accountId);
      if (a?.usageWalled) {
        const until = a.usageResetAt;
        if ((usageWallLoggedUntil.get(accountId) ?? 0) !== (until ?? -1)) {
          usageWallLoggedUntil.set(accountId, until ?? -1);
          console.log(
            `[stall-waker] '${accountId}' is USAGE-walled (window exhausted${until ? `, resets ${new Date(until).toISOString()}` : ''}) — holding wakes until the usage window resets (a lapsed rate-limit pause is NOT usage recovery)`,
          );
        }
        return false;
      }
      return a ? a.available === true : true; // unknown account → trust the reset time we already waited out
    },
    unwedge: async (ownerId) => {
      // FAST UN-WEDGE (owner-requested 2026-06-23): ESC ONLY (no wake) — end the turn that died on a gateway
      // error so the wedged CLI re-arms its inbox-wake watch and can receive messages again immediately,
      // without waiting for the account's capacity to return.
      //
      // Root-cause fix (2026-07-01, gateway-mass-outage-storm-guard): forceEndTurn NEVER throws — a refusal
      // (storm-guard rate_limited) or a missing live session comes back as `{ok:false, error:...}`, a normal
      // return value. This used to be discarded (`await forceEndTurn(...)` with no result check), so
      // StallWaker.tick() always treated the attempt as a success even when NOTHING was delivered — exactly
      // what happened to every owner past the storm guard's per-actor cap during a correlated gateway outage.
      // Surface the real outcome so tick() can tell the difference and log it instead of lying about it.
      // FOCUS GUARD (gateway-rayobyte-hardening P-006): NEVER inject keystrokes into the session the
      // human is focused on right now — in the Claude Code TUI a stray Esc at the prompt (twice) opens
      // the rewind/restore picker (the 2026-07-01 accidental-conversation-restore). A focused human can
      // press Esc themselves; background/fleet windows stay auto-recoverable. Best-effort → false, so a
      // headless box behaves exactly as before.
      if (await isOwnerFocusedOnDesktop(ownerId).catch(() => false)) {
        console.log(`[stall-waker] unwedge(${ownerId}) skipped: session is the FOCUSED desktop window (human present — not injecting Esc)`);
        return { ok: false, expected: true };
      }
      const r = await forceEndTurn({ actor: 'stall-waker', workspaceId, owner: ownerId, reason: 'gateway error — ESC to re-arm (un-wedge)' });
      // `no_live_session` is the EXPECTED outcome (owner idle / already ended its turn — not wedged): non-
      // actionable and it recurs every cooldown, so surface it as `expected` and DON'T warn. A genuine refusal
      // (storm-guard rate-limit, SIGINT failure, etc.) still warns — a human may need to act on that.
      const expected = r.code === 'no_live_session';
      if (!r.ok && !expected) {
        console.warn(`[stall-waker] unwedge(${ownerId}) refused/failed: ${r.error ?? 'unknown'}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      return { ok: r.ok, expected };
    },
    wake: async (ownerId, summary) => {
      // ESC-THEN-WAKE (coord-end-turn P-003): a bee whose turn DIED on a rate limit is stuck mid-errored —
      // NOT sleeping on its inbox-wake key — so a bare wake lands woken:0. Force-ESC ends the dead turn first
      // (the CLI returns to idle + re-arms its watch), settle, THEN wake → a real fresh turn resumes on the
      // now-recovered account. Best-effort; the wake proceeds even if the ESC found no live pty.
      try {
        // FOCUS GUARD (P-006, same as unwedge): the coord wake MESSAGE below is always safe; only the
        // pre-wake Esc keystroke is withheld from the human's focused window.
        if (!(await isOwnerFocusedOnDesktop(ownerId).catch(() => false))) {
          await forceEndTurn({ actor: 'stall-waker', workspaceId, owner: ownerId, reason: summary });
          await new Promise((r) => setTimeout(r, ENDTURN_SETTLE_MS));
        }
      } catch {
        /* no live turn to end (already idle) → just wake */
      }
      const r = await wakeRecipients([ownerId], { summary, source: 'stall-waker', workspaceId });
      return { woken: r.woken };
    },
    now: () => Date.now(),
    log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[stall-waker] ${msg}`),
  };
}

let timer: ManagedHandle | null = null;
let waker: StallWaker | null = null;

/** Start the poll loop if not already running (idempotent — safe to call on every spawn). */
export function ensureStallWakerLoop(workspaceId: string): void {
  if (timer) return;
  waker = new StallWaker(createStallWakerDeps(workspaceId));
  timer = managedSetInterval('stall-waker-loop', POLL_MS, () => void waker!.tick(), { category: 'global-sweep' });
  console.log(`[stall-waker] started (poll ${POLL_MS}ms, idle ${IDLE_SILENCE_MS}ms) for ${workspaceId}`);
}

export function stopStallWakerLoop(): void {
  if (timer) timer.stop();
  timer = null;
  waker = null;
}
