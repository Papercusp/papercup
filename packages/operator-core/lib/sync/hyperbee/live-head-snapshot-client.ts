/**
 * P-019 (D-012) — ask the LIVE operator that holds a hive's corestore to append a
 * fresh head `__snapshot__`, so a `--sparse` release cut can be taken with NO OUTAGE.
 *
 * Why this exists at all: `--sparse` ships only `[coreSparseFrom, len)`, and
 * `computeSparseFrom` finds that bound by scanning back `SNAPSHOT_SCAN_LOOKBACK`
 * (4,000) ops from the tail. So a head snapshot at the tail is a PRECONDITION of a
 * sparse cut. A quiesced cut appends it itself; the WI-4487 no-outage cut opens the
 * store READ-ONLY and cannot. Before this, "no outage" and "sparse" were mutually
 * exclusive, and the release either took an outage or shipped 1.9 GB labelled sparse.
 *
 * The transport reuses the discovery seam `schedule:inventory` federation already
 * relies on (`listSiblingOperators` over `~/.papercusp/endpoint-ipc.<port>.json`)
 * rather than a port map or a new registry: which process holds a given hive is not
 * knowable statically (the desktop sidecar, :3070, :3170 and bg-host all boot
 * harnesses), and a port→role table is exactly the thing that rots the first time a
 * port moves.
 *
 * TWO PASSES, deliberately. The real call is O(own-log) and stalls the holder's merge
 * loop for its duration, so it is never fanned out: a fast side-effect-free
 * `probeOnly` pass identifies the single holder, and only that one is asked to do the
 * expensive thing.
 */
import { Agent, type Dispatcher } from 'undici';
import { listSiblingOperators, type SiblingOperator } from '../../schedule-federation';

export const HEAD_SNAPSHOT_PATH = '/api/internal/substrate/head-snapshot';

// The AbortSignal below owns each request's deadline. Undici otherwise applies
// its independent five-minute headers timeout, which cuts a healthy long snapshot
// short even when the caller explicitly grants fifteen minutes.
const snapshotDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** Discovery deadline per sibling. A `probeOnly` answer is a memory-map lookup. */
export const DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS = 1_500;

/**
 * Deadline for the REAL request. Generous on purpose: the holder reads its entire own
 * log before appending, and a cut that gives up early leaves the operator still doing
 * the work while the cut degrades to a full seed — the worst of both. The caller owns
 * this budget because the engine deliberately does not impose one (a merge-pass failure
 * re-services the request on the next pass rather than rejecting), and the server route
 * sets `timeoutSec: null` specifically so it defers to this number instead of racing it.
 *
 * ⚠ THIS IS A FIXED BUDGET GUARDING AN O(corpus) OPERATION, AND THE CORPUS ONLY GROWS —
 * so it crosses its own threshold on a schedule. It already did once, and the failure
 * does NOT present as "too slow": it presents as a total outage with a misleading error
 * ("D-025 holder-without-boot"), pointing at the registry rather than at duration.
 *
 * MEASURED 2026-09-18, the real call in isolation against a healthy holder:
 *   elapsedMs 1,101,530 (18m21s), rowCount 1,416,510, chunkCount 1,044 — HTTP 200.
 * The budget was then 15 min (930,000 ms including retry delays), so the operation
 * needed 1.18x what it was allowed and was killed mid-flight on all four 0.0.21 cut
 * attempts while working correctly the entire time. The old 15 min was sized against
 * 461,475 blocks on 2026-08-03; the corpus had roughly TRIPLED in six weeks.
 *
 * 45 min is ~2.4x the measured need — real headroom, not a fresh guess at the same
 * shape. It is still a guess, and that is the actual defect: the durable fix is to SIZE
 * THIS FROM THE CORPUS (the `probeOnly` pass is already a cheap round-trip to the holder
 * and could return own-log length, letting the client compute a budget). Until that
 * lands, raising this constant only reschedules the outage — do not read it as fixed.
 */
export const DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS = 45 * 60_000;

/**
 * Gap between attempts. The failure being waited out is a process restart, so polling
 * faster buys nothing and just hammers a booting operator.
 */
export const DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS = 15_000;

/**
 * How long to keep RE-attempting after a holder fails to answer, before giving up.
 *
 * The budget is checked only after an attempt settles; it deliberately never truncates
 * an in-flight snapshot request. Therefore it must outlast one full real-call timeout
 * and the delay before the next attempt, or the timeout path reaches the budget guard
 * before a second attempt can start. Keep one extra delay interval as margin for the
 * discovery and clock overhead around that boundary.
 */
export const DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS =
  DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS + 2 * DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS;

/**
 * How often an in-flight snapshot asks whether the exact holder is still alive.
 *
 * A head snapshot can take minutes, so checking only before the POST is not enough:
 * the holder can disappear after discovery and leave the request burning the whole
 * retry budget before the caller gets a chance to discover its replacement.
 */
export const DEFAULT_HEAD_SNAPSHOT_HOLDER_LIVENESS_INTERVAL_MS = 5_000;

export interface LiveHeadSnapshotProduced {
  readonly kind: 'produced';
  readonly port: number;
  readonly pid: number;
  readonly process: string | null;
  readonly appended: boolean;
  readonly coversUpTo: number;
  readonly chunkCount: number;
  readonly rowCount: number;
  readonly elapsedMs: number;
  /** Present only when the request needed more than one attempt. */
  readonly retry?: HeadSnapshotRetryLog;
}

export interface LiveHeadSnapshotNoHolder {
  readonly kind: 'no-holder';
  /** Present only when the request needed more than one attempt. */
  readonly retry?: HeadSnapshotRetryLog;
  /** Ports that answered the discovery pass at all (a live sibling we could talk to). */
  readonly answered: readonly number[];
  /** Every operator-shaped sibling we found on the box, answering or not. */
  readonly probed: readonly number[];
  /**
   * Ports that are ALIVE and serving, but 404'd this route — i.e. their build PREDATES
   * P-019. Distinguished from a dead port on purpose: those two are the same
   * `__transportError` on the wire and used to be reported identically, as a port that
   * merely "did not answer".
   *
   * That collapse hid the single most likely real-world cause of a `no-holder` on a
   * healthy box, and it hid it in the most expensive direction. Measured 2026-08-04
   * (P-014, WI-10773): `papercup-bg-host` HELD the papercusp corestore write lock and
   * served every other internal route (`/api/internal/managed-timers` → 200), but had
   * started 9 minutes BEFORE the head-snapshot route file existed, so it 404'd this one
   * path. The refusal reported `probed 3070, 3170, 3270, 3271; answered 3070, 3270` and
   * said "no operator process here reports having booted" — which reads as "nothing on
   * this box holds the hive", the opposite of the truth. The holder was right there in
   * the probed list, indistinguishable from a dead socket, and the stated remedies
   * ("make sure the operator is healthy", "quiesce and re-run") were both wrong: the
   * operator WAS healthy, and the actual fix is to restart it onto post-P-019 code.
   *
   * The Hono host has no file-watch, so a long-lived holder keeps 404ing this route
   * until it restarts — this is a NORMAL post-deploy state, not an exotic one.
   */
  readonly staleBuild: readonly number[];
}

export interface LiveHeadSnapshotFailed {
  readonly kind: 'failed';
  readonly port: number;
  readonly error: string;
  /**
   * TRUE when the holder never answered (socket died, timed out, non-2xx) — i.e. the
   * request did not reach a working operator. FALSE when the operator ANSWERED and
   * refused (`ok:false`).
   *
   * The split exists because only one of them is worth retrying, and conflating them
   * costs a whole cut: a recycling holder must be waited out, whereas "this harness
   * engine is stopped/closing" is a real answer that will not change by asking again.
   */
  readonly transport: boolean;
  /** Present only when the request needed more than one attempt. */
  readonly retry?: HeadSnapshotRetryLog;
}

/**
 * How many attempts a retrying request burned, and how long it took.
 *
 * `waitedMs` is the SUM OF THE DELIBERATE SLEEPS between attempts — it excludes the time
 * spent actually IN each attempt (discovery + the real POST, which can itself run for
 * minutes; see DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS). `elapsedMs` is true wall-clock from the
 * first attempt to now and is always >= waitedMs. A caller narrating "how hard did we
 * try" wants `elapsedMs` — WI-37467 found `waitedMs` rendered as if it were elapsed and
 * reported "~15s of waiting" for a run that took 616s, because that run's time was spent
 * inside the attempts (a holder that answered slowly), not in the one 15s sleep between
 * them.
 */
export interface HeadSnapshotRetryLog {
  readonly attempts: number;
  readonly waitedMs: number;
  readonly elapsedMs: number;
}

export type LiveHeadSnapshotOutcome = LiveHeadSnapshotProduced | LiveHeadSnapshotNoHolder | LiveHeadSnapshotFailed;

interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal; headers: Record<string, string>; body: string; dispatcher?: Dispatcher },
) => Promise<ResponseLike>;

interface HeadSnapshotReply {
  ok?: unknown;
  booted?: unknown;
  process?: unknown;
  appended?: unknown;
  coversUpTo?: unknown;
  chunkCount?: unknown;
  rowCount?: unknown;
  elapsedMs?: unknown;
  error?: unknown;
}

async function post(
  fetchImpl: FetchLike,
  sibling: SiblingOperator,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HeadSnapshotReply | { __transportError: string; __status?: number }> {
  try {
    // The route declares `path: '/internal/substrate/head-snapshot'`; the host mounts
    // every route under `/api`, exactly as SIBLING_PROBE_PATH spells out for
    // managed-timers. HEAD_SNAPSHOT_PATH carries the prefix so this stays one string.
    const res = await fetchImpl(`http://127.0.0.1:${sibling.port}${HEAD_SNAPSHOT_PATH}`, {
      method: 'POST',
      dispatcher: snapshotDispatcher,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    // Keep the STATUS, not just a rendered string: a 404 here means "alive, but this
    // build predates the route" and is actionable in a way a dead socket is not.
    if (!res.ok) return { __transportError: `HTTP ${res.status}`, __status: res.status };
    return ((await res.json()) as HeadSnapshotReply) ?? {};
  } catch (e) {
    const cause = e instanceof Error ? e.cause : undefined;
    const detail = cause instanceof Error ? `${'code' in cause ? `${String(cause.code)}: ` : ''}${cause.message}` : '';
    return { __transportError: `${e instanceof Error ? e.message : String(e)}${detail ? ` (${detail})` : ''}` };
  }
}

function isTransportError(r: unknown): r is { __transportError: string } {
  return !!r && typeof r === 'object' && '__transportError' in r;
}

export interface HiveHolderFound {
  readonly kind: 'holder';
  readonly sibling: SiblingOperator;
}
export type FindHiveHolderOutcome = HiveHolderFound | LiveHeadSnapshotNoHolder;

/**
 * Which operator-shaped process on this box has `(workspaceId, hive)` BOOTED?
 *
 * Cheap and side-effect-free by construction (`probeOnly`), which is what lets the
 * release cut ask this question BEFORE it mutates anything. That ordering is not a
 * micro-optimisation: `backfillLocalState` INSERTs into `substrate_outbox`, and P-014
 * established that a cut which cannot possibly produce a sparse seed must refuse
 * BEFORE leaving rows enqueued for it. Rolling discovery into the expensive request
 * would have quietly given that invariant back.
 *
 * NEVER throws — an unreachable or broken sibling is simply not a holder.
 */
export async function findLiveOperatorHoldingHive(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly warn?: (msg: string) => void;
}): Promise<FindHiveHolderOutcome> {
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  const fetchImpl = (inp.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
  const listSiblings = inp.listSiblingsImpl ?? listSiblingOperators;

  // selfPort: -1 — the CUTTER is a CLI, not an operator, so it serves no port and must
  // exclude NOTHING. The default (`ownHonoPort()`, which falls back to 3070) would
  // silently skip the release operator, i.e. the single most likely holder, and the
  // symptom would be an unexplained `no-holder` on a perfectly healthy box.
  const siblings = await listSiblings({ selfPort: -1 });
  const probed = siblings.map((s) => s.port);
  if (siblings.length === 0) {
    return { kind: 'no-holder', answered: [], probed, staleBuild: [] };
  }

  const probeTimeoutMs = inp.probeTimeoutMs ?? DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS;
  const probes = await Promise.all(
    siblings.map(async (s) => ({
      sibling: s,
      reply: await post(
        fetchImpl,
        s,
        { workspaceId: inp.workspaceId, hive: inp.hive, probeOnly: true },
        probeTimeoutMs,
      ),
    })),
  );

  const answered = probes.filter((p) => !isTransportError(p.reply)).map((p) => p.sibling.port);
  // A 404 on THIS path from a process that is otherwise serving = a build predating the
  // route. Reported separately because the remedy is specific (restart that process) and
  // is NOT any of the remedies a plain "did not answer" suggests.
  const staleBuild = probes
    .filter((p) => isTransportError(p.reply) && p.reply.__status === 404)
    .map((p) => p.sibling.port);
  const holders = probes.filter((p) => !isTransportError(p.reply) && p.reply.booted === true);
  if (holders.length === 0) {
    return { kind: 'no-holder', answered, probed, staleBuild };
  }
  if (holders.length > 1) {
    // Only one process can hold the corestore write lock, so this should be
    // unreachable. Say so loudly rather than picking silently — a second "holder" means
    // an assumption this whole mechanism rests on has broken.
    warn(
      `[head-snapshot] ${holders.length} processes claim to hold ${inp.workspaceId}::${inp.hive} ` +
        `(ports ${holders.map((h) => h.sibling.port).join(', ')}) — only one can hold the corestore ` +
        'write lock. Using the lowest port; investigate.',
    );
  }
  return { kind: 'holder', sibling: holders[0]!.sibling };
}

/**
 * {@link findLiveOperatorHoldingHive}, but WAITS for a holder to appear instead of
 * answering from one instantaneous look.
 *
 * Discovery is side-effect-free (`probeOnly`), so waiting costs nothing but time — and a
 * one-shot look is wrong for the two states this box is in most often (P-014, 2026-08-09):
 *   • a holder mid-recycle has no booted hive for a few seconds; and
 *   • a JUST-restarted holder owns the fd lock while its `getBootedHarness` LRU is still
 *     cold, so every port answers `booted:false` (D-025) — which is indistinguishable
 *     from "nothing on this box holds this hive", and steers to the OUTAGE remedy.
 *
 * Kept separate from `findLiveOperatorHoldingHive` rather than folded into it: the
 * snapshot request runs its OWN retry around a full discovery+POST cycle, and a retry
 * nested inside a retry would multiply budgets that each look bounded on their own.
 */
export async function waitForLiveOperatorHoldingHive(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly retryBudgetMs?: number;
  readonly retryDelayMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly findHolderImpl?: typeof findLiveOperatorHoldingHive;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly nowImpl?: () => number;
  readonly warn?: (msg: string) => void;
}): Promise<FindHiveHolderOutcome> {
  const budgetMs = inp.retryBudgetMs ?? DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS;
  const delayMs = inp.retryDelayMs ?? DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS;
  const now = inp.nowImpl ?? Date.now;
  const sleep = inp.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const find = inp.findHolderImpl ?? findLiveOperatorHoldingHive;

  const startedAt = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const found = await find(inp);
    if (found.kind === 'holder') {
      if (attempts > 1) {
        inp.warn?.(
          `[head-snapshot] a holder for ${inp.workspaceId}::${inp.hive} appeared on attempt ` +
            `${attempts} after ~${now() - startedAt}ms — the earlier miss was a recycle, not an absence.`,
        );
      }
      return found;
    }
    // No operator-shaped process on this box AT ALL is a real absence, not a recycle —
    // nothing is coming back, so waiting the full budget would just delay a correct
    // refusal by ten minutes (a CI box, or a cut run somewhere the operator never runs).
    // A sibling that was PROBED but did not answer is the opposite case: that is what a
    // restarting holder looks like, so those are worth waiting out.
    if (found.probed.length === 0) return found;
    if (now() - startedAt + delayMs > budgetMs) {
      if (attempts > 1) {
        inp.warn?.(
          `[head-snapshot] no holder for ${inp.workspaceId}::${inp.hive} after ${attempts} ` +
            `attempts over ${now() - startedAt}ms — this is a real absence, not a recycle window.`,
        );
      }
      return found;
    }
    await sleep(delayMs);
  }
}

/**
 * Find the operator process holding `(workspaceId, hive)` and have it append a fresh
 * head snapshot. NEVER throws: every failure is a typed outcome, because the caller
 * (a release cut) must be able to degrade deliberately rather than die mid-cut.
 *
 * Re-runs discovery rather than taking a holder the caller found earlier — on purpose.
 * The cut probes once up-front (before mutating) and calls this AFTER a drain that can
 * legitimately run for minutes, and the operator is recycled every ~12 min by the
 * watchdog. The holder at the end of the drain is the only one whose answer means
 * anything.
 *
 * RETRIES across that recycle (P-014, 2026-08-09). Re-running discovery per attempt was
 * necessary but NOT sufficient: it makes each attempt ask the right process, while a
 * recycle landing between the probe and the POST still killed the whole cut on the first
 * transport error. Measured on this box, the holder's typical lifetime (~8.5 min) is
 * HALF the drain this call sits behind (~17.4 min), so "launch into a booted window" can
 * never carry a cut to completion — the window is structurally too short. Waiting the
 * recycle out is the only thing that closes it. See DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS.
 *
 * Retries only what a restart can actually fix — a transport failure, or a `no-holder`
 * (a freshly-recycled process holds the fd lock while its `getBootedHarness` LRU is
 * still cold, which reads as "nobody has this hive"). An operator that ANSWERED and
 * refused is a real answer and returns immediately.
 *
 * Retrying is safe against double-append: the reader resolves the sparse start with
 * `findLatestCompleteSnapshot`, so a second snapshot supersedes the first — and, being
 * later, trims MORE history rather than less.
 */
export async function requestLiveOperatorHeadSnapshot(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly timeoutMs?: number;
  /** Total time to keep re-attempting. 0 disables retry (one shot). */
  readonly retryBudgetMs?: number;
  readonly retryDelayMs?: number;
  /** How often to re-check the discovered holder while the POST is in flight. */
  readonly holderLivenessIntervalMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly nowImpl?: () => number;
  readonly warn?: (msg: string) => void;
}): Promise<LiveHeadSnapshotOutcome> {
  const budgetMs = inp.retryBudgetMs ?? DEFAULT_HEAD_SNAPSHOT_RETRY_BUDGET_MS;
  const delayMs = inp.retryDelayMs ?? DEFAULT_HEAD_SNAPSHOT_RETRY_DELAY_MS;
  const now = inp.nowImpl ?? Date.now;
  const sleep = inp.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startedAt = now();
  let attempts = 0;
  let waitedMs = 0;
  let last: LiveHeadSnapshotOutcome | null = null;

  for (;;) {
    attempts += 1;
    const outcome = await attemptHeadSnapshot(inp);
    // Only a restart-shaped failure is worth waiting out; a refusal is a real answer.
    const retryable = outcome.kind === 'no-holder' || (outcome.kind === 'failed' && outcome.transport);
    if (!retryable) {
      return attempts > 1 ? withRetryLog(outcome, { attempts, waitedMs, elapsedMs: now() - startedAt }) : outcome;
    }
    last = outcome;

    // Budget governs when we stop STARTING attempts — it never truncates an in-flight
    // one. The real call can legitimately run for minutes (it reads the whole own log),
    // and cutting that short would abandon work the operator is still doing.
    if (now() - startedAt + delayMs > budgetMs) {
      inp.warn?.(
        `[head-snapshot] giving up after ${attempts} attempt(s) over ${now() - startedAt}ms — ` +
          `the holder never came back within the ${budgetMs}ms retry budget.`,
      );
      return attempts > 1 ? withRetryLog(last, { attempts, waitedMs, elapsedMs: now() - startedAt }) : last;
    }

    inp.warn?.(
      `[head-snapshot] attempt ${attempts} did not land (${describeOutcome(outcome)}) — the holder ` +
        `is most likely mid-recycle; retrying in ${delayMs}ms ` +
        `(${Math.max(0, budgetMs - (now() - startedAt))}ms of budget left).`,
    );
    await sleep(delayMs);
    waitedMs += delayMs;
  }
}

function describeOutcome(o: LiveHeadSnapshotOutcome): string {
  if (o.kind === 'no-holder') return `no booted holder among [${o.probed.join(', ')}]`;
  if (o.kind === 'failed') return `port ${o.port}: ${o.error}`;
  return 'produced';
}

function withRetryLog(o: LiveHeadSnapshotOutcome, retry: HeadSnapshotRetryLog): LiveHeadSnapshotOutcome {
  return { ...o, retry } as LiveHeadSnapshotOutcome;
}

/** ONE discovery + request cycle. The retry policy lives in the caller above. */
async function attemptHeadSnapshot(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly holderLivenessIntervalMs?: number;
  readonly warn?: (msg: string) => void;
}): Promise<LiveHeadSnapshotOutcome> {
  const fetchImpl = (inp.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
  const found = await findLiveOperatorHoldingHive(inp);
  if (found.kind !== 'holder') return found;
  const holder = found.sibling;

  // A full snapshot can occupy the holder for minutes. Watch the identity we
  // discovered while the POST is in flight so a dead/replaced holder becomes a
  // normal retryable transport failure instead of consuming the whole retry budget.
  const requestController = new AbortController();
  const stopWatching = watchHolderLiveness({
    ...inp,
    holder,
    onLost: (replacement) => {
      inp.warn?.(
        `[head-snapshot] holder ${holder.pid}@${holder.port} disappeared while the snapshot ` +
          `request was in flight (${describeHolderLoss(replacement, holder)}); aborting to retry.`,
      );
      requestController.abort();
    },
  });

  let reply: Awaited<ReturnType<typeof post>>;
  try {
    reply = await post(
      fetchImpl,
      holder,
      { workspaceId: inp.workspaceId, hive: inp.hive },
      inp.timeoutMs ?? DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS,
      requestController.signal,
    );
  } finally {
    stopWatching();
  }
  if (isTransportError(reply)) {
    return { kind: 'failed', port: holder.port, error: reply.__transportError, transport: true };
  }
  if (reply.ok !== true) {
    return {
      kind: 'failed',
      port: holder.port,
      error: typeof reply.error === 'string' ? reply.error : 'operator reported ok:false',
      transport: false,
    };
  }
  return {
    kind: 'produced',
    port: holder.port,
    pid: holder.pid,
    process: typeof reply.process === 'string' ? reply.process : null,
    appended: reply.appended === true,
    coversUpTo: Number(reply.coversUpTo) || 0,
    chunkCount: Number(reply.chunkCount) || 0,
    rowCount: Number(reply.rowCount) || 0,
    elapsedMs: Number(reply.elapsedMs) || 0,
  };
}

function sameHolder(a: SiblingOperator, b: SiblingOperator): boolean {
  return a.port === b.port && a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * OS-level liveness for the exact process the endpoint registry identified.
 *
 * A head snapshot deliberately occupies the holder for minutes. Requiring that
 * same busy process to answer another short HTTP request in order to prove it is
 * alive creates a circular failure: the work we are waiting for makes the probe
 * miss its deadline, and the missed probe aborts the work. The per-port endpoint
 * registry already gives us a PID + boot identity, so the watcher below checks
 * that identity directly instead.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM still proves that a process with this PID exists.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function describeHolderLoss(found: FindHiveHolderOutcome, previous: SiblingOperator): string {
  if (found.kind === 'holder') {
    return (
      `a replacement holder is ${found.sibling.pid}@${found.sibling.port} ` +
      `(previously ${previous.pid}@${previous.port})`
    );
  }
  return found.probed.length === 0
    ? 'no operator-shaped sibling remains'
    : `no matching holder among [${found.probed.join(', ')}]`;
}

/**
 * Monitor one specific holder until the request completes or its process identity
 * changes. This deliberately reads the endpoint PROCESS registry instead of calling
 * `findLiveOperatorHoldingHive`: the latter asks the busy holder to answer a 1.5s
 * HTTP probe, while the O(own-log) snapshot is documented to make that same event
 * loop unresponsive for minutes. A slow probe is not evidence that the process died.
 *
 * The timer is intentionally local to this long-lived HTTP request; it is not a
 * datastore polling loop, and it stops as soon as the POST settles.
 */
function watchHolderLiveness(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly holder: SiblingOperator;
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly holderLivenessIntervalMs?: number;
  readonly onLost: (found: FindHiveHolderOutcome) => void;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const intervalMs = inp.holderLivenessIntervalMs ?? DEFAULT_HEAD_SNAPSHOT_HOLDER_LIVENESS_INTERVAL_MS;
  const listSiblings = inp.listSiblingsImpl ?? listSiblingOperators;

  const scheduleNext = (): void => {
    timer = setTimeout(() => {
      void check().catch(() => {
        // Registry read failure is UNKNOWN, never proof the holder died. The real
        // request is independently bounded; keep watching rather than aborting it.
        if (!stopped) scheduleNext();
      });
    }, intervalMs);
  };

  const check = async (): Promise<void> => {
    if (stopped) return;
    const siblings = await listSiblings({ selfPort: -1 });
    if (stopped) return;

    const exact = siblings.find((s) => sameHolder(s, inp.holder));
    if (exact) {
      scheduleNext();
      return;
    }

    // A per-port discovery file can be briefly unreadable while another process
    // rewrites/prunes the registry. If the original PID still exists and no new
    // process has claimed its port, that is uncertainty — not holder death. Let the
    // real POST's own 15-minute deadline remain authoritative and check again.
    const replacement = siblings.find((s) => s.port === inp.holder.port);
    if (!replacement && pidAlive(inp.holder.pid)) {
      scheduleNext();
      return;
    }

    const found: FindHiveHolderOutcome = replacement
      ? { kind: 'holder', sibling: replacement }
      : {
          kind: 'no-holder',
          answered: [],
          probed: siblings.map((s) => s.port),
          staleBuild: [],
        };
    stopped = true;
    inp.onLost(found);
  };

  scheduleNext();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
