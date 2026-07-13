/**
 * voice-node/local-whisper-service — operator-managed whisper-server CHILD process
 * (voice-public-release-readiness-2026-07-12 P-009 hop 3, WI-4449).
 *
 * Public users have no voicemode install and no systemd unit — the operator itself is the
 * natural, CROSS-PLATFORM supervisor for the provisioned whisper-server (provisioner/
 * whisper-binary.ts): spawn on first STT need, health-gate before use, reap on operator exit.
 * The dev box (or any box already running an external whisper on VOICEMODE_URL, e.g. the live
 * voicemode-whisper unit) is untouched: `ensureLocalWhisper` probes the external URL FIRST and
 * stands down when it answers.
 *
 * Deliberate boundaries:
 *   - CACHE-ONLY: uses `findCachedWhisperBinary` + `resolveWhisperModel` (both fs-only) —
 *     this module NEVER downloads or builds. The explicit provision step (the settings /
 *     wizard "install local voice" action) populates the cache; an un-provisioned box gets a
 *     clean `not-provisioned` reason, not a surprise 150MB download on a PTT press.
 *   - No auto-respawn loop: a crashed child flips state to 'stopped' and the NEXT ensure()
 *     re-spawns (bounded by MAX_SPAWNS_PER_WINDOW so a crash-looping binary can't spawn-storm
 *     — the WI-4221 lesson, applied preemptively).
 *   - Spawns on a dedicated LOCAL port (default 2022 to match the VOICEMODE_URL seam; an
 *     external server on that port is detected before any spawn, so no bind conflict).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  findCachedWhisperBinary,
  resolveWhisperModel,
  renderWhisperServerArgs,
  whisperPlatformSpec,
  WHISPER_SERVER_DEFAULT_PORT,
  type WhisperModelId,
} from '../provisioner/whisper-binary';
import { platformKeyFor } from '../provisioner/llama-binary';
import { detectHardware, type DetectedHardware } from '../provisioner/hardware-detect';

export type LocalWhisperSource = 'external' | 'managed';

export interface EnsureWhisperResult {
  ok: boolean;
  /** Base URL serving /v1/audio/transcriptions when ok. */
  url?: string;
  source?: LocalWhisperSource;
  /** Machine-readable reason when !ok: 'not-provisioned' (binary/model missing — run the
   *  provision step), 'spawn-failed', 'unhealthy' (spawned but never answered), 'spawn-storm'. */
  reason?: 'not-provisioned' | 'spawn-failed' | 'unhealthy' | 'spawn-storm';
  detail?: string;
}

export interface LocalWhisperDeps {
  home?: string;
  /** External whisper base URL probed before any spawn. Default: the VOICEMODE_URL seam. */
  externalUrl?: string;
  port?: number;
  model?: WhisperModelId;
  detectHw?: () => Promise<DetectedHardware>;
  probe?: (baseUrl: string) => Promise<boolean>;
  spawnFn?: typeof spawn;
  /** Health-wait tuning (tests shrink these). */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  now?: () => number;
}

interface ManagedState {
  child: ChildProcess | null;
  url: string | null;
  starting: Promise<EnsureWhisperResult> | null;
  spawnTimes: number[];
}

const MAX_SPAWNS_PER_WINDOW = 3;
const SPAWN_WINDOW_MS = 5 * 60 * 1000;

// Module-singleton on purpose: ONE managed whisper child per operator process, whichever
// route asks first (same posture as the voice bus / audio socket singletons in this dir).
const state: ManagedState = { child: null, url: null, starting: null, spawnTimes: [] };

async function defaultProbe(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Test hook: forget the managed child WITHOUT killing it (unit tests own their fakes). */
export function __resetLocalWhisperStateForTests(): void {
  state.child = null;
  state.url = null;
  state.starting = null;
  state.spawnTimes = [];
}

/** Stop the managed child (operator shutdown / settings "disable local voice"). Idempotent. */
export async function stopLocalWhisper(): Promise<void> {
  const child = state.child;
  state.child = null;
  state.url = null;
  if (child && child.exitCode === null && !child.killed) {
    // Register the exit-wait BEFORE kill — a child that exits synchronously on kill (fakes in
    // tests; a fast real exit) would otherwise strand the wait until the timeout fallback.
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    // Bounded wait — whisper-server exits promptly on SIGTERM; don't hang shutdown on it.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
  }
}

/**
 * Ensure a whisper STT endpoint is available, spawning the provisioned server if needed.
 * Concurrent callers coalesce onto one in-flight start (no double-spawn on a burst of PTT
 * requests). Never throws.
 */
export async function ensureLocalWhisper(deps: LocalWhisperDeps = {}): Promise<EnsureWhisperResult> {
  const probe = deps.probe ?? defaultProbe;
  const externalUrl = deps.externalUrl ?? (process.env.VOICEMODE_URL ?? 'http://localhost:2022');

  // 1. An external server (dev-box voicemode, a user's own install) always wins — zero spawns.
  if (await probe(externalUrl)) return { ok: true, url: externalUrl, source: 'external' };

  // 2. Already-managed child still healthy?
  if (state.child && state.child.exitCode === null && state.url) {
    if (await probe(state.url)) return { ok: true, url: state.url, source: 'managed' };
    // Unresponsive child — treat as dead, reap, and fall through to a fresh spawn.
    await stopLocalWhisper();
  } else if (state.child && state.child.exitCode !== null) {
    state.child = null;
    state.url = null;
  }

  // 3. Coalesce concurrent starts.
  if (state.starting) return state.starting;
  state.starting = startManaged(deps, probe);
  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

/**
 * The STT call sites' one-liner: the base URL to POST /v1/audio/transcriptions at.
 *
 * HOT PATH — this runs once per utterance, so it does NO I/O: it is a pure read of the
 * lifecycle state (a live managed child → its URL; otherwise the external URL, which is
 * also the not-provisioned fallback, so an unreachable whisper fails with exactly the same
 * surface it had before this module existed).
 *
 * It deliberately does NOT call ensureLocalWhisper: that probes over HTTP, and doing so here
 * added a full round-trip to EVERY transcription (caught by agent-peer.test.ts's "one fetch
 * per transcription" contract — the test was right and the first cut of this function was
 * wrong). The managed child is started by `warmLocalWhisper()` at the lifecycle moments that
 * actually mean "voice is about to be used" — enabling voice mode, and finishing the local
 * install — never on the utterance path.
 */
export function whisperSttBaseUrl(deps: LocalWhisperDeps = {}): string {
  if (state.child && state.child.exitCode === null && state.url) return state.url;
  return deps.externalUrl ?? (process.env.VOICEMODE_URL ?? 'http://localhost:2022');
}

/**
 * Lifecycle warm-up: bring a whisper endpoint up (external probe → managed child spawn) so the
 * FIRST utterance already has one. Fire-and-forget by design — callers are lifecycle events
 * (voice-mode enable, install completion), never the request path, and a failure here just
 * means the STT call falls back to the external URL and surfaces the usual unreachable error.
 */
export async function warmLocalWhisper(deps: LocalWhisperDeps = {}): Promise<EnsureWhisperResult> {
  return ensureLocalWhisper(deps);
}

async function startManaged(deps: LocalWhisperDeps, probe: (u: string) => Promise<boolean>): Promise<EnsureWhisperResult> {
  const now = deps.now ?? Date.now;
  // Spawn-storm guard: a binary that boots-then-dies must not respawn unboundedly.
  state.spawnTimes = state.spawnTimes.filter((t) => now() - t < SPAWN_WINDOW_MS);
  if (state.spawnTimes.length >= MAX_SPAWNS_PER_WINDOW) {
    return { ok: false, reason: 'spawn-storm', detail: `${MAX_SPAWNS_PER_WINDOW} spawns in ${SPAWN_WINDOW_MS / 60000}min — refusing to spawn-loop a failing whisper-server` };
  }

  const detectHw = deps.detectHw ?? detectHardware;
  const hw = await detectHw();
  const platformKey = platformKeyFor(whisperPlatformSpec(hw));
  const cached = await findCachedWhisperBinary({ home: deps.home, platformKey });
  if (!cached) {
    return { ok: false, reason: 'not-provisioned', detail: `no provisioned whisper-server for ${platformKey} — run the local-voice install step` };
  }
  const modelPlan = await resolveWhisperModel(deps.model, { home: deps.home });
  if (modelPlan.needsDownload || !modelPlan.weightsPath) {
    return { ok: false, reason: 'not-provisioned', detail: modelPlan.detail };
  }

  const port = deps.port ?? WHISPER_SERVER_DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  const args = renderWhisperServerArgs({ modelPath: modelPlan.weightsPath, port });
  const spawnFn = deps.spawnFn ?? spawn;

  state.spawnTimes.push(now());
  let child: ChildProcess;
  try {
    child = spawnFn(cached.binPath, args, { stdio: 'ignore', detached: false });
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', detail: e instanceof Error ? e.message : String(e) };
  }
  const spawnError: Promise<EnsureWhisperResult> = new Promise((resolve) => {
    child.once('error', (e) => resolve({ ok: false, reason: 'spawn-failed', detail: e.message }));
  });
  child.on('exit', () => {
    if (state.child === child) {
      state.child = null;
      state.url = null;
    }
  });

  // Health-gate: the model load takes ~1s (base) — poll until it answers or time out.
  const timeoutMs = deps.healthTimeoutMs ?? 15_000;
  const intervalMs = deps.healthIntervalMs ?? 500;
  const deadline = now() + timeoutMs;
  const healthy: Promise<EnsureWhisperResult> = (async () => {
    while (now() < deadline) {
      if (child.exitCode !== null) {
        return { ok: false, reason: 'spawn-failed' as const, detail: `whisper-server exited ${child.exitCode} during startup` };
      }
      if (await probe(url)) {
        state.child = child;
        state.url = url;
        return { ok: true, url, source: 'managed' as const };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    child.kill('SIGTERM');
    return { ok: false, reason: 'unhealthy' as const, detail: `whisper-server did not answer /v1/models within ${timeoutMs}ms` };
  })();

  return Promise.race([healthy, spawnError]);
}
