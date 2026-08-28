/**
 * voice-node/local-voice-provision — the explicit "install local voice" orchestrator
 * (voice-public-release-readiness-2026-07-12 P-009 hop 3/4, plan decision + D-009, WI-4449).
 *
 * ONE user action provisions everything local voice needs, download-on-first-enable:
 *   - whisper-server binary  (provisioner/whisper-binary.ts — GH release / source build)
 *   - whisper ggml model     (~148MB, HF mirror)
 *   - kokoro TTS model       (~90MB q8 + voices, in-process kokoro-js)
 *
 * Long-running (minutes on a slow link), so the API shape is kick-off + poll:
 * `startLocalVoiceProvision()` fires the async task (single-flight; concurrent calls
 * coalesce) and `getLocalVoiceProvisionStatus()` is the cheap poll the settings UI reads
 * (folded into the voice-engine-health route). Every failure lands in the status as a
 * per-leg `blocked` string — never a throw, never a half-written cache (each leg's own
 * module guarantees verify-before-trust).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectHardware } from '../provisioner/hardware-detect';
import {
  resolveWhisperBinary,
  resolveWhisperModel,
  downloadWhisperModel,
  findCachedWhisperBinary,
  whisperPlatformSpec,
} from '../provisioner/whisper-binary';
import { platformKeyFor } from '../provisioner/llama-binary';
import { isKokoroLocalProvisioned, provisionKokoroLocal } from './kokoro-local';
import { warmLocalWhisper } from './local-whisper-service';

const execFileAsync = promisify(execFile);

/** The user-level units shipped by the legacy Voicemode installer. */
export const LEGACY_VOICE_UNITS = {
  whisper: 'voicemode-whisper.service',
  kokoro: 'voicemode-kokoro.service',
} as const;

export interface LegStatus {
  done: boolean;
  blocked?: string;
}

export interface LocalVoiceProvisionStatus {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  whisperBinary: LegStatus;
  whisperModel: LegStatus;
  kokoro: LegStatus;
}

export interface LegacyVoiceUnitResult {
  unit: string;
  ok: boolean;
  action: 'disabled' | 'already-absent' | 'retained' | 'failed' | 'unsupported';
  detail?: string;
}

export interface LegacyVoiceReconcileResult {
  whisper: LegacyVoiceUnitResult;
  kokoro: LegacyVoiceUnitResult;
}

export interface LegacyVoiceReconcileDeps {
  /** Injectable `systemctl` seam; defaults to a bounded `execFile`. */
  runSystemctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Tests can force the platform branch; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Retire the compatibility Kokoro unit too. Default false: retain it as an accelerator. */
  retireKokoro?: boolean;
}

export interface LocalVoiceProvisionDeps {
  home?: string;
  now?: () => string;
  /** Leg injections for tests. */
  provisionWhisperBinary?: () => Promise<LegStatus>;
  provisionWhisperModel?: () => Promise<LegStatus>;
  provisionKokoro?: () => Promise<LegStatus>;
  /** Injected for tests; defaults to warmLocalWhisper (spawn the server once the files land). */
  warmWhisper?: () => Promise<unknown>;
  /** Injected systemd seam for the legacy-unit reconciliation. */
  runSystemctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Override the hardware probe used by the idle disk refresh. */
  detectHw?: () => Promise<Awaited<ReturnType<typeof detectHardware>>>;
}

let current: LocalVoiceProvisionStatus = {
  running: false,
  whisperBinary: { done: false },
  whisperModel: { done: false },
  kokoro: { done: false },
};
let inflight: Promise<LocalVoiceProvisionStatus> | null = null;
// Fully injected leg functions are unit-test seams, not durable installers. Keep their result
// in-memory so a hermetic test (or an embedding caller intentionally supplying its own legs) is
// not overwritten by an unrelated empty real-home cache read. The production/default path always
// refreshes exact disk truth.
let refreshDiskOnIdle = true;

async function defaultSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync('systemctl', args, { timeout: 15_000 });
  return { stdout: r.stdout, stderr: r.stderr };
}

function absentLegacyUnit(error: unknown): boolean {
  return /not found|not loaded|no such file|could not be found|not installed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function disableLegacyUnit(
  unit: string,
  runSystemctl: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<LegacyVoiceUnitResult> {
  try {
    await runSystemctl(['--user', 'disable', '--now', unit]);
    return { unit, ok: true, action: 'disabled', detail: 'disabled and stopped; operator-managed local voice is canonical' };
  } catch (error) {
    if (absentLegacyUnit(error)) {
      return { unit, ok: true, action: 'already-absent', detail: 'legacy unit is not installed' };
    }
    return { unit, ok: false, action: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Reconcile the old per-user Voicemode units with the single operator-owned lifecycle.
 *
 * Whisper's old unit points at a deleted script and therefore enters a permanent 203/EXEC
 * restart loop. It is never a supported second owner, so every explicit local-voice provision
 * pass disables/stops it (idempotently). Kokoro is retained by default as a developer-host
 * compatibility accelerator; callers that have proven the in-process fallback and want a fully
 * retired legacy stack can pass `retireKokoro:true`. Errors are returned as data so a systemd
 * outage cannot make model provisioning report a false failure.
 */
export async function reconcileLegacyVoiceServices(
  deps: LegacyVoiceReconcileDeps = {},
): Promise<LegacyVoiceReconcileResult> {
  if ((deps.platform ?? process.platform) !== 'linux') {
    return {
      whisper: { unit: LEGACY_VOICE_UNITS.whisper, ok: true, action: 'unsupported', detail: 'user systemd reconciliation is Linux-only' },
      kokoro: { unit: LEGACY_VOICE_UNITS.kokoro, ok: true, action: 'unsupported', detail: 'user systemd reconciliation is Linux-only' },
    };
  }
  const runSystemctl = deps.runSystemctl ?? defaultSystemctl;
  const whisper = await disableLegacyUnit(LEGACY_VOICE_UNITS.whisper, runSystemctl);
  const kokoro = deps.retireKokoro
    ? await disableLegacyUnit(LEGACY_VOICE_UNITS.kokoro, runSystemctl)
    : { unit: LEGACY_VOICE_UNITS.kokoro, ok: true, action: 'retained' as const, detail: 'retained as optional compatibility accelerator' };
  return { whisper, kokoro };
}

/** Test hook. */
export function __resetLocalVoiceProvisionForTests(): void {
  current = { running: false, whisperBinary: { done: false }, whisperModel: { done: false }, kokoro: { done: false } };
  inflight = null;
  refreshDiskOnIdle = true;
}

/** Cheap poll: the last/ongoing run's status, with the done-flags refreshed from disk so an
 *  install completed in a PREVIOUS operator process still reads done. */
export async function getLocalVoiceProvisionStatus(deps: LocalVoiceProvisionDeps = {}): Promise<LocalVoiceProvisionStatus> {
  if (current.running) return current;
  if (!refreshDiskOnIdle) return current;
  // Refresh from the durable caches (fs-only, no network).
  try {
    const hw = await (deps.detectHw ?? detectHardware)();
    const platformKey = platformKeyFor(whisperPlatformSpec(hw));
    const [bin, model, kokoro] = await Promise.all([
      findCachedWhisperBinary({ home: deps.home, platformKey }),
      resolveWhisperModel(undefined, { home: deps.home }),
      isKokoroLocalProvisioned(deps.home),
    ]);
    return {
      ...current,
      // Disk is authoritative while idle. Do not retain a stale `done:true` from a previous
      // process/run after an operator or cleanup removed the cache; that was the exact UI lie
      // that made a missing Whisper model look provisioned.
      whisperBinary: bin
        ? { done: true }
        : { done: false, blocked: current.whisperBinary.blocked ?? 'whisper binary is not provisioned' },
      whisperModel: !model.needsDownload
        ? { done: true }
        : { done: false, blocked: current.whisperModel.blocked ?? model.detail ?? 'whisper model is not provisioned' },
      kokoro: kokoro
        ? { done: true }
        : { done: false, blocked: current.kokoro.blocked ?? 'kokoro local model is not provisioned' },
    };
  } catch {
    return current;
  }
}

async function defaultWhisperBinaryLeg(home?: string): Promise<LegStatus> {
  const hw = await detectHardware();
  const r = await resolveWhisperBinary(hw, { home });
  return r.ok ? { done: true } : { done: false, blocked: r.blocked ?? 'whisper binary provisioning failed' };
}

async function defaultWhisperModelLeg(home?: string): Promise<LegStatus> {
  const plan = await resolveWhisperModel(undefined, { home });
  if (!plan.needsDownload) return { done: true };
  const dl = await downloadWhisperModel(undefined, { home });
  return dl.ok ? { done: true } : { done: false, blocked: dl.blocked ?? 'whisper model download failed' };
}

async function defaultKokoroLeg(home?: string): Promise<LegStatus> {
  const r = await provisionKokoroLocal({ home });
  return r.ok ? { done: true } : { done: false, blocked: r.blocked ?? 'kokoro provisioning failed' };
}

/**
 * Kick off (or join) the provision run. Returns immediately-known state; the caller polls
 * `getLocalVoiceProvisionStatus`. Legs run SEQUENTIALLY on purpose — three concurrent
 * multi-hundred-MB downloads on a user's link help nobody, and sequential legs give the
 * poll a readable progression.
 */
export function startLocalVoiceProvision(deps: LocalVoiceProvisionDeps = {}): { started: boolean; alreadyRunning: boolean } {
  if (inflight) return { started: false, alreadyRunning: true };
  const now = deps.now ?? (() => new Date().toISOString());
  current = {
    running: true,
    startedAt: now(),
    whisperBinary: { done: false },
    whisperModel: { done: false },
    kokoro: { done: false },
  };
  // The default legs are the production path. Reconcile the broken legacy Whisper owner before
  // downloads begin, but skip the side effect for fully injected unit tests unless they explicitly
  // supply a systemctl seam. This keeps tests hermetic while making every real install self-heal.
  const injectedLeg = Boolean(deps.provisionWhisperBinary || deps.provisionWhisperModel || deps.provisionKokoro);
  refreshDiskOnIdle = !injectedLeg;
  if (!injectedLeg || deps.runSystemctl) {
    void reconcileLegacyVoiceServices({ runSystemctl: deps.runSystemctl }).catch(() => {});
  }
  inflight = (async () => {
    const binLeg = deps.provisionWhisperBinary ?? (() => defaultWhisperBinaryLeg(deps.home));
    const modelLeg = deps.provisionWhisperModel ?? (() => defaultWhisperModelLeg(deps.home));
    const kokoroLeg = deps.provisionKokoro ?? (() => defaultKokoroLeg(deps.home));
    current.whisperBinary = await binLeg().catch((e) => ({ done: false, blocked: String(e?.message ?? e) }));
    current.whisperModel = await modelLeg().catch((e) => ({ done: false, blocked: String(e?.message ?? e) }));
    current.kokoro = await kokoroLeg().catch((e) => ({ done: false, blocked: String(e?.message ?? e) }));
    current.running = false;
    current.finishedAt = now();
    inflight = null;
    // The binary + model just landed, so bring the whisper server up NOW rather than making the
    // user's first utterance wait for a cold spawn. The STT hot path never starts it itself
    // (whisperSttBaseUrl does no I/O), so this is the lifecycle moment that must.
    if (current.whisperBinary.done && current.whisperModel.done) {
      void (deps.warmWhisper ?? warmLocalWhisper)().catch(() => {});
    }
    return current;
  })();
  return { started: true, alreadyRunning: false };
}
