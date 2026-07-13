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

export interface LocalVoiceProvisionDeps {
  home?: string;
  now?: () => string;
  /** Leg injections for tests. */
  provisionWhisperBinary?: () => Promise<LegStatus>;
  provisionWhisperModel?: () => Promise<LegStatus>;
  provisionKokoro?: () => Promise<LegStatus>;
  /** Injected for tests; defaults to warmLocalWhisper (spawn the server once the files land). */
  warmWhisper?: () => Promise<unknown>;
}

let current: LocalVoiceProvisionStatus = {
  running: false,
  whisperBinary: { done: false },
  whisperModel: { done: false },
  kokoro: { done: false },
};
let inflight: Promise<LocalVoiceProvisionStatus> | null = null;

/** Test hook. */
export function __resetLocalVoiceProvisionForTests(): void {
  current = { running: false, whisperBinary: { done: false }, whisperModel: { done: false }, kokoro: { done: false } };
  inflight = null;
}

/** Cheap poll: the last/ongoing run's status, with the done-flags refreshed from disk so an
 *  install completed in a PREVIOUS operator process still reads done. */
export async function getLocalVoiceProvisionStatus(deps: LocalVoiceProvisionDeps = {}): Promise<LocalVoiceProvisionStatus> {
  if (current.running) return current;
  // Refresh from the durable caches (fs-only, no network).
  try {
    const hw = await detectHardware();
    const platformKey = platformKeyFor(whisperPlatformSpec(hw));
    const [bin, model, kokoro] = await Promise.all([
      findCachedWhisperBinary({ home: deps.home, platformKey }),
      resolveWhisperModel(undefined, { home: deps.home }),
      isKokoroLocalProvisioned(deps.home),
    ]);
    return {
      ...current,
      whisperBinary: bin ? { done: true } : current.whisperBinary,
      whisperModel: !model.needsDownload ? { done: true } : current.whisperModel,
      kokoro: kokoro ? { done: true } : current.kokoro,
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
