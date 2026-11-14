/**
 * Env-only flag resolution: the part of getFlag()'s precedence that needs no override store and
 * no PostHog. A PURE function of an env map, so a recorded test-run configuration snapshot
 * (`@papercusp/test-config/configuration-snapshot`, whose `flagEnv` holds exactly these vars)
 * can be resolved after the fact with the SAME precedence the running process used.
 *
 * server.ts resolves its env and platform-mode overrides through `envFlagOverride` /
 * `platformModeOverride`, so this file is the single source of that precedence.
 * Plan verification-system-improvements-2026-10-10 P-011.
 */
import { FLAG_DEFAULTS, FLAGS, type FlagKey } from "./types";

export type EnvMap = Readonly<Record<string, string | undefined>>;

/** `PAPERCUSP_FLAG_<KEY>`: the key is uppercased and `-` becomes `_`. */
export function flagEnvVarName(key: string): string {
  return `PAPERCUSP_FLAG_${key.toUpperCase().replace(/-/g, "_")}`;
}

/** `PAPERCUSP_FLAG_<KEY>=1|true` turns a flag on; any other set value turns it off. */
export function envFlagOverride(key: FlagKey, env: EnvMap): boolean | undefined {
  const raw = env[flagEnvVarName(key)];
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * `PAPERCUSP_PLATFORM_MODE` forces only the platform-improvement-loops flag (per-hive-learning-loops
 * P-070 / D-006). The per-flag override above still wins over it.
 */
export function platformModeOverride(key: FlagKey, env: EnvMap): boolean | undefined {
  if (key !== FLAGS.PLATFORM_IMPROVEMENT_LOOPS) return undefined;
  const raw = env.PAPERCUSP_PLATFORM_MODE;
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  if (v === "on" || v === "1" || v === "true") return true;
  return undefined;
}

/**
 * Flags the P2P v1 release build forces OFF (p2p-v1-core-release-2026-11-13 P-001, D-001): the
 * flag-gated members of the not-in-v1 list. The release build is a process launched with
 * `PAPERCUSP_FLAG_PAPERCUSP_P2P_V1_RELEASE_BUILD=1`.
 *
 * This LOCK outranks every other source: the per-flag env override, test overrides, the
 * override store and PostHog. A not-in-v1 capability must not be re-enabled on the shipped
 * build by any toggle. The operator-core v1 scope contract test asserts this list equals the
 * flags of its not-in-v1 capability registry, in both directions.
 */
export const P2P_V1_RELEASE_BUILD_FORCED_OFF: readonly FlagKey[] = [
  FLAGS.GITHUB_BRIDGE,
  FLAGS.ACCEPT_DELEGATED_SEATS,
];

/** True when `env` launches the P2P v1 release build. */
export function isP2pV1ReleaseBuildEnv(env: EnvMap): boolean {
  return envFlagOverride(FLAGS.P2P_V1_RELEASE_BUILD, env) === true;
}

/** `false` for a flag the release build locks off; `undefined` otherwise (no opinion). */
export function releaseBuildLock(key: FlagKey, env: EnvMap): false | undefined {
  return isP2pV1ReleaseBuildEnv(env) && P2P_V1_RELEASE_BUILD_FORCED_OFF.includes(key) ? false : undefined;
}

export type EnvFlagSource = "release-build-lock" | "env" | "platform-mode" | "default" | "unknown-flag";

/**
 * Resolve a flag from env alone: the release-build lock, then the env override, then platform
 * mode, then the compiled default. An unknown key resolves to
 * `{ value: null, source: 'unknown-flag' }`, never to false.
 */
export function resolveFlagFromEnv(
  key: string,
  env: EnvMap,
): { value: boolean | null; source: EnvFlagSource } {
  if (!Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS, key)) return { value: null, source: "unknown-flag" };
  const flagKey = key as FlagKey;
  const locked = releaseBuildLock(flagKey, env);
  if (locked !== undefined) return { value: locked, source: "release-build-lock" };
  const fromEnv = envFlagOverride(flagKey, env);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const fromMode = platformModeOverride(flagKey, env);
  if (fromMode !== undefined) return { value: fromMode, source: "platform-mode" };
  return { value: FLAG_DEFAULTS[flagKey], source: "default" };
}
