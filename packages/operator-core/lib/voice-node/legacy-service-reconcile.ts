/**
 * Reconcile the user-level VoiceMode services with the operator-owned local voice lifecycle.
 *
 * VoiceMode's installer leaves two independent systemd units behind.  That is useful as a
 * developer-host compatibility layer, but it is unsafe when the units become a second owner:
 * the historical Whisper unit points at a deleted script and can consume a restart budget
 * forever, while the Kokoro unit used to install dependencies and download model files on every
 * restart.  The operator provisioner/runtime is the canonical owner (plan D-006), so this module
 * gives boot and explicit provisioning one small, injectable reconciliation seam.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** User-level units shipped by the legacy VoiceMode installer. */
export const LEGACY_VOICE_UNITS = {
  whisper: 'voicemode-whisper.service',
  kokoro: 'voicemode-kokoro.service',
} as const;

export type LegacyVoiceUnitAction =
  | 'disabled'
  | 'already-absent'
  | 'retained'
  | 'failed'
  | 'unsupported';

export interface LegacyVoiceUnitResult {
  unit: string;
  ok: boolean;
  action: LegacyVoiceUnitAction;
  detail?: string;
}

export interface LegacyVoiceReconcileResult {
  whisper: LegacyVoiceUnitResult;
  kokoro: LegacyVoiceUnitResult;
}

export interface LegacyVoiceReconcileDeps {
  /** Injectable systemctl seam; production calls are bounded to 15 seconds. */
  runSystemctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Tests can force the platform branch; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Retire the compatibility Kokoro unit too. Defaults to false. */
  retireKokoro?: boolean;
  /** Runtime-mask the broken Whisper unit after disabling it. Defaults to false for compatibility. */
  maskWhisper?: boolean;
}

async function defaultSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('systemctl', args, { timeout: 15_000 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function isAbsentUnitError(error: unknown): boolean {
  return /not found|not loaded|no such file|could not be found|not installed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function disableUnit(
  unit: string,
  runSystemctl: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  mask = false,
): Promise<LegacyVoiceUnitResult> {
  try {
    await runSystemctl(['--user', 'disable', '--now', unit]);
  } catch (error) {
    if (isAbsentUnitError(error)) {
      return { unit, ok: true, action: 'already-absent', detail: 'legacy unit is not installed' };
    }
    return {
      unit,
      ok: false,
      action: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (mask) {
    try {
      // Runtime masking prevents an old installer/desktop target from immediately re-enabling the
      // broken unit, while avoiding a permanent /dev/null file that would surprise a later
      // explicit migration. The disabled state itself remains durable across manager restarts.
      await runSystemctl(['--user', 'mask', '--runtime', unit]);
    } catch (error) {
      // Disable+stop is still the useful repair. Keep it successful but make the missing mask
      // visible to the caller so a health surface can report the weakened protection.
      return {
        unit,
        ok: true,
        action: 'disabled',
        detail:
          `disabled and stopped, but runtime mask failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      unit,
      ok: true,
      action: 'disabled',
      detail: 'disabled, stopped, and runtime-masked; operator-managed local voice is canonical',
    };
  }

  return {
    unit,
    ok: true,
    action: 'disabled',
    detail: 'disabled and stopped; operator-managed local voice is canonical',
  };
}

/**
 * Disable the broken legacy Whisper owner and optionally retire the legacy Kokoro accelerator.
 *
 * The function is intentionally best-effort and data-returning: a missing systemd user manager
 * on macOS/Windows, or a transient systemctl failure, must not make the portable in-process
 * voice provisioner report a false model failure. Callers can log `ok:false` and continue with
 * the canonical lifecycle. Repeated calls are idempotent (`disable --now` on an absent unit is a
 * successful `already-absent` result).
 */
export async function reconcileLegacyVoiceServices(
  deps: LegacyVoiceReconcileDeps = {},
): Promise<LegacyVoiceReconcileResult> {
  if ((deps.platform ?? process.platform) !== 'linux') {
    return {
      whisper: {
        unit: LEGACY_VOICE_UNITS.whisper,
        ok: true,
        action: 'unsupported',
        detail: 'user systemd reconciliation is Linux-only',
      },
      kokoro: {
        unit: LEGACY_VOICE_UNITS.kokoro,
        ok: true,
        action: 'unsupported',
        detail: 'user systemd reconciliation is Linux-only',
      },
    };
  }

  const runSystemctl = deps.runSystemctl ?? defaultSystemctl;
  const whisper = await disableUnit(LEGACY_VOICE_UNITS.whisper, runSystemctl, deps.maskWhisper ?? false);
  const kokoro = deps.retireKokoro
    ? await disableUnit(LEGACY_VOICE_UNITS.kokoro, runSystemctl)
    : {
        unit: LEGACY_VOICE_UNITS.kokoro,
        ok: true,
        action: 'retained' as const,
        detail: 'retained as an optional compatibility accelerator',
      };
  return { whisper, kokoro };
}

