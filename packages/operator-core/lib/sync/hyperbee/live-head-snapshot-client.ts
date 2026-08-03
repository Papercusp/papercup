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
import { listSiblingOperators, type SiblingOperator } from '../../schedule-federation';

export const HEAD_SNAPSHOT_PATH = '/api/internal/substrate/head-snapshot';

/** Discovery deadline per sibling. A `probeOnly` answer is a memory-map lookup. */
export const DEFAULT_HEAD_SNAPSHOT_PROBE_TIMEOUT_MS = 1_500;

/**
 * Deadline for the REAL request. Generous on purpose: the holder reads its entire own
 * log (461,475 blocks on this box as of 2026-08-03) before appending, and a cut that
 * gives up early leaves the operator still doing the work while the cut degrades to a
 * full seed — the worst of both. The caller owns this budget because the engine
 * deliberately does not impose one (a merge-pass failure re-services the request on
 * the next pass rather than rejecting).
 */
export const DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS = 15 * 60_000;

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
}

export interface LiveHeadSnapshotNoHolder {
  readonly kind: 'no-holder';
  /** Ports that answered the discovery pass at all (a live sibling we could talk to). */
  readonly answered: readonly number[];
  /** Every operator-shaped sibling we found on the box, answering or not. */
  readonly probed: readonly number[];
}

export interface LiveHeadSnapshotFailed {
  readonly kind: 'failed';
  readonly port: number;
  readonly error: string;
}

export type LiveHeadSnapshotOutcome =
  | LiveHeadSnapshotProduced
  | LiveHeadSnapshotNoHolder
  | LiveHeadSnapshotFailed;

interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal; headers: Record<string, string>; body: string },
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
): Promise<HeadSnapshotReply | { __transportError: string }> {
  try {
    // The route declares `path: '/internal/substrate/head-snapshot'`; the host mounts
    // every route under `/api`, exactly as SIBLING_PROBE_PATH spells out for
    // managed-timers. HEAD_SNAPSHOT_PATH carries the prefix so this stays one string.
    const res = await fetchImpl(`http://127.0.0.1:${sibling.port}${HEAD_SNAPSHOT_PATH}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { __transportError: `HTTP ${res.status}` };
    return ((await res.json()) as HeadSnapshotReply) ?? {};
  } catch (e) {
    return { __transportError: e instanceof Error ? e.message : String(e) };
  }
}

function isTransportError(r: unknown): r is { __transportError: string } {
  return !!r && typeof r === 'object' && '__transportError' in r;
}

/**
 * Find the operator process holding `(workspaceId, hive)` and have it append a fresh
 * head snapshot. NEVER throws: every failure is a typed outcome, because the caller
 * (a release cut) must be able to degrade deliberately rather than die mid-cut.
 */
export async function requestLiveOperatorHeadSnapshot(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly probeTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly listSiblingsImpl?: typeof listSiblingOperators;
  readonly warn?: (msg: string) => void;
}): Promise<LiveHeadSnapshotOutcome> {
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
    return { kind: 'no-holder', answered: [], probed };
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
  const holders = probes.filter((p) => !isTransportError(p.reply) && p.reply.booted === true);
  if (holders.length === 0) {
    return { kind: 'no-holder', answered, probed };
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
  const holder = holders[0]!.sibling;

  const reply = await post(
    fetchImpl,
    holder,
    { workspaceId: inp.workspaceId, hive: inp.hive },
    inp.timeoutMs ?? DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS,
  );
  if (isTransportError(reply)) {
    return { kind: 'failed', port: holder.port, error: reply.__transportError };
  }
  if (reply.ok !== true) {
    return {
      kind: 'failed',
      port: holder.port,
      error: typeof reply.error === 'string' ? reply.error : 'operator reported ok:false',
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
