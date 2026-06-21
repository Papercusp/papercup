/**
 * stall-waker-loop — wires the {@link StallWaker} to the LIVE gateway + coord + spawned_agents and runs it
 * on a poll loop (gateway-rate-limit-stall-autowake P-003). Idempotent + `unref`'d; started lazily from the
 * spawn path when the inference gateway is on (that's exactly when bees — and thus stalls — exist).
 */
import { StallWaker, type StallEvent, type StallWakerDeps } from './stall-waker';
import { gatewayPort } from './spawn-env';
import { getOrgPg } from '@papercusp/db-org';
import { getSpawnPg } from '../fleet/pg-stores';
import { accountStatus } from '../deployment/account-pool-store';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';

const POLL_MS = Number(process.env.PAPERCUSP_STALL_WAKER_POLL_MS) || 20_000;
/** A bee stream-silent this long is idle/sleeping (turn ended, waiting on its wake key) — NOT actively
 *  retrying. We only wake a CONFIRMED-idle bee, so we never interrupt one mid-recovery. */
const IDLE_SILENCE_MS = Number(process.env.PAPERCUSP_STALL_WAKER_IDLE_MS) || 30_000;

/** Build the real deps: gateway HTTP (stalls), spawned_agents (idle), account-pool (capacity), coord (wake). */
export function createStallWakerDeps(workspaceId: string): StallWakerDeps {
  const base = () => `http://127.0.0.1:${gatewayPort()}`;
  return {
    fetchStalls: async (since) => {
      const r = await fetch(`${base()}/admin/stalls?since=${since}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { now: Date.now(), stalls: [] };
      return (await r.json()) as { now: number; stalls: StallEvent[] };
    },
    beeIsIdle: async (ownerId) => {
      const node = await getSpawnPg(getOrgPg().sql, workspaceId, ownerId).catch(() => null);
      if (!node) return false; // gone/unknown → not a wake-able idle bee (a wake would woken:0 anyway)
      const lastOut = node.lastOutputAt ? new Date(node.lastOutputAt).getTime() : 0;
      // Alive but stream-silent past the threshold = the turn ended and the bee is sleeping, not retrying.
      return lastOut > 0 && Date.now() - lastOut > IDLE_SILENCE_MS;
    },
    capacityBack: async (accountId) => {
      const rows = await accountStatus(workspaceId).catch(() => [] as Awaited<ReturnType<typeof accountStatus>>);
      const a = rows.find((x) => x.id === accountId);
      return a ? a.available === true : true; // unknown account → trust the reset time we already waited out
    },
    wake: async (ownerId, summary) => {
      const r = await wakeRecipients([ownerId], { summary, source: 'stall-waker', workspaceId });
      return { woken: r.woken };
    },
    now: () => Date.now(),
    log: (level, msg) => (level === 'warn' ? console.warn : console.log)(`[stall-waker] ${msg}`),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let waker: StallWaker | null = null;

/** Start the poll loop if not already running (idempotent — safe to call on every spawn). */
export function ensureStallWakerLoop(workspaceId: string): void {
  if (timer) return;
  waker = new StallWaker(createStallWakerDeps(workspaceId));
  timer = setInterval(() => {
    void waker!.tick().catch((e) => console.warn(`[stall-waker] tick failed: ${e instanceof Error ? e.message : String(e)}`));
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[stall-waker] started (poll ${POLL_MS}ms, idle ${IDLE_SILENCE_MS}ms) for ${workspaceId}`);
}

export function stopStallWakerLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  waker = null;
}
