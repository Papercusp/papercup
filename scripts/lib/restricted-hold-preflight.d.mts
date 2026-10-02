import type { spawnSync } from 'node:child_process';

export declare const RESTRICTED_HOLD_PREFLIGHT_MARKER: 'RESTRICTED_HOLD_PREFLIGHT';
export declare const RESTRICTED_HOLD_PREFLIGHT_EXIT: Readonly<{ admit: 0; misuse: 2; refuse: 3 }>;
export declare const RESTRICTED_HOLD_PREFLIGHT_ENV: 'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT';
export declare const RESTRICTED_HOLD_PREFLIGHT_DONE: 'admitted-by-testing-run';
export declare const RESTRICTED_HOLD_PREFLIGHT_CLI: string;

export type RestrictedHoldPreflightRefusal = { verdict: 'refuse'; error: string; hint: string };
export type RestrictedHoldPreflightResult = { verdict: 'admit' | 'skipped' } | RestrictedHoldPreflightRefusal;

export declare function interpretRestrictedHoldPreflight(result: {
  status: number | null;
  signal?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}): { verdict: 'admit' } | RestrictedHoldPreflightRefusal;

export declare function runRestrictedHoldPreflight(opts: {
  repoRoot: string;
  files: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: typeof spawnSync;
}): RestrictedHoldPreflightResult;

export declare function formatRestrictedHoldRefusal(refusal: { error: string; hint: string }): string;
